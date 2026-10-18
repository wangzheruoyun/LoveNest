# 爱之巢 / Love Nest Demo V1.52 → Android 移植 · 设计文档

日期：2026-10-18
状态：已定稿（人类伙伴已在对话中逐项拍板）

## 1. 意图

让《爱之巢 / Love Nest》Demo V1.52（2025-01-15 由 GameCreator 导出的 NW.js Windows 桌面构建）在安卓手机上**离线、全屏、用手指**运行。剧情、Live2D、配音以及所有"打破第四面墙"的 Meta 演出都要原味保留。

仅个人自用。不分发游戏资源。

## 2. 已侦察确认的事实（均经实测，非推测）

### 2.1 游戏本体
- 构建形态：NW.js（node-webkit）桌面应用。`package.json` 声明 `main: index.html`、`nodejs: true`、窗口 1600×900。
- 渲染内核：**LayaAir**（源码中 `Laya` 出现 611 次）+ GameCreator 封装。
- `index.html` 仅有 21 行：加载 `script.js?r=...`，然后调用全局 `main()`。
- 资源：1913 个文件，约 480MB 可用资源（image 190M、audio 187M、font 77M ttf、json 6.6M、video 312K）。其余约 250MB 是 NW.js 运行时（`nw.dll` 等），移植时不需要。
- 音频格式：ogg ×1066、mp3 ×87；图片 png ×496、jpg ×70。
- 输入：几乎只有 `keyCode 13`（Enter）+ 鼠标（58 处 mousedown）。

### 2.2 script.js 的加密结构
- 9.5MB，GameCreator "JS加密"：先是约 73KB 的字符串字典（`var x=String.fromCharCode(...)`），随后 **546 处 `eval()`** 把真正的引擎源码分片重组。
- **实测：在最裸的 JS 环境（Node `vm`）中可完整解码并运行到底，零报错，解码阶段不依赖任何 Node 或浏览器 API。**
- ⇒ 结论：**`script.js` 必须原封不动地使用，解密不是必要条件。**

### 2.3 平台判定机制（决定整个架构）
`script.js` 中的原始逻辑：

```js
var gcTop = top.top;
var gcParent = parent;
try { top.document.domain } catch (e) { gcTop = gcParent = window; }

if (typeof gcTop != "undefined" && typeof gcTop.require != "undefined") {
    os._gui = gcTop.require('nw.gui');
    os._win = os._gui.Window.get();
}

if (typeof gcTop.require != "undefined" &&
    (window.location.href.indexOf("chrome") == 0 || window.location.href.indexOf("file") == 0)) {
    os.platform = 2;      // PC / nw.js
}
else if (window.location.href.indexOf("gamecreator.com.cn") != -1 || ...) {
    os.platform = 0;      // 网页版
}
else if (os.detectOS() == "Android" && typeof cordova !== 'undefined') {
    os.platform = 4;      // 安卓（Cordova）
}
else {
    os.platform = 3;      // 其他
}
```

关键推论：
1. 在 nw.js 中主页面即顶层，故 `gcTop === window`，而 `window.require` 由 nw.js 的 node 集成注入。**⇒ 我方只需定义 `window.require` 与 `window.process`，即等价复刻 nw.js 渲染进程环境。**
2. 桌面版运行在 **platform 2**。
3. Meta 演出与文件系统权限都挂在 platform 2 上：
   - `FileUtils.hasFileOperationJurisdiction` = `Config.IS_SERVER || os.platform == 2 || ...`
   - `W26_DesktopWallpaper`、`wmic`/`nircmd` 调用等全部位于 `os.platform == 2` 分支。
4. 若页面由 `http://127.0.0.1` 提供，`href` 既不以 `file` 也不以 `chrome` 开头 ⇒ 落入 **platform 3** ⇒ **Meta 演出全部失效、存档改走 IndexedDB**。

### 2.4 需要打桩的完整依赖面
| 调用 | 规模 | 用途 |
|---|---|---|
| `require('nw.gui')` | 7 处 | `nw.Window.get()`、`nw.Clipboard.get()`、`nw.Shell.openItem()` |
| `require('child_process')` | 5 处，exec/execSync/spawn 共 17 次调用 | `chcp 936 && wmic os get Caption`（Windows 版本）、`wmic useraccount`（真实用户名）、nircmd 托盘气泡、nircmd 关机 |
| `require('fs')` | 4 处，读写调用点约 83 处 | 存档、读本地图片、桌面壁纸相关 |
| `require('os')` | 3 处 | `os.homedir()` |
| `require('path')` | 2 处 | `path.join` |
| `require('process')` | 1 处 | 环境探测 |
| `process.*` | 36 处 | `memoryUsage`/`argv`/`env`/`versions`/`cwd`/`exec`/`on` |
| `W26_DesktopWallpaper` | 类 | 改 Windows 桌面壁纸 |
| 疑似外壳全局 | — | `loader`、`Handler`、`readFile`、`nativePath`（`FileUtils.init` 的备用分支会 `eval("readFile")` / `eval("nativePath")`） |

