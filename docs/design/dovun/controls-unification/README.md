# 全系统控件统一

状态：2026-10-24 源码完成，浏览器验收、打包及本机覆盖安装完成；服务端完整测试有一项运行环境限制，见下文。此目录记录真实应用控件统一，不取代此前任务密度实验。

## 基准

老板随后明确选择「就默认的那套。字体改到 14px」。[approved-tokens.json](approved-tokens.json) 保存原工作台默认候选，唯一的原始参数修改是浅深两套全局字号从 13px 改为 14px。原 demo 与任务密度 demo 未修改。

浏览器工具拒绝读取本地 `file://` 页面后，未读取浏览器配置目录或绕过限制；本次依据用户新确认的默认参数实施。

运行 `node scripts/design-tokens.mjs` 生成静态 CSS，`--check` 校验是否漂移。原始参数是设计来源，生成文件负责应用语义映射，不引入运行时调参设置。深色辅助文字、链接文字为满足高光表面的 4.5:1 对比度作最小提亮；按钮填充仍使用原始品牌色。手机输入框保留 16px，避免 iOS 自动放大；正文基准与常规按钮为 14px，标题和辅助信息保留各自层级。

## 代码基线

`codex/dovun-workspace`，开始实施时为 `8c518b4`。保留现有迁移、并行运行和品牌功能，不在旧版 main 上实施。

## 开发态组件对照

启动隔离 Vite 后访问 `/controls.html`。此入口直接复用真实 UI 组件和 index.css，提供按钮尺寸/变体、输入校验、菜单嵌套、弹窗、开关、标签及反馈。

- 不加载 App、会话初始化、业务请求或数据迁移。
- 主题设置使用独立的 `dovun.controls-reference.theme`。
- 仅开发态挂载，生产构建仍以现有 index.html 为入口。
- 直接展示应用当前样式，页面本身不定义控件材质。`client/controls.html` 不属于生产构建入口。

## 覆盖清单

| 层级 | 覆盖对象 | 状态 |
| --- | --- | --- |
| 基础 | 浅深主题、语义变量、材质与状态 | 已接入并验证 |
| 通用 | button/input/textarea/select/switch/badge | 已接入并验证 |
| 浮层 | dialog/popover/dropdown/context-menu/tooltip/toast | 已接入并验证 |
| 核心 | 今天、清单、详情、规划、资料库、助手 | 已接入并验证 |
| 积累 | 工作上下文、回顾、待确认 | 已接入并验证 |
| 工具 | 技能、连接、执行、Worktree | 已统一，共用组件及页面检查通过 |
| 通用页面 | 统计、专注、设置、搜索、历史、回收站、登录 | 已统一，共用组件及页面检查通过 |

## 保持的行为

沿用现有页面布局与控件尺寸档位；不执行任务单行化、标签缩写或高度调整。保留 Portal、焦点、编辑器挂载、中文输入、草稿、自动保存与拖动行为。用户正文、HTML/SVG、图表内容颜色不做批量重写。

## 验收与发布

隔离数据、目录和端口验证。覆盖中英文、浅深/系统主题、桌面与 390px、Chromium/WebKit。记录视觉截图、页面清单、功能与测试结果。源码交付阶段不打安装包、不覆盖安装、不部署；用户随后追加授权的本机安装见下方记录。


## 验收结果

- [实际页面对照](index.html)：浅深色、桌面与手机；共 38 张真实截图，使用隔离数据。中英文 README 已更新到本轮截图。
- Chromium、手机 Chromium 和 WebKit：32 个路由 × 浅深色 × 1586/390px，无整页横向溢出。包含设置的七个分类；登录页面另外验证。英文核心页覆盖 1440/390px、浅深色。
- 真实组件在 1586、1440、1280、1024、390px 验证；输入/按钮/卡片阴影层次、焦点、嵌套菜单键盘操作、系统主题和减少动态效果均通过。标准正文、辅助文字、链接与卡片/输入/浮层背景及高光边缘的对比度检查通过。
- 前端完整单元测试：62 个文件、367 项通过。
- 服务端完整单元测试：95 个文件、831 项通过、1 项未通过。未通过项为 `desktop data import > imports a full verified workspace, repeats safely and refuses conflicting new data`：旧 WWA 服务正在监听 47316，迁移 CLI 的停止服务保护拒绝运行。测试数据是临时目录，没有关闭 WWA，也没有修改保护逻辑。
- 核心 E2E：99 个用例初次结果为 94 通过、3 个既有跳过、2 个边距回归失败。恢复原 24px 弹窗边距后，相关控件、弹窗与资料编辑 17 项全部复测通过；新增/扩展的全站与登录专项 12 项全部通过。失败项已复测消除。不能将上述不同批次数字直接相加当作独立用例数。
- 核心功能覆盖自动保存、中文输入、跨页草稿、正文滚动、安排时间、拖动与撤销、助手同一会话/流式回复、资料草稿及待确认审批；没有模型的页面浏览与任务记录也验证。
- 语言检查、设计变量漂移检查、diff 检查、完整前后端构建通过。应用功能知识已在构建前更新并提交。

