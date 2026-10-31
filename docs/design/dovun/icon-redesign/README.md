# Dovun 图标重新设计

状态：2026 年 10 月 31 日选定第二轮的乙（左块顶面开缝），已换成应用源码中的图标文件。打包、安装与部署未执行，已安装的 `/Applications/Dovun.app` 和线上站点仍是旧图标。

- [第一轮](round-01/index.html)：三个新方向 A、B、C，各配浅瓷底和青花底。
- [第二轮](round-02/index.html)：保留归栈宽缝，只把左块和中脊的顶面画出来。

两页的“现行”都指调整前的 2026-10-23 版，文件冻结在 `baseline/`，之后改动正式图标也不影响这两页。

## 第二轮：归栈宽缝立体化

反馈：归栈宽缝可以保留，问题是左侧那块的立体结构没体现出来。

左块的轮廓本来就是一个盒子：左上那一角是顶面，下面是正面，顶面右半边被中脊挡住，右下的台阶是正面伸进中脊让出的位置。中脊的顶盖同理。第二轮把这两个顶面画出来，三片轮廓直接从 `baseline/dovun-mark.svg` 读取，外轮廓、缝宽和颜色不变。

| 变体 | 处理 | 判断 |
| --- | --- | --- |
| 甲 | 左块顶面用 `#5671ad` 提亮 | 左块立体了，中脊还是平的 |
| 乙（选定） | 左块顶面与正面之间开一道 30 宽的窄缝 | 只用原有两色，单色版一致；16px 下缝看不见 |
| 丙 | 左块和中脊的顶面都提亮 | 两块深蓝光照一致，珊瑚卡片保持平的 |
| 丁 | 左块和中脊都开窄缝 | 三片变五片，小尺寸最碎 |

顶面那条边：左块从左上角出发、与底边平行；中脊从左上角连到右侧凹口内端。单色、反白和通知剪影只有一种颜色，提亮的变体在这些场合自动改用窄缝。

### 采用乙

评审稿用遮罩开缝；正式文件 `round-02/candidates/cut/master.svg` 把缝烘焙成普通路径：左块拆成顶面和正面两段，没有遮罩，生成时会和评审稿逐像素比对（1024px 下只有边缘抗锯齿差异）。该文件复制为 `docs/design/dovun/assets/dovun-mark.svg` 后，运行 `node docs/design/dovun/prototype/generate-assets.mjs --app` 重新导出，并装到 `client/src/assets`、`client/public`（favicon 与 PWA 图标）、`desktop/splash` 和 `desktop/src-tauri/icons`。Store、Android、iOS 这些当前未打包的图标由 Tauri CLI 一并重新生成，不再是旧的 W 图标。

### 通知小图标

Android 状态栏和通知头部只用小图标（`badge`）的透明度，颜色由系统着色。原来 `badge` 和大图标共用不透明的 `push-icon-192.png`，所以显示成一块圆角方。现在 `generate-assets.mjs` 另导出 `dovun-badge-96.png`：透明底上的纯白标记，按 Material 24dp 图标的 20dp 安全区放进 96px 画布中央的 80px（96px 对应 4 倍屏，见 [MDN showNotification](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification)）。`--app` 把它装为 `client/public/push-badge-96.png`，`client/offline-worker.js` 的 `badge` 改指向它；通知正文旁的大图标仍用彩色的 `push-icon-192.png`。桌面浏览器和 iOS 不使用 `badge`。

## 第一轮：三个新方向

现行图标的问题：16px 下三片分不开；三片角度不统一；macOS 26 给每个凹口、台阶和尾巴都加了高光；深色界面沿用同一个深蓝标记，与侧栏 `#1c2126` 的对比约 2:1；通知小图标 `push-icon-192.png` 是不透明整块，Android 只取透明度，显示成白色方块。

| 候选 | 构成 | 主要风险 |
| --- | --- | --- |
| A 归栈减法 | 三片同一斜度，中脊一个 45° 转折，去掉凹口和尾巴 | 容易被看成柱状图 |
| B 工作台·一张卡 | 圆角方被一道 L 形缝分成深蓝工作台和珊瑚色卡片 | 形状通用，辨识靠配色 |
| C 回纹·朱印 | 珊瑚色方印，中间刻出回纹 | 16px 下回纹只剩纹理；需查商标近似 |

每个候选按 macOS 网格画在 1024 画布中央 824 的圆角方里，配浅瓷底（`#fcfbf8`→`#eeece5`）和青花底（`#405a95`→`#2e4376`）。

## 文件

- `baseline/`：2026-10-23 版的标记、单色、反白、应用底板 SVG 和 `push-icon-192.png`，两轮“现行”的唯一来源。
- `generate-round-01.mjs`、`generate-round-02.mjs`：各轮几何与全部渲染的唯一来源。在仓库根目录用 Node 22 运行，例如 `node docs/design/dovun/icon-redesign/generate-round-02.mjs`。设 `SKIP_SYSTEM=1` 可跳过 macOS 系统渲染。
- `lib.mjs`：共用的 PNG 导出、基准渲染和 macOS 系统渲染。系统渲染把图标装进 `/tmp` 下的临时测试包，用 `NSWorkspace` 取图，之后注销并删除；“现行”也用基准文件生成测试包，不读已安装的应用。
- `review.css`、`review.js`：两轮对照页共用的样式和渲染。页面同时引用应用的 `control-tokens.css` 与 `workbench.css`，应用内的样子与实际界面一致。
- `round-0X/candidates/<id>/`：`mark.svg`（浅色界面）、`mark-dark.svg`（深色界面）、`mark-mono.svg`、`badge.svg`（白色剪影）和底板 SVG；`round-02/candidates/cut/master.svg` 是采用的正式文件。
- `round-0X/renders/`：生成的 PNG，含 `system-*.png`、`dock-*.png` 系统渲染。

## 未完成

- 新图标要随下一次打包、安装或部署才会出现在桌面应用和线上站点，需另行授权。
- 深色界面仍沿用同一个深蓝标记，与侧栏背景对比约 2:1。
- macOS 26 分层玻璃图标（`.icon` → `Assets.car`）需要完整 Xcode 的 `actool`，本机只有 Command Line Tools。
- 所有候选都没做反向搜图和商标近似检索。