存档路径原始逻辑：`path.join(os.homedir(), 'Documents', WorldData.w26_traceControl_gameName, dirname)`。

### 2.5 与安卓相关但不可用的部分
- 引擎自带的 Cordova 分支（`os.platform = 4`）提供：`window.plugins.insomnia.keepAwake()`（常亮）、`AndroidFullScreen.immersiveMode()`（沉浸全屏）、`navigator.vibrate` 震动、`screen.orientation.lock('landscape')`、`document` 的 `pause`/`resume` 事件（用于音频暂停/恢复）。
  - 这些在 platform 2 下都不会触发，**改由 Kotlin 侧原生实现**（沉浸全屏、常亮、横屏锁定、生命周期派发合成事件）。
- `asset/json/startup.json` 是**带密码的加密 zip**（内部同样名为 `startup.json`），仅由引擎运行时解密。
  ⇒ 能跑，但剧情数据无法离线读写；任何剧情改动都不在范围内。
- 另有 `greenworks/`（Steamworks：`steam_api64.dll`）与 `pcSys/`（`nircmd.exe`、`nircmdc.exe`、`trayballoon.exe`、`正在关机.mp4`），全部为 Windows 专用。

### 2.6 目标设备（已确认）
- 型号 PJE110（一加机型），**Android 14 / SDK 34**，aarch64，Cortex-A510 级小核 ⇒ 骁龙 8 系 / 天玑 9000 系旗舰 SoC。
- 该环境即手机本体（Termux + proot-distro），`/storage/emulated/0` 为真机存储。
- ⇒ 无 Java/Android SDK，**必须在 GitHub Actions 中构建**。`gh` CLI 已登录（`wangzheruoyun`，具备 `repo` + `workflow` 权限）。
- ⇒ WebGL / Live2D 性能无风险；Android 15 的 "所有文件访问" 按钮变灰问题**不适用于本机**。

### 2.7 外部情报
- 官方英文名为 **Love Nest**（Steam app 2595110 / 5184600），开发商「莲花池池 / 池池」。游戏为**病娇 Meta ADV**——这证实 Windows 专属演出不是彩蛋而是核心演出。
- 游戏已于 2026-10 上架（V0.098）；本构建是 2025-01 的 Demo V1.52。
- 社区已有手机端方案（B 站教程 + 「盖世游戏」容器，即 Wine/Box64 路线）⇒ **模拟器路线已被验证可行，可作兜底。**

## 3. 目标 / 非目标 / 反目标

**目标**
- 手机上安装一个 **3–5MB 的 APK**，读取手机上既有的游戏文件夹，资源不进 APK、不进仓库。
- 离线可玩：主菜单 → 开场 → 剧情 → 存档/读档 → 设置，全流程可用。
- Meta 演出在安卓上以等价形式保留。
- 由 GitHub Actions 自动构建，打 tag 产出 Release，APK 直接挂载。

**非目标**
- 不破解/修改加密游戏数据，不汉化，不做 Mod。
- 不做 iOS，不做网页版发行。
- 不分发游戏资源。

**反目标（技术上"能跑"也算失败）**
- 为了跑起来而牺牲 Meta 演出（即误入 platform 3）。
- 把约 480MB 资源塞进 APK。
- 每次迭代都需要在本地安装 Android Studio。
- 必须外接鼠标/键盘才能玩。
- 存档丢失或频繁崩溃。
- 污染游戏文件夹（移植后原版 exe 必须仍能正常运行）。

## 4. 约束（Global Constraints）

- 目标平台：Android，`minSdk 26`，`targetSdk 34`，`compileSdk 34`，仅 arm64-v8a。
- 包名：`com.github.wangzheruoyun.lovenest`。
- 应用版本：`1.0.0`。
- 游戏目录默认值：`/storage/emulated/0/Download/爱之巢DemoV1.52/`（可在设置中修改）。
- 存档目录：手机 `Documents/<gameName>/`，与 PC 版行为一致。
- 游戏文件**零改动**：`script.js`、`asset/**`、`index.html` 的磁盘内容一律不得修改；不得向游戏目录写入任何文件。
- 仓储不含任何游戏资源；仓库公开。
- APK 使用**正式签名密钥**，密钥与口令存放于 GitHub Actions Secrets。
- 构建方式：GitHub Actions（`assembleRelease`），打 tag 触发 Release。
- 技术栈：纯 Kotlin + Gradle（AGP 8.x、JDK 17），**不引入 Capacitor / Cordova / npm**。
- 桩层语言：ES5 兼容 JavaScript（引擎为 ES5 风格，需兼容）。
- 不启用任何 CSP 头（引擎依赖 `eval`）。

