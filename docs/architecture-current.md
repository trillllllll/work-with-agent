# Dovun 当前架构

Dovun 是个人工作台：任务以清单组织，资料保留原始材料，记忆保留确认后的事实和经验，AI 围绕当前工作协助并遵守审批边界。日常入口是今天和规划，不引入另一个工作台首页或项目模型。

React 客户端复用任务、规划、资料、上下文和助手组件。共享导航配置驱动桌面、规划和手机更多页。语义颜色在 `client/src/index.css`，工作台表面和响应布局在 `client/src/styles/workbench.css`；浅深色使用同一组件树。聊天只有一个消息流，任务正文编辑器在右栏页签、展开和助手切换时保留挂载。

Express API 与 MCP 复用应用层权限和操作逻辑，SQLite/Prisma 保存业务数据。REST 路径、MCP 工具名、对象 ID 和业务表结构不随品牌改名改变。桌面 Tauri 包装 Node API/执行端与同一客户端；远程模式加载实际服务器页面。无模型时任务、安排与资料仍可操作，助手明确显示配置入口。

0.3.0 启动链先准备数据目录和启动器，再选择本机或远程模式。新旧配置解析集中于 `server/src/shared/runtime-env.ts`；目录迁移位于 `server/src/desktop-migrate.ts`，独立 SQLite 互斥与进程生命周期租约位于 `shared/data-guard.ts`。浏览器入口先迁移偏好和作用域草稿，再挂载应用。失败可见且保留原状态。细节与限制见 [迁移手册](dovun-migration.md)。

[旧架构基线](architecture-baseline.md)保留当时的规划，不代表当前全部功能。当前界面证据见 [实际应用改造](design/dovun/implementation/README.md)，领域词义见 [CONTEXT.md](../CONTEXT.md)。

0.4.0 分支使用新系统标识，先恢复原生 profile 再创建 WebView；运行兼容已退出，历史数据导入保留。见 [新身份迁移](dovun-04-handoff.md)。
