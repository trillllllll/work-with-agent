# 学习助手联网能力选型调研

日期：2026-10-27。目标：给学习助手（study 身份）增加联网能力，提升学习资料的实时性、以及引用官方文档的准确性。本文对比可选的搜索 API 与网页抓取方案，给出推荐组合与落地接入点。价格为调研当日数据，落地前需复核。

## 1. 结论

**搜索与网页抓取都选 DeepSeek tools API 做一期默认实现，provider 做成可插拔，Tavily / 智谱作为备选实现；自建正文提取（readability）作为无 key 时的抓取兜底。**

理由：

1. DeepSeek 一对端点同时覆盖 `web_search` 和 `read_webpage` 两个工具：search 返回带相关度/权威度评分的结构化结果，fetch 直接返回 markdown 正文——**绕开了本仓库"没有 HTML 正文提取依赖"这个最大缺口**。
2. 成本最低（$0.75/千次成功请求，失败不计费），国内直连可达，普通 DeepSeek key 即可，不引入新账号体系。
3. 它是独立 REST 端点而非 chat 内置工具，不影响现有"OpenAI 兼容、provider 无关"的模型接入架构。
4. 返回字段与目标契合：`authority` 支撑"官方文档优先"策略，query 支持 `site:` 操作符可定向搜官方域。
5. 风险：该搜索引擎 2026-10 才上线，英文文档索引质量未经大规模验证。**2026-11-01 前计费免费，建议在免费窗口内用真实学习查询批测后再最终定版**；不满意则切换 Tavily 默认。

## 2. 架构现状（调研时点）

- 模型接入：`server/src/agent.ts` 裸 fetch 调 OpenAI 兼容 `/chat/completions`，SSE 流式 + function calling，provider 无关；baseUrl/apiKey/model 存 SQLite `appSetting`，非 work 身份可按身份覆盖（`application/settings.ts`）。
- 工具体系：定义在 `server/src/agent/capabilities.ts`（`builtinTools`），按组授权在 `server/src/agent/tool-loading.ts`，执行分发在 `server/src/agent/builtin-tools.ts`，执行循环在 `server/src/agent/runs.ts`（16 轮预算，`MODEL_TIMEOUT_MS` 90s）。身份注册在 `server/src/agent/identities.ts`：study 的 `allowedGroups` 已含 `external` 组（当前只有 `prepare_external_prompt` 一个工具），且 `initialToolGroups` 对"联网|网页搜索"话题已有预加载路由。
- 可复用安全基建：`server/src/infrastructure/controlled-execution.ts` 的 `assertSafeTarget`（协议白名单、私网/metadata 段拒绝、DNS 解析后二次校验、IPv4-mapped IPv6 处理）+ `ControlledExecutionAdapter.http`（超时、大小上限、`redirect:'error'`、输出脱敏）。
- 可复用接入模板：`server/src/agent/image-search.ts`（Brave 图片搜索：undici ProxyAgent + `BRAVE_IMAGE_SEARCH_PROXY_URL` 代理环境变量、12s 超时、512KB 响应上限、结果 URL https 校验）；密钥配置模式见 `application/image-search-settings.ts`（环境变量优先 + DB 兜底）。
- 网络出口：全部由 Node server 发起。桌面形态 Tauri 壳零网络权限（`desktop/src-tauri/capabilities/default.json` 仅 window-state）；远程形态抓取发生在服务器侧。
- 关键缺口：仓库无 HTML→正文提取依赖（无 readability/cheerio/jsdom；`routes/knowledge.ts` 的资料抓取存的是 raw HTML）。

## 3. 搜索后端对比

