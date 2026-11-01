# 测试与合并检查

2026-11-01，本轮只完成代码、测试、复核及本地合并；不推送、打包、安装或部署。合并目标为 `main@4ec6407`，最终产品代码为 `0dfb9edc391b3f81b900cccf22fe0aedc325e513`（主体前端 `f126366`，后端提交 `a150c35`，测试入口修正 `1e8982f`）。

以下记录修正后的最终结果，不声称首轮全部通过。

| 检查 | 结果 | 本机证据 |
| --- | --- | --- |
| 全量服务端 | 125 文件 / 1080 项通过 | `/tmp/dovun-learning-assistant-unit-review.log` |
| 全量客户端 | 96 文件 / 586 项通过；恢复保护补充后再验仍全部通过 | `/tmp/dovun-learning-assistant-client-final.log` |
| 新专项浏览器 | 桌面 Chromium、Pixel 7 模拟、iPhone 13 WebKit 模拟，共 15 项通过；最终产品提交再次重放 15/15，0 跳过、0 重试、0 失败 | `/tmp/dovun-learning-assistant-e2e-final.log` |
| 原学习流程浏览器回归 | 63 项首轮 59 通过 / 4 失败；修正空态重复标题后，受影响三端 6/6 通过（含 2 条重复验证）。63 个唯一场景均有通过证据 | `/tmp/dovun-learning-assistant-workflow-regression.log`、`/tmp/dovun-learning-assistant-workflow-corrected.log` |
| 前后端生产构建 | 通过 | `/tmp/dovun-learning-assistant-build-final.log` |
| 中英文文案检查 | 通过 | `/tmp/dovun-learning-assistant-i18n.log` |
| 设计 token / 公共控件复用检查 | 通过 | `/tmp/dovun-learning-assistant-controls.log` |
| 独立代码复核 | **Approve**，无剩余阻断；再次核对受检产品提交 `0dfb9ed` | 本轮独立复核记录 |
| Git 空白与补丁检查 | `git diff --check` 通过 | Git |

## 复核后修正

- 主题选择等待网络时，旧响应不得覆盖新主题、工作助手或新发送；旧无绑定会话恢复时清空主题展示。
- 主图结构指纹包含归属、名称与顺序，并纳入审批前置条件。状态变化不误报过期，审批期间结构变化拒绝旧方案。
- 学习档案接入主图与助手主题定位；档案浏览不改绑历史对话。
- 重复卡片、档案及浏览器标签共享编辑互斥；进行中的 I/O 结束前不交接恢复记录。历史已采用卡片默认收起。
- IndexedDB 中的采用、会话操作及答案恢复结束前禁止新写入；恢复失败保留状态并可重读。延迟恢复测试检查实际发送仍沿用原请求 ID。
- 空态欢迎标题改为“想学什么？”，与面板的助手身份标题区分；保留原身份断言，受影响三端用例复测通过。
- 主图路径、圆形和直接标记元素由应用着色；固定相同 HTML 对象，避免父组件重绘移除状态属性。主图关闭不抢用户已经移到输入框的焦点。

## 测试环境与范围

单元测试入口为每次运行创建独立 `/tmp/dovun-unit-*` 数据库；成功后清理本次临时目录，不再复用仓库下的固定测试库。两个原有合同测试的 `/tmp` 保护保持有效。既有外部提示词断言现在允许非卡片的引用元数据；完成时间测试使用受控日期，继续严格检查完成时间不被改名覆盖。

浏览器使用专用配置，数据库仅为本工作区 `e2e/.data/learning-workflow.db`，运行时、文件和 runner 目录也位于同一隔离前缀。每次启动拒绝复用现有服务；模型传输为确定性 fixture，练习生成、作答、判题、API、SQLite 和 worker 为真实应用链路。截图、追踪及 JSON 报告位于忽略目录 `test-results/learning-assistant/`、`test-results/learning-workflow/`。

未读取真实模型凭据，未操作用户业务数据库、账号配对或已安装应用。真实模型的教学质量、实体手机中文键盘/系统返回、实际登录跨端与线上服务仍不在本轮验收结论内。
