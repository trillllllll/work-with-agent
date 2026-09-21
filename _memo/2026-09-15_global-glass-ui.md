---
createAt: 2026-09-15
updateAt: 2026-09-15
summary: 全局 Apple 风格轻盈玻璃视觉系统改版及验证记录
tags: [glassmorphism, ui, react, tailwind, responsive, e2e]
---

# 2026-09-15 全局玻璃化 UI 改版

## 核心结论

- 产品采用轻透 Apple 风格玻璃质感，亮色使用白色玻璃，暗色使用烟灰玻璃。
- 视觉改版覆盖侧栏、主题列表、看板列与任务卡片、聊天栏/消息、移动底部导航、工作区模态、表单/确认弹窗、下拉菜单和状态反馈。
- 保持现有业务逻辑、API、Hash 路由、数据流、信息密度和操作文案不变；桌面仍为左侧栏 + 看板 + 右侧聊天，移动端仍为页面内容 + 底部导航。

## 关键实现

- `client/src/index.css` 增加玻璃语义令牌和工具类：`glass-surface`、`glass-subtle`、`glass-control`、`glass-divider`、`glass-scrollbar`，并加入安全区/减少动画支持。
- `DialogContent` 增加 `surface="glass"` 可选参数；普通 Dialog 默认行为不变。
- `WorkspaceModal` 保持宽屏浮层（约 `78vw`、最大 `1120px`、约 `80dvh`），顶部标题 + 胶囊页签 + 单滚动内容区。
- 表单输入、下拉菜单、按钮、Badge、Skeleton、Toast 统一引用玻璃令牌。
- 看板、聊天、主题列表和移动导航改为低对比半透明层；保留蓝色主色但避免大面积高饱和块。

## 验证结果

- `npm run build` 通过。
- `npm test` 通过：server 23 个测试、client 2 个测试。
- Playwright 核心桌面流程和移动响应式流程通过；完整 E2E 首次运行曾因测试服务残留导致数据库隔离问题，清理 3001 端口后相关场景单独重跑通过。
- 本地启动：根目录执行 `npm run dev`，前端 `http://127.0.0.1:5173/`，后端 API `http://127.0.0.1:3001/`。

## Git

- 全局视觉改版提交：`9cf2d77 (style): 统一全局轻盈玻璃视觉系统`。
- 已推送到 `origin/main`。
- `_memo/` 为本地项目记忆目录，默认不纳入功能提交。

## 相关文件

- `client/src/index.css`
- `client/src/components/workspace/WorkspaceModal.tsx`
- `client/src/components/ui/dialog.tsx`
- `client/src/components/layout/AppShell.tsx`
- `client/src/components/board/BoardColumn.tsx`
- `client/src/components/chat/ChatPanel.tsx`
