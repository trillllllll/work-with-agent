# Dovun A/B 实际应用改造

A 的瓷白浅色与 B 的石墨深色共用一套布局，已进入真实 React 应用。旧 HTML 样板保留作历史记录，不再作为视觉验收入口。

## 当前实现

- 分层表面：环境底板、主工作区、任务/详情、输入/浮层；主题变量在 `client/src/index.css`，工作台组件规则在 `client/src/styles/workbench.css`。
- 桌面侧栏/工作区/右栏；1440px 起 260/440px，1280px 档 232/384px，1024px 档使用图标侧栏，手机保留底栏。
- 今天默认提供紧凑助手；任务详情、相关资料、工作上下文在同一右栏切换。正文编辑器保持挂载，聊天复用原会话实例。
- 新安装进入今天。今天快速新增归入收集箱并设置今天日期；不带入上一次选择的清单。手机默认今天、规划、清单、资料库；已保存的配置继续使用。
- Dovun 宽缝图形用于应用、侧栏、启动页和 favicon。系统应用标识暂保持旧值。

## 实际截图

使用隔离数据库、真实组件与接口；未配置模型时明确显示配置入口。没有生成模拟 AI 回复。

| 页面 | 浅色 | 深色 |
| --- | --- | --- |
| 今天与详情 | [浅色](evidence/today-light.png) | [深色](evidence/today-dark.png) |
| 规划 | [浅色](evidence/plan-light.png) | [深色](evidence/plan-dark.png) |
| 资料库 | [浅色](evidence/library-light.png) | [深色](evidence/library-dark.png) |
| 工作上下文 | [浅色](evidence/knowledge-light.png) | [深色](evidence/knowledge-dark.png) |
| 设置 | [浅色](evidence/settings-light.png) | [深色](evidence/settings-dark.png) |
| 手机 390px | [浅色](evidence/today-390-light.png) | [深色](evidence/today-390-dark.png) |

1586×992、1440、1280、1024、390px 的上述截图检查未发现整页横向溢出或页面异常。真实 E2E 继续验收业务行为，截图不代替测试通过。

## 验证与交付

真实截图涵盖中英文、浅深色、1586×992 与 1440/1280/1024/390px；未发现整页横向溢出或 pageerror。今天、规划、资料、工作上下文和设置均来自实际组件及接口。可直接打开 [截图对照页](index.html)。

0.3.0 过渡版在 `codex/dovun-0.3` 保留完整兼容；0.4.0 使用新应用身份，移除运行兼容并保留历史数据/内容导入。App/DMG 均已构建，打包运行时冒烟通过；两个版本的默认文件名与身份分别核对，主 JS/CSS 与对应构建逐字节一致。

测试数量、迁移摘要、候选包校验和剩余平台限制见 [交付记录](delivery.md)、[目录迁移证据](migration-evidence.json)和[候选包校验](candidates.json)。未安装、部署、改仓库或切域名。Windows WebView2 仍需原生升级验收；不能把 WebKit 隔离测试当作 Windows 验收。