## 5. 架构

```
GitHub 公开仓 wangzheruoyun/LoveNest
├─ .github/workflows/build.yml      JDK17 + Android SDK → assembleRelease → 挂 Release
├─ docs/superpowers/…               本设计与实施计划
└─ android-app/
    ├─ app/src/main/AndroidManifest.xml    横屏锁定、MANAGE_EXTERNAL_STORAGE、immersive
    ├─ app/src/main/java/…/MainActivity.kt WebView 宿主、权限、沉浸全屏、常亮、生命周期派发
    ├─ app/src/main/java/…/GameBridge.kt   @JavascriptInterface：同步文件 IO + Meta 演出原生能力
    ├─ app/src/main/java/…/AssetSource.kt  IO 抽象层（file:// 直读；预留 SAF / 私有目录两种实现）
    ├─ app/src/main/assets/gc-bridge.js    桩层：require / process / fs / nw.gui / child_process
    └─ app/build.gradle.kts
```

### 5.1 页面加载方式（决定 platform 取值）

WebView 直接加载：

```
file:///storage/emulated/0/Download/爱之巢DemoV1.52/index.html
```

- `location.href` 以 `file` 开头，且我方已定义 `window.require` ⇒ 引擎取 **`os.platform = 2`（PC）** ⇒ Meta 演出与 fs 存档全部激活。
- **不使用内嵌 HTTP 服务。** 理由是它会令引擎落入 platform 3，从而掐死 Meta 演出与 fs 存档。
- 副作用（均为正向）：无需 NanoHTTPD、无需手写 Range/206（`file://` 原生支持音视频拖动）、无需同步 XHR。

### 5.2 桩层如何注入（保证游戏目录零改动）

`WebViewClient.shouldInterceptRequest` 拦截 `script.js` 的响应，**在其内容前置 `gc-bridge.js`**。因为 `index.html` 通过 `<script src="script.js?r=...">` 加载引擎，前置即保证桩层先于引擎执行。

- 备选方案（若 `file://` 子资源拦截在实测中不生效）：在 App 私有目录放置一个 12 行的启动页 HTML，内含 `<base href="file:///storage/emulated/0/Download/爱之巢DemoV1.52/">`，并按原顺序引入 `gc-bridge.js` 与 `script.js`，最后调用 `main()`。该方案同样保持游戏目录零改动。

### 5.3 WebSettings（明确取舍）

开启：`setJavaScriptEnabled(true)`、`setDomStorageEnabled(true)`、`setAllowFileAccess(true)`、`setAllowFileAccessFromFileURLs(true)`、`setAllowUniversalAccessFromFileURLs(true)`、`setMediaPlaybackRequiresUserGesture(false)`、硬件加速。

关于 `setAllowUniversalAccessFromFileURLs`：Android 官方安全指南建议关闭（防 file:// 型 XSS）。本应用**只加载用户本机的游戏文件，不含任何远程内容与外部输入**，因此该风险面不存在。此为**知情且有意的取舍**，需在代码注释中写明。

不发送任何 CSP 响应头（引擎完全依赖 `eval`）。

### 5.4 同步文件 IO

`@JavascriptInterface` 导出的方法从 JS 侧调用是**同步阻塞返回**的。因此 `fs.readFileSync` / `existsSync` / `readdirSync` / `statSync` 直接调原生、以 base64 往返二进制。

⇒ 不需要同步 XHR，也不需要"内存缓存 + 异步落盘"的复杂设计。

### 5.5 IO 抽象层（风险对冲）

`AssetSource` 接口隔离"文件从哪来"，先只实现一种：

- `DirectFileSource` — 用真实路径直读（依赖 `MANAGE_EXTERNAL_STORAGE`）。

预留（暂不实现）：`SafSource`（`ContentResolver` + 目录树 URI）、`PrivateCopySource`（一次性拷贝到 App 私有目录）。

理由：Android 14 上"所有文件访问"在个别 ROM 可能不可授予。人类伙伴已决定**不做 SAF 兜底**；本抽象层使兜底成本降至约 1 小时而非推倒重来。

### 5.6 Meta 演出的安卓映射