| 方案 | 价格 | 免费额度 | 国内可达 | 返回特征 | 集成成本 |
| --- | --- | --- | --- | --- | --- |
| **DeepSeek tools/search**（推荐） | $0.75/千次成功请求，失败/空结果不计费；2026-11-01 起计费，此前免费 | 计费前免费窗口 | ✅（实测） | title/url/snippet(100-200字)/summary(600-800字)/date；`rerank_score` 0–3（≥1.5 高质量）、`authority` 0–4（≥3 权威）；query 支持 `site:`/`-site:`/`"..."`/`lang:zh,en`/`after:`/`before:`，count 1–50 | 低，REST POST + bearer，照抄 image-search 模式 |
| Tavily | ~$0.008/credit | 1000 credits/月（basic 1 credit/次，advanced 2） | ✅ 端点（实测），质量经社区验证 | 面向 agent，可带正文摘要；另有 Extract API | 低 |
| 智谱 web_search | search_std ~0.01 元/次，search_pro ~0.03 元/次 | 新用户少量赠送 | ✅（实测端点存在，无 key 返回标准 401） | title/url/摘要，为 LLM 优化 | 低；若模型本就是 GLM 可复用同一 key |
| Serper | $0.3–1/千次 | 2500 次（一次性） | ✅ 端点（实测，Cloudflare） | 原生 Google SERP，英文质量最好 | 低 |
| Brave Search API | Search $5/千次；2026 改版后无免费层，每月 $5 赠金 ≈1000 次 | 赠金用完即付费 | ✅ 端点（实测） | 独立索引，质量好 | 最低（与现有图片搜索同厂家、同密钥/代理代码） |

**排除项及原因**：

- **Bing Search API**：2025-08-11 已退役；替代品 Azure "Grounding with Bing" 贵 40–483%。
- **Google Programmable Search Engine**：免费仅 100 次/天，需自建引擎配置，个人场景不值。
- **SearXNG 自托管**：上游引擎在大陆 VPS 仍被墙（需配代理或退化为 Baidu/Bing 源），运维成本对低频个人应用不划算。
- **GLM 内置 `tools:[{type:"web_search"}]`**（及各家模型内置搜索）：锁死 provider，`ModelAdapter` 需为该工具类型特判协议，破坏 provider 无关架构。
- **DuckDuckGo 抓取等非官方途径**：违反 ToS，不稳定。

选型要点：英文官方文档检索质量上，原生 Google SERP（Serper）最稳，Tavily 次之；DeepSeek 与智谱的自建索引对英文站点的覆盖尚未充分验证——这是免费窗口批测要回答的核心问题。

## 4. 网页抓取 / 读取对比

| 方案 | 价格 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **DeepSeek tools/fetch**（推荐） | $0.75/千次成功请求 | 直接返回 `{title, content: markdown}`，无需本地提取依赖；由 DeepSeek 服务器代抓，绕开本地网络限制 | 依赖外部服务；403=目标站安全策略拒绝、404=无可提取正文；url ≤8192 字符 |
| 自建：readability + linkedom | 0（新增两个 npm 依赖） | 无外部服务、无次数限制、离线可用；与 `assertSafeTarget` 组合可控性最强 | JS 渲染页面抓不到；VPS 形态下抓被墙站点（Google 系文档等）不通；需处理截断/分页 |
| Jina Reader（r.jina.ai） | 无 key ~20 RPM；key 免费额度社区数据约 1M tokens | 返回干净 markdown，支持 PDF | **国内直连不稳定（实测 TLS 握手被重置），必须配代理**；价格数据未经官方核实 |
| Tavily Extract | 1 credit/5 URL | 与搜索同 key | 一期可不做 |

推荐组合：`read_webpage` 工具默认走 DeepSeek fetch（配了 DeepSeek key 时），未配 key 或请求失败时回落自建 readability 提取。JS 渲染页面两条路都抓不到，属于已知边界，不做 headless 浏览器（成本不成比例）。

## 5. 实测记录（2026-10-27，本机 macOS）

方法：DoH（`1.1.1.1/dns-query`）取真实 IP + `curl --resolve` + `--noproxy '*'`，绕过系统代理与 Clash fake-ip DNS（系统 DNS 返回 198.18.x）。**注意：本机流量实际仍经 Clash TUN 分流，本结果代表"桌面形态"，不代表大陆 VPS 直连。**

| 域名 | 结果 |
| --- | --- |
| api.search.brave.com | 301（可达） |
| api.tavily.com | 200 |
| serper.dev | 200 |
| r.jina.ai | 200；但二次实测请求真实页面时 TLS 握手被重置（`SSL_ERROR_SYSCALL`），直连判定为不稳定 |
| open.bigmodel.cn | 200 |
| api.deepseek.com | 401（无 key，可达）；`/v1/tools/search`、`/v1/tools/fetch` 路径存在（官方文档确认） |
| www.google.com / html.duckduckgo.com | 302（经分流可达） |