可重放命令（Node 22；测试端口 3028/5189，模型桩端口 4010）：

```sh
node scripts/design-tokens.mjs --check
npm run i18n:check
npm test
npm run test -w client
E2E_API_PORT=3028 E2E_UI_PORT=5189 E2E_DATABASE_FILE=dovun-controls.db npx playwright test e2e/control-surfaces.spec.ts --project=chromium --project=mobile --project=webkit-controls
npm run build
```

完整测试的运行保护限制应保留到对应环境空闲后再重跑，不通过关闭用户应用来消除。

## 剩余差异与发布状态

- 原始参数完整保留。应用保留既有尺寸档位、字号层级和页面布局；不把所有面板强制成示例卡片的内边距。浅深色辅助文字与链接作对比度适配；手机输入框保留 16px。
- WebKit 全站报告记录了 ResizeObserver 的单次投递通知（含对应路由），未发现持续布局循环或溢出；没有吞掉通知或修改图表逻辑。
- 构建仍提示部分 JS 分包超过 500kB；本轮未做无关的依赖拆分。
- 已按后续授权生成 macOS 包并覆盖本机 Dovun。未自动打开已安装应用；原生窗口交互、Windows 实机和服务器部署仍未验收。Vite 开发态真实控件页可运行，生产构建不包含此入口。
- CI 与 Dockerfile 未修改。现有 WWA/Dovun 数据、同步和自动化开关均未操作。

[结构化检查记录](verification.json) 与 [全站 Chromium](evidence/route-audit-chromium.json)、[手机](evidence/route-audit-mobile.json)、[WebKit](evidence/route-audit-webkit-controls.json) 保留具体范围及浏览器通知。

## 本机覆盖安装（2026-10-24）

用户追加授权「打包覆盖安装本机的 Dovun」。已构建源码 `77ae4c3`，版本仍为 `0.4.0`，标识 `app.dovun.desktop`，本机端口仍为 47317。

- 桌面构建日志确认 `Finished 2 bundles`、`EXIT:0`；DMG 为 `desktop/src-tauri/target/release/bundle/dmg/Dovun_0.4.0_aarch64.dmg`。
- 打包资源在隔离临时目录通过本机模式、重启数据保留、MCP 恢复和服务器模式冒烟；未对真实工作台执行测试写入。
- 正常退出 Dovun 并确认 47317 释放后，备份数据库、浏览器偏好和旧应用；仅删除并重新复制 `/Applications/Dovun.app`。安装前后数据库与已有 sidecar 的大小/SHA256 一致，备份库 quick_check 为 ok。真实数据及备份细节仅保存于用户本机私有安装记录，不进入仓库。
- 安装包 15386 个文件/链接与构建包逐项一致，签名验证通过。新包内 JS `index-BPE84ZPP.js`、CSS `index-CDSIfqBO.css` 与本次前端构建一致。
- 已移除构建目录的 Dovun.app，保留 DMG。已安装的 Dovun 保持关闭；WWA、数据绑定和自动化开关未操作；未部署。

构建、冒烟、安装日志分别为 `/tmp/dovun-controls-desktop-build.log`、`/tmp/dovun-controls-desktop-smoke.log`、`/tmp/dovun-controls-install.log`。

## 2026-10-24 公共控件补齐

后续实际截图发现：此前“已接入并验证”的覆盖表过于宽泛，设置底栏开关、资料库及工作上下文局部样式、助手引用与工具记录仍有独立实现。旧巡检主要证明页面可渲染、字号正确与不溢出，没有证明每个控件均复用了公共组件。

本轮按组件类别补齐，并加入源码边界和实际材质检查；具体范围、保留边界与新截图见 [公共控件补齐记录](../control-reuse/README.md)。先前截图和构建记录保留其历史状态，不代表本轮已重新安装。