| 原（Windows） | 安卓替代 |
|---|---|
| `wmic useraccount` 读取真实用户名 | 读取**安卓设备名**（手机设备名通常即机主真名，如「XXX 的 OnePlus 12」），语义与讽刺意味与原设计一致；读取失败则回退到系统账户名 |
| `wmic os get Caption` 读取系统版本 | 返回 `Android <版本>`，**纯 ASCII**，以绕开引擎的 GBK buffer 解码路径 |
| `W26_DesktopWallpaper` 改桌面壁纸 | `WallpaperManager.setBitmap()`（`SET_WALLPAPER` 为普通权限，免运行时弹窗） |
| `nircmd trayballoon` 托盘气泡 | `Toast` / 通知 |
| `nircmd shutdown` 关机 | 全屏黑场"正在关机"演出 → `finish()` 退出应用 |
| `nw.Window.get()` 窗口控制 | 伪对象，映射到安卓沉浸全屏 / `finish()` |
| `nw.Shell.openItem()` | 系统 `Intent` |
| `nw.Clipboard.get()` | `navigator.clipboard`（`http://`/`file://` 之外需确认安全上下文）或原生桥 |
| `os.homedir()` → `Documents/` | 手机 `Documents/`（通过原生桥） |
| `navigator.vibrate` 震动（platform 4 专属） | 由 Kotlin 侧提供，供 Meta 演出调用 |
| `document` 的 `pause`/`resume`（Cordova 事件） | Activity 生命周期中合成派发，用于音频暂停/恢复 |

### 5.7 触摸与适配

- 引擎在 platform 2 使用 `MOUSE_DOWN`；WebView 会把触摸合成为鼠标事件，点击可用。
- 横屏锁定、沉浸全屏、常亮均由 Kotlin 侧实现（不依赖引擎的 Cordova 分支）。
- 1600×900 的缩放交由引擎自带的 LayaAir 缩放模式处理；真机若点击偏移或黑边异常，再在桩层加坐标变换。
- 仅在实测需要时增加屏幕浮层按钮（Enter / 跳过 / 隐藏 UI / 返回）。

## 6. 交付物

- 公开仓 `wangzheruoyun/LoveNest`，含自研代码、CI、设计与计划文档。
- GitHub Release 中的一个**约 3–5MB 的已签名 APK**，手机浏览器点击即可下载安装。
- 该 APK 读取手机上的游戏文件夹运行，游戏目录保持零改动。

## 7. 风险与处置

| # | 风险 | 处置 |
|---|---|---|
| 1 | `file://` 的子资源拦截可能不生效 | 已验证的备选方案：私有目录启动页 + `<base href>`（见 5.2） |
| 2 | `fetch()` 在 `file://` 下可能不可用（引擎有 4 处 fetch） | 桩层可覆写 `window.fetch` 走原生桥；M2 实测确认 |
| 3 | 引擎可能期望 `loader` / `Handler` / `readFile` / `nativePath` 等外壳全局 | M2 实测枚举并补齐（CI 无头日志驱动） |
| 4 | `MANAGE_EXTERNAL_STORAGE` 在个别 ROM 被禁用 | `AssetSource` 抽象层预留两种兜底实现（见 5.5） |
| 5 | 首屏需重解 9.5MB 脚本 + 加载 77MB 字体 | M3 实测耗时；必要时加启动图 / 字体子集化（本 Demo 不阻塞） |
| 6 | 引擎启动时会向 GC 云平台发统计请求 | 离线环境自然失败；必要时在桩层屏蔽 |
| 7 | 手势/缩放需真机确认 | M6 真机验证 |

## 8. 明确留给构建者的决定

- Kotlin 侧的具体类划分、协程/线程模型、错误提示文案。
- `shouldInterceptRequest` 拦截匹配的具体实现方式（后缀匹配 / MIME / 缓存）。
- GBK 相关字符串的具体 ASCII 取值。
- CI 工作流的具体 action 版本与缓存策略。
- Release 触发方式以外的一切 Gradle 细节（`build.gradle.kts` 结构、签名配置注入方式）。
- 测试策略：哪些逻辑用单元测试覆盖（如路径映射、GBK 规避、桩层路由），哪些依赖真机验收。

## 9. 验收标准

1. `gh run` 中 CI 全绿，Release 上存在已签名 APK。
2. 手机安装后可进入标题界面，并完整走通：开场 → 剧情 → 存档 → 重启应用后读档成功。
3. 游戏目录内所有原始文件哈希不变，且原版 exe 仍可正常运行。
4. Meta 演出按 5.6 的映射在安卓上可见。
5. 无崩溃、无 OOM；横屏沉浸全屏生效；屏幕常亮。