**待验证（上线服务器形态前）**：在 VPS 上用同一组探测命令实测 `api.deepseek.com`、`api.tavily.com`、`api.search.brave.com` 直连可达性。智谱端点可确认国内可达，DeepSeek 为国内公司主体、风险低，但端点走境外 CDN，仍以实测为准。

## 6. 风险与对冲

| 风险 | 对冲 |
| --- | --- |
| DeepSeek 新引擎英文文档质量未验证 | 2026-11-01 前免费批测；provider 可插拔，随时切 Tavily |
| agent 失控多轮搜索烧钱（run 循环 16 轮，每轮可触发工具） | 每 run 搜索/抓取次数上限（建议各 4 次），超限返回提示性错误；计费按成功请求、失败不计费本身也是缓冲 |
| 抓取结果撑爆上下文 / 消息表（工具结果整体进 `modelMessagesJson`） | 沿用 `library_read` 的 cursor 分页模式 + 大小上限（参照 image-search 512KB）；fetch 返回的 markdown 同样要截断分页 |
| SSRF | 必须复用 `assertSafeTarget`；保持 `redirect:'error'`（重定向目标不过安全检查，现有代码即如此） |
| 大陆 VPS 直连被墙站点 | 搜索/抓取走 API 代抓（DeepSeek/Tavily 均服务端代抓）；自建提取路径配代理环境变量（沿用 `BRAVE_IMAGE_SEARCH_PROXY_URL` 模式） |
| 提示词自相矛盾 | `capabilities.ts` 两份 behavior prompt 的【能力边界】硬编码"不能联网搜索、读取网页"（study L252-255、work L176-179）必须同步改写；`prepare_external_prompt` 定位措辞一并调整 |
| 发版合规 | 按 AGENTS.md，发版前同步 `server/src/agent/app-knowledge.ts` 功能手册并提交 |

## 7. 一期落地接入点清单

1. `server/src/agent/capabilities.ts`：`builtinTools` 增加 `web_search`、`read_webpage`（`writesBusinessData: false`，照抄 `image_search` 写法）。
2. 新建 `server/src/agent/web-search.ts`：provider 接口 + DeepSeek 实现（search/fetch 两端点），结构仿 `image-search.ts`（超时、大小上限、代理 env、密钥 env 优先 + DB 兜底）。SSRF 走 `assertSafeTarget`（fetch 自建回落路径必须；DeepSeek 代抓路径自身无 SSRF 面，但仍校验入参 URL）。
3. `server/src/agent/tool-loading.ts`：新建 `web` 工具组并授予 study（若希望 work 同享则放 `external` 组）——产品决策点。
4. `server/src/agent/builtin-tools.ts`：`executeBuiltinTool` 加两个分支；per-run 次数计数在 run cursor 上累积。
5. `server/src/agent/capabilities.ts`：改写两份【能力边界】；提示词加检索策略（官方域优先、`site:` 操作符、引用带 URL+访问日期、优先 `authority`≥3 来源）。
6. `application/` 仿 `image-search-settings.ts` 增加 DeepSeek key 配置 + 设置页 UI。
7. 发版前更新 `app-knowledge.ts` 手册。

**明确不做（一期）**：抓取内容落库（学习域 8 个 action 无"存资料"，资料属 library 域会被 study 的 `FAMILY_NOT_ALLOWED` 拦截；引用只在回复正文中带出）；前端来源卡片（`assistant-sources.ts` 需新增网页来源 kind，放二期）；headless 渲染；Jina Reader（仅当用户主动配代理时可作为可选项）。

## 8. 信息来源

- DeepSeek Search & Fetch API：https://api-docs.deepseek.com/guides/search
- Tavily 限流与计费：https://docs.tavily.com/documentation/rate-limits
- Brave 2026 新定价公告：https://x.com/brave/status/2023404757264867432 ；快速入门：https://api-dashboard.search.brave.com/documentation/quickstart
- Bing Search API 退役公告：https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- 各搜索 API 2026 对比：https://www.beri.net/article/tavily-vs-exa-vs-brave-vs-perplexity-search-api-agent-cost-2026
- 智谱联网搜索文档：https://docs.bigmodel.cn/cn/guide/tools/web-search ；定价：https://open.bigmodel.cn/online-book/price
- Serper 定价：https://serper.dev
- SearXNG 国内自托管讨论：https://github.com/apecloud/ApeRAG/issues/1800
