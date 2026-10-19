# Love Nest Demo V1.52 → Android 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让《爱之巢 / Love Nest》Demo V1.52 在安卓手机上通过一个约 3–5MB 的已签名 APK 离线运行，读取手机上既有的游戏文件夹，并保留全部 Meta 演出。

**Architecture:** WebView 直接以 `file://` 加载游戏目录的 `index.html`，使引擎取 `os.platform = 2`（PC/nw.js 分支），从而激活 Meta 演出与 fs 存档。桩层 `gc-bridge.js` 通过 `shouldInterceptRequest` 前置注入到 `script.js` 响应之前，向引擎提供 `window.require` / `window.process`；所有原生能力经同步 `@JavascriptInterface` 桥（`GameBridge`）落地。同一套桩层挂在 `__GCNative` 宿主接口上，因此在 Node/Playwright 无头环境与安卓上行为一致、可测。

**Tech Stack:** Kotlin、Gradle/AGP 8.x（JDK 17）、Android SDK 34、WebView、纯 ES5 JavaScript、Node + Playwright（无头验证）、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-18-love-nest-android-design.md`

## Global Constraints

- `minSdk 26`、`targetSdk 34`、`compileSdk 34`，仅 `arm64-v8a`。
- 包名 `com.github.wangzheruoyun.lovenest`；版本 `1.0.0`。
- 游戏目录默认 `/storage/emulated/0/Download/爱之巢DemoV1.52/`；存档写手机 `Documents/<gameName>/`。
- **游戏文件零改动**：不得修改 `script.js` / `asset/**` / `index.html` 的磁盘内容；不得向游戏目录写入任何文件。
- 仓库不含任何游戏资源；仓库公开。
- APK 使用正式签名密钥，密钥与口令存于 GitHub Actions Secrets。
- 构建在 GitHub Actions 完成（`assembleRelease`，打 tag 触发 Release）。
- 纯 Kotlin + Gradle；**不得引入 Capacitor / Cordova / npm 依赖到安卓工程**。
- 桩层必须是 ES5 兼容 JavaScript。
- 不发送任何 CSP 响应头（引擎依赖 `eval`）。
- WebView 必须开启 `setAllowFileAccessFromFileURLs(true)` 与 `setAllowUniversalAccessFromFileURLs(true)`，并在代码注释中写明这是知情取舍。
- 本机（Termux/proot，aarch64）无 Java 与 Android SDK：安卓相关验证只能靠 CI；JS 相关验证在本机 Node 完成。

## Review Focus

以下几类输入/失败模式由 spec 隐含，但没有任何任务的测试会覆盖，最可能咬到使用者。每条都在所属任务中补了对应测试。

1. **游戏目录不存在或被移动** — 期望：应用给出明确提示并允许修改路径，而不是白屏或崩溃。
2. **存档目录不可写（`Documents/` 缺失或只读）** — 期望：游戏内存档不丢、不静默失败；至少桩层返回失败而非抛出到引擎。
3. **引擎请求了未被桩层覆盖的 Node 模块或全局** — 期望：返回惰性 no-op 代理而不是 `undefined` 引发 `TypeError`，使引擎继续启动。
4. **`child_process` 命令返回非 ASCII 或非预期内容** — 期望：桩层只回 ASCII，引擎的 GBK 解码路径不炸。
5. **游戏资源路径含中文与空格（`爱之巢DemoV1.52`）** — 期望：路径拼接、URL 编码、base64 往返均正确，图片与音频正常加载。

---

### Task 1: 无头验证骨架（Node + Playwright 跑起真实游戏）

**Files:**
- Create: `tools/headless/package.json`
- Create: `tools/headless/host-native.js`
- Create: `tools/headless/run.js`
- Create: `tools/headless/.gitignore`
- Modify: `/root/LoveNest/.gitignore`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `host-native.js` 导出 `createHost({ gameRoot, docsRoot })`，返回一个对象，其方法与 Task 3 的 `__GCNative` 接口**逐一同名同签名**（见 Task 3 Interfaces）。`run.js` 输出 `tools/headless/out/screenshot.png` 与 `tools/headless/out/console.log`，退出码 0 表示页面加载完成且无 `pageerror`。

- [ ] **Step 1: 安装 Playwright 与 Chromium，确认本机可跑**

Run:
```bash
cd /root/LoveNest/tools/headless && npm init -y && npm i -D playwright && npx playwright install chromium
```
Expected: 安装成功，且 `npx playwright --version` 有输出。若 aarch64 下 Chromium 无法启动（proot 限制），改为在本地安装系统 chromium 并改用 `channel: 'chromium'`；仍不可行则记入本任务产物 `tools/headless/NOTES.md`，并把后续 JS 验证降级为"仅 node 单元测试 + 真机验收"。

- [ ] **Step 2: 写失败测试 —— 宿主接口的最小契约测试**

Create `tools/headless/host-native.test.js`:
```js
const test = require('node:test');
const assert = require('node:assert');
const { createHost } = require('./host-native');

const GAME_ROOT = '/storage/emulated/0/Download/爱之巢DemoV1.52';

test('exists() 对存在的游戏文件返回 true，对不存在的返回 false', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs' });
  assert.strictEqual(host.exists('index.html'), true);
  assert.strictEqual(host.exists('nope_missing_file.xyz'), false);
});

test('readBase64() 往返中文路径下的文件', () => {
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs' });
  const b64 = host.readBase64('icon.png');
  assert.ok(b64 && b64.length > 0, '应读到 icon.png');
  assert.strictEqual(Buffer.from(b64, 'base64').length > 0, true);
});

test('gameRoot() 返回去尾斜杠的绝对路径', () => {
  const host = createHost({ gameRoot: GAME_ROOT + '/', docsRoot: '/tmp/lovenest-docs' });
  assert.strictEqual(host.gameRoot(), GAME_ROOT);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tools/headless/host-native.test.js`
Expected: FAIL，报 `Cannot find module './host-native'`

- [ ] **Step 4: 实现 `createHost`**

Create `tools/headless/host-native.js`，实现 Task 3 Interfaces 中列出的**全部**方法，语义与安卓桥一致：路径解析先把相对路径按 `gameRoot` 解析、以 `/` 开头则视为绝对路径；二进制一律 base64；所有读操作失败时返回 `null`／`false` 而不抛异常（Review Focus #1、#2、#5）。`gameRoot()` 与 `docsRoot()` 返回去掉尾部 `/` 的绝对路径。`deviceName()` 返回 `'Headless Host'`，`androidVersion()` 返回 `'0'`。

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test tools/headless/host-native.test.js`
Expected: PASS（3 tests）

- [ ] **Step 6: 写无头启动脚本**

Create `tools/headless/run.js`：以 `file://<gameRoot>/index.html` 打开页面，注册 `page.on('pageerror')` 与 `page.on('console')`，等待 20s，截图到 `out/screenshot.png`，控制台与错误写入 `out/console.log`；若出现任何 `pageerror` 则退出码非 0。

- [ ] **Step 7: 运行无头启动，记录基线**

Run: `node tools/headless/run.js 2>&1 | tail -30`
Expected: 生成 `out/screenshot.png` 与 `out/console.log`。此步**允许失败**——目的是拿到"尚未注入桩层时引擎的真实报错基线"。把该基线贴入 `tools/headless/NOTES.md`。

- [ ] **Step 8: Commit**

```bash
cd /root/LoveNest && git add -A tools/headless .gitignore
git commit -m "test: add headless harness for shim development"
```

---

### Task 2: `path` / `os` / `process` 桩层

**Files:**
- Create: `android-app/app/src/main/assets/gc-bridge.js`
- Create: `tools/headless/bridge.test.js`

**Interfaces:**
- Consumes: `createHost()`（Task 1）
- Produces: `gc-bridge.js` 暴露全局 `window.require(name)`、`window.process`，并读取全局 `__GCNative` 作为宿主。模块内提供内部函数 `resolvePath(p)`（相对路径按 `host.gameRoot()` 解析）与 `toBuffer(b64)`（base64 → `Uint8Array`）。

- [ ] **Step 1: 写失败测试 —— path 与 process 契约**

Create `tools/headless/bridge.test.js`：
```js
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('node:fs');
const { createHost } = require('./host-native');

const GAME_ROOT = '/storage/emulated/0/Download/爱之巢DemoV1.52';

function loadBridge(host) {
  const sandbox = { window: {}, console, __GCNative: host, setTimeout, clearTimeout, Date, JSON, Math };
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('../../android-app/app/src/main/assets/gc-bridge.js', 'utf8'), sandbox);
  return sandbox.window;
}

test('path.join 在中文与空格路径下拼接正确', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const path = w.require('path');
  assert.strictEqual(path.join(GAME_ROOT, 'asset/json', 'startup.json'),
    GAME_ROOT + '/asset/json/startup.json');
});

test('process.cwd() 返回游戏根目录，供引擎推导 FileUtils.nativePath', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(w.process.cwd(), GAME_ROOT);
});

test('process.memoryUsage() 返回对象形状', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const m = w.process.memoryUsage();
  assert.strictEqual(typeof m.rss, 'number');
  assert.strictEqual(typeof m.heapTotal, 'number');
  assert.strictEqual(typeof m.heapUsed, 'number');
});

test('未知模块返回惰性 no-op 代理而非 undefined', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const mod = w.require('some-unknown-module');
  assert.notStrictEqual(mod, undefined);
  assert.strictEqual(typeof mod.anything, 'function');
  assert.strictEqual(typeof mod.a.b.c, 'function');
});

test('os.homedir() 指向手机 Documents 根', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(w.require('os').homedir(), '/tmp/d');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: FAIL，`ENOENT` 找不到 `gc-bridge.js`

- [ ] **Step 3: 实现 `gc-bridge.js` 的 path / os / process 部分**

ES5 语法。`process` 需提供 `platform='win32'`、`versions={node:'0.64.1'}`、`argv=[]`、`env={}`、`cwd()`、`memoryUsage()`、`on()`、`nextTick(f)`、`exec`/`execSync` 转发到宿主（Task 4 补全）。未知模块用 `Proxy` 兜底为惰性 no-op（Review Focus #3）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: PASS（5 tests）

- [ ] **Step 5: Commit**

```bash
cd /root/LoveNest && git add -A android-app/app/src/main/assets/gc-bridge.js tools/headless/bridge.test.js
git commit -m "feat: add path/os/process shim for engine"
```

---

### Task 3: `fs` 桩层（同步原生 IO）

**Files:**
- Modify: `android-app/app/src/main/assets/gc-bridge.js`
- Modify: `tools/headless/bridge.test.js`

**Interfaces:**
- Consumes: `resolvePath()`、宿主 `__GCNative`
- Produces: `__GCNative` 宿主接口（安卓侧由 Task 7 的 `GameBridge.kt` 实现，方法名与签名必须逐字一致）：
  - `gameRoot() -> String`、`docsRoot() -> String`
  - `exists(path) -> Boolean`、`stat(path) -> String|null`（JSON：`{isDirectory:Boolean,size:Number}`）
  - `readBase64(path) -> String|null`、`writeBase64(path, b64) -> Boolean`
  - `readDir(path) -> String`（JSON 字符串数组）、`mkdirp(path) -> Boolean`、`unlink(path) -> Boolean`
  - `deviceName() -> String`、`androidVersion() -> String`
  - `setWallpaper(b64) -> Boolean`、`toast(msg)`、`fakeShutdown()`、`openFile(path) -> Boolean`
  - `vibrate(ms)`、`clipboardGet() -> String`、`clipboardSet(s)`、`log(s)`

- [ ] **Step 1: 写失败测试 —— fs 同步读写与存档落点**

追加到 `tools/headless/bridge.test.js`：
```js
test('fs.existsSync / readFileSync 能读到游戏目录内的文件', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/lovenest-docs' }));
  const fsShim = w.require('fs');
  assert.strictEqual(fsShim.existsSync(GAME_ROOT + '/index.html'), true);
  const buf = fsShim.readFileSync(GAME_ROOT + '/index.html');
  assert.ok(buf && buf.length > 0);
});

test('fs.writeFileSync 写入存档路径后 readFileSync 能读回（含中文内容）', () => {
  const docsRoot = '/tmp/lovenest-docs-test';
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot }));
  const fsShim = w.require('fs');
  const p = docsRoot + '/save1.json';
  fsShim.writeFileSync(p, '{"名字":"爱之巢"}');
  assert.strictEqual(fsShim.readFileSync(p, { encoding: 'utf8' }), '{"名字":"爱之巢"}');
});

test('fs.existsSync 指向不存在的路径返回 false 而非抛异常', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  assert.strictEqual(w.require('fs').existsSync('/nope/definitely/missing'), false);
});

test('fs.readdirSync 返回目录内文件名数组', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const names = w.require('fs').readdirSync(GAME_ROOT);
  assert.ok(names.indexOf('index.html') >= 0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: FAIL，`require('fs').existsSync is not a function`

- [ ] **Step 3: 实现 fs 桩层**

提供 `existsSync`、`readFileSync`、`writeFileSync`、`readdirSync`、`statSync`、`mkdirSync`、`unlinkSync`，以及异步形态 `readFile`/`writeFile`/`readdir`/`stat`/`mkdir`（回调式，内部用 `setTimeout(0)` 包装同步实现）。`readFileSync` 支持 `{encoding:'utf8'}` 返回字符串、否则返回 `Uint8Array`。所有失败路径返回 `false`/`null`/抛兼容 Node 的错误对象，**不得让异常穿透到引擎**（Review Focus #1、#2）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: PASS（9 tests）

- [ ] **Step 5: Commit**

```bash
cd /root/LoveNest && git add -A android-app/app/src/main/assets/gc-bridge.js tools/headless/bridge.test.js
git commit -m "feat: add synchronous fs shim backed by native bridge"
```

---

### Task 4: `child_process` / `nw.gui` 桩层与 Meta 映射

**Files:**
- Modify: `android-app/app/src/main/assets/gc-bridge.js`
- Modify: `tools/headless/bridge.test.js`

**Interfaces:**
- Consumes: 宿主 `__GCNative.deviceName()` / `androidVersion()` / `toast()` / `fakeShutdown()` / `openFile()` / `clipboardGet()` / `clipboardSet()` / `setWallpaper()`
- Produces: `require('child_process')` → `{ exec, execSync, spawn }`；`require('nw.gui')` → `{ Window: { get }, Clipboard: { get }, Shell: { openItem } }`。`execSync(cmd, opts)` 返回 `Uint8Array`（当 `opts.encoding === 'buffer'`）或字符串。

- [ ] **Step 1: 写失败测试 —— 命令映射与 nw.gui 形状**

追加到 `tools/headless/bridge.test.js`：
```js
test('wmic os get Caption 返回纯 ASCII 的 Android 版本串', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const cp = w.require('child_process');
  const out = cp.execSync('chcp 936 && wmic os get Caption', { encoding: 'buffer' });
  const s = Buffer.from(out).toString('latin1');
  assert.ok(/^[\x00-\x7F]*$/.test(s), '输出必须全为 ASCII，Review Focus #4');
  assert.ok(s.indexOf('Android') >= 0 || s.indexOf('android') >= 0);
});

test('wmic useraccount 返回非空设备名', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const s = w.require('child_process').execSync('chcp 936 && wmic useraccount where name="x" get fullname');
  assert.ok(String(s).length > 0);
});

test('关机命令触发 fakeShutdown 而不是真的执行', () => {
  let shut = 0;
  const host = createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' });
  host.fakeShutdown = () => { shut++; };
  const w = loadBridge(host);
  w.require('child_process').exec(GAME_ROOT + '/asset/pcSys/nircmd.exe "shutdown"');
  assert.strictEqual(shut, 1);
});

test('nw.gui 提供 Window.get / Clipboard.get / Shell.openItem', () => {
  const w = loadBridge(createHost({ gameRoot: GAME_ROOT, docsRoot: '/tmp/d' }));
  const nw = w.require('nw.gui');
  assert.strictEqual(typeof nw.Window.get, 'function');
  assert.strictEqual(typeof nw.Window.get().close, 'function');
  assert.strictEqual(typeof nw.Clipboard.get().set, 'function');
  assert.strictEqual(typeof nw.Shell.openItem, 'function');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: FAIL，`cp.execSync is not a function`

- [ ] **Step 3: 实现 child_process 与 nw.gui**

按 spec 5.6 的映射表实现命令路由：`wmic os get Caption` → `'Android ' + host.androidVersion()`；`wmic useraccount` → `host.deviceName()`；`nircmd … shutdown` → `host.fakeShutdown()`；`nircmd … trayballoon` → `host.toast()`；其余命令写 `host.log()` 并返回空串。**所有返回给引擎的字符串只含 ASCII**（Review Focus #4）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: PASS（13 tests）

- [ ] **Step 5: Commit**

```bash
cd /root/LoveNest && git add -A android-app/app/src/main/assets/gc-bridge.js tools/headless/bridge.test.js
git commit -m "feat: map windows-only commands and nw.gui onto android host"
```

---

### Task 5: 引擎启动至标题界面（零 pageerror）

**Files:**
- Modify: `tools/headless/run.js`
- Create: `tools/headless/NOTES.md`（追加实测结论）

**Interfaces:**
- Consumes: `gc-bridge.js`、`createHost`
- Produces: `run.js` 支持 `--inject` 开关，在页面加载前通过 `page.addInitScript()` 注入 `__GCNative` 与 `gc-bridge.js`。

- [ ] **Step 1: 打开注入开关并跑一次**

Run: `node tools/headless/run.js --inject 2>&1 | tail -40`
Expected: 输出真实报错列表（这是本任务的输入，不是失败）。

- [ ] **Step 2: 逐个补齐报错暴露的缺口直至零 pageerror**

对 `out/console.log` 中每一条 `ReferenceError` / `TypeError`，在 `gc-bridge.js` 中补齐对应全局或模块（spec 2.4 已预判 `loader`、`Handler`、`readFile`、`nativePath`、`Buffer`、`global` 需要提供）。若引擎使用 `fetch()` 读本地文件，则在桩层覆写 `window.fetch` 走宿主 `readBase64()`（spec 风险 #2）。

- [ ] **Step 3: 验证达到"标题界面可见且零 pageerror"**

Run: `node tools/headless/run.js --inject; echo "exit=$?"`
Expected: `exit=0`，且人工查看 `tools/headless/out/screenshot.png` 能看到标题界面（而非黑屏或空白）。

- [ ] **Step 4: 把实测结论写入 NOTES.md**

记录：哪些全局/模块不得不补、`fetch` 是否被使用、首屏耗时、控制台残留告警。

- [ ] **Step 5: Commit**

```bash
cd /root/LoveNest && git add -A tools/headless android-app/app/src/main/assets/gc-bridge.js
git commit -m "feat: boot the game headless with zero page errors"
```

---

### Task 6: 安卓 Gradle 骨架 + CI 出包

**Files:**
- Create: `.github/workflows/build.yml`
- Create: `android-app/settings.gradle.kts`、`android-app/build.gradle.kts`、`android-app/gradle.properties`
- Create: `android-app/app/build.gradle.kts`
- Create: `android-app/app/src/main/AndroidManifest.xml`
- Create: `android-app/app/src/main/java/com/github/wangzheruoyun/lovenest/MainActivity.kt`
- Create: `gradle/wrapper/gradle-wrapper.properties`、`gradlew`、`gradle/wrapper/gradle-wrapper.jar`

**Interfaces:**
- Consumes: `gc-bridge.js`（作为 `assets/` 资源随 APK 打包）
- Produces: 可安装的 `app-release.apk`；`MainActivity` 中 `loadGame()` 负责设置 WebSettings 并加载 `file://` URL。

- [ ] **Step 1: 生成 Gradle wrapper**

Run:
```bash
cd /root/LoveNest/android-app && curl -sL -o /tmp/gw.jar https://raw.githubusercontent.com/gradle/gradle/v8.7.0/gradle/wrapper/gradle-wrapper.jar && \
mkdir -p gradle/wrapper && cp /tmp/gw.jar gradle/wrapper/gradle-wrapper.jar && \
printf 'distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n' > gradle/wrapper/gradle-wrapper.properties
```
Expected: `gradle/wrapper/gradle-wrapper.jar` 存在且非空。

- [ ] **Step 2: 写最小可编译工程（AGP 8.5.2 / JDK 17 / compileSdk 34）**

`MainActivity.kt` 此步只需加载 `file://` 的 `index.html` 并开启 WebSettings（Task 7 再加桥与权限）。`AndroidManifest.xml` 声明 `android:screenOrientation="landscape"`、`MANAGE_EXTERNAL_STORAGE`、`SET_WALLPAPER`。

- [ ] **Step 3: 写 CI 工作流**

`.github/workflows/build.yml`：`actions/checkout` → `actions/setup-java@v4`（temurin 17）→ `gradle/actions/setup-gradle@v4` → `./gradlew assembleDebug` → `actions/upload-artifact@v4` 上传 `app-debug.apk`。

- [ ] **Step 4: 建仓并推送**

```bash
cd /root/LoveNest && git add -A && git commit -m "build: add android gradle skeleton and CI" && \
gh repo create wangzheruoyun/LoveNest --public --source=. --remote=origin --push
```
Expected: 仓库创建成功且推送完成。

- [ ] **Step 5: 验证 CI 产出 APK**

Run: `gh run list --limit 1 && gh run watch --exit-status`
Expected: 运行成功（绿）。然后 `gh run download -n app-debug` 能取到 APK 文件。

- [ ] **Step 6: Commit**

```bash
cd /root/LoveNest && git add -A && git commit -m "build: verify CI produces installable apk" --allow-empty
```

---

### Task 7: `GameBridge` 原生桥 + 权限 + 沉浸全屏 + 桩层注入

**Files:**
- Create: `android-app/app/src/main/java/com/github/wangzheruoyun/lovenest/GameBridge.kt`
- Create: `android-app/app/src/main/java/com/github/wangzheruoyun/lovenest/AssetSource.kt`
- Modify: `android-app/app/src/main/java/com/github/wangzheruoyun/lovenest/MainActivity.kt`
- Create: `android-app/app/src/test/java/.../PathMappingTest.kt`

**Interfaces:**
- Consumes: Task 3 的 `__GCNative` 方法清单（必须逐字一致）；`gc-bridge.js`
- Produces: `AssetSource` 接口 `fun open(path: String): InputStream?`、`fun exists(path: String): Boolean`、`fun list(path: String): List<String>?`、`fun write(path: String, bytes: ByteArray): Boolean`、`fun root(): String`；实现 `DirectFileSource(root: File)`。

- [ ] **Step 1: 写失败测试 —— 路径解析与越权防护**

Create `PathMappingTest.kt`：
```kotlin
@Test fun relative_path_resolves_under_game_root() {
    val src = DirectFileSource(File("/storage/emulated/0/Download/爱之巢DemoV1.52"))
    assertEquals("/storage/emulated/0/Download/爱之巢DemoV1.52/asset/a.png", src.resolve("asset/a.png"))
}
@Test fun dotdot_cannot_escape_game_root() {
    val src = DirectFileSource(File("/storage/emulated/0/Download/爱之巢DemoV1.52"))
    assertNull(src.resolve("../secret"))
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: 由 CI 执行 `./gradlew :app:testDebugUnitTest`
Expected: FAIL，`DirectFileSource` 未定义

- [ ] **Step 3: 实现 `AssetSource` 与 `DirectFileSource`**

`resolve()` 做规范化并拒绝逃逸出 `root` 的路径（返回 `null`）。`open/exists/list/write/root` 基于 `java.io.File` 实现。

- [ ] **Step 4: 实现 `GameBridge`**

用 `@JavascriptInterface` 暴露 Task 3 列出的**全部**方法。二进制以 base64 往返；`documentsRoot()` 返回 `Environment.getExternalStoragePublicDirectory(DIRECTORY_DOCUMENTS)` 下的游戏子目录，缺失时自动创建；`setWallpaper(b64)` 用 `WallpaperManager`；`fakeShutdown()` 在全屏黑场后调用 `finish()`；`deviceName()` 读系统设备名，失败回退 `Build.MODEL`。

- [ ] **Step 5: 运行测试确认通过**

Run: CI `./gradlew :app:testDebugUnitTest`
Expected: PASS

- [ ] **Step 6: 在 `MainActivity` 中接线**

设置 WebSettings（含 `setAllowFileAccessFromFileURLs(true)`/`setAllowUniversalAccessFromFileURLs(true)` 并写明知情取舍注释）、`addJavascriptInterface(GameBridge(...), "AndroidBridge")`、沉浸全屏、常亮、`screenOrientation` 锁定；`shouldInterceptRequest` 拦截 `script.js` 响应并前置 `gc-bridge.js`。同时在页面加载前注入一个极小的 inline 脚本，把 `window.__GCNative` 指向 `window.AndroidBridge`。

- [ ] **Step 7: 真实设备验证（人工）**

Run: `gh run list --limit 1 && gh run watch --exit-status`，然后下载 APK 安装。
Expected: 应用可安装、能进入标题界面；`logcat` 中无 `AndroidRuntime` 崩溃。

- [ ] **Step 8: Commit**

```bash
cd /root/LoveNest && git add -A && git commit -m "feat: add native bridge, permissions and shim injection"
```

---

### Task 7b: 补齐 Meta 演出缺口（壁纸读取 / qboxcom 确认框 / 熄屏）

> 本节由实施阶段插入：Task 4 在实测引擎调用点时发现三处 Meta 演出无法落地，必须补齐，否则「打破第四面墙」的演出会部分缺失或用错语义。

**Files:**
- Modify: `android-app/app/src/main/assets/gc-bridge.js`
- Modify: `android-app/app/src/main/java/com/github/wangzheruoyun/lovenest/GameBridge.kt`
- Modify: `android-app/app/src/main/java/com/github/wangzheruoyun/lovenest/MainActivity.kt`（仅在需要放开权限/接线时）
- Modify: `tools/headless/host-native.js`、`tools/headless/inpage-host.js`
- Modify: `tools/headless/bridge.test.js`

**Interfaces:**
- Produces: `__GCNative` 契约第 22–24 个方法（同步、失败不抛、返回 `null`/`false`）：
  - `getWallpaper() -> String|null` — 当前壁纸的 base64（无法读取时 `null`）
  - `confirm(title, body) -> Boolean` — 阻塞式确认框；`true` 表示用户选了「是」
  - `screenOff() -> void` — 熄屏（`offMonitor` 的安卓等价物）
- Consumes: 现有 21 方法契约、`gc-bridge.js` 的 `fs`/`child_process` 路由、Task 7 的 `AssetSource`

**背景（Task 4 实测结论，均为引擎真实行为）：**
1. 壁纸**读取**演出：`W26_DesktopWallpaper` 经 `fs` + `process.env.APPDATA` 读 `\Microsoft\Windows\Themes\` 下的真实壁纸文件；安卓上没有该路径，读取必然失败，演出变空。
2. `nircmd qboxcom`：`showMessage_yes` 要求 `stdout.trim() == "yes"` 才置 `flag = true`（`rv.js:98169`）；当前路由返回 `''`，因此永远走「否」分支，玩家无法回答「是」。
3. `offMonitor`（`scrnsave.scr /s`）：目前只写日志，不熄屏。

- [ ] **Step 1: 写失败测试（桩层三处路由）**

在 `tools/headless/bridge.test.js` 追加断言：`child_process` 路由到 `confirm` 并据其返回值产出 `'yes'`/`''`；`offMonitor` 命令路由到 `screenOff()`；读 `APPDATA` 壁纸路径时走 `getWallpaper()` 并返回真实字节。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd tools/headless && node --test bridge.test.js`
Expected: FAIL —— 三条新断言失败，其余保持通过。

- [ ] **Step 3: 三处宿主接口同步实现**

`gc-bridge.js` 新增三条路由；`host-native.js`（Node 真文件系统）、`inpage-host.js`（无头，`getWallpaper` 返回一张真实存在的图片字节、`confirm` 记录并返回 `false`、`screenOff` 记日志）、`GameBridge.kt`（`WallpaperManager.getDrawable()` → base64；`AlertDialog` 确认框须回主线程同步取值；熄屏用 `WindowManager.LayoutParams.screenBrightness = 0` 或等效手段）三处**同名同签名**。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd tools/headless && node --test`
Expected: PASS，且输出整洁。

- [ ] **Step 5: 无头回归**

Run: `node tools/headless/run.js --inject; echo "exit=$?"`
Expected: `exit=0`、`pageerrors = 0`、`os.platform === 2`、`main calls = 1`。若 `getWallpaper` 路由被引擎触发，`out/console.log` 中可见对应 host 日志。

- [ ] **Step 6: CI 保持绿（含 `:app:testDebugUnitTest`）并提交**

```bash
cd /root/LoveNest && git add -A && git commit -m "feat: close the three remaining meta-performance gaps"
```

---

### Task 8: 正式签名 + Release 自动出包

**Files:**
- Modify: `.github/workflows/build.yml`
- Create: `android-app/keystore.properties.template`
- Modify: `android-app/app/build.gradle.kts`

**Interfaces:**
- Consumes: Task 6 的 CI 骨架
- Produces: 打 `v*` tag 时自动创建 Release 并挂载已签名 APK。

- [ ] **Step 1: 生成签名密钥**

Run:
```bash
cd /root/LoveNest && keytool -genkeypair -v -keystore lovenest-release.jks -alias lovenest \
  -keyalg RSA -keysize 2048 -validity 10000 -storepass "$(openssl rand -hex 16)" -dname "CN=LoveNest"
```
Expected: 生成 `lovenest-release.jks`。**该文件不得提交到仓库**（加入 `.gitignore`）。

- [ ] **Step 2: 写入 GitHub Secrets**

Run:
```bash
cd /root/LoveNest && base64 -w0 lovenest-release.jks > /tmp/ks.b64 && \
gh secret set KEYSTORE_BASE64 < /tmp/ks.b64 && \
gh secret set KEYSTORE_PASSWORD --body "<上一步的口令>" && \
gh secret set KEY_ALIAS --body "lovenest" && \
gh secret set KEY_PASSWORD --body "<上一步的口令>"
```
Expected: `gh secret list` 中四个 secret 均存在。

- [ ] **Step 3: 接线签名配置与 release 工作流**

Gradle 从环境变量读取 keystore（CI 中先 base64 解码回文件）；工作流在 tag 触发时执行 `assembleRelease` 并用 `softprops/action-gh-release@v2` 挂载 APK。

- [ ] **Step 4: 验证 tag 触发 Release**

Run: `git tag v1.0.0 && git push origin v1.0.0 && gh run watch --exit-status`
Expected: Release `v1.0.0` 中存在 `app-release.apk`。

- [ ] **Step 5: Commit**

```bash
cd /root/LoveNest && git add -A && git commit -m "build: add release signing and tag-driven release"
```

---

### Task 9: 真机验收（触摸、缩放、存档持久化、Meta 演出）

**Files:**
- Create: `docs/verification/2026-10-18-device-acceptance.md`

**Interfaces:**
- Consumes: Task 8 产出的已签名 APK
- Produces: 一份实机验收记录。

- [ ] **Step 1: 安装并授权**

从 Release 下载 APK 安装，授予"所有文件访问"。若授权入口不可用，如实记录，并按 spec 5.5 启用兜底实现（`SafSource` 或 `PrivateCopySource`）——此时本任务新增对应实现与测试。

- [ ] **Step 2: 验证游戏目录零改动**

Run:
```bash
cd "/storage/emulated/0/Download/爱之巢DemoV1.52" && \
find . -type f -newermt "2026-10-18 00:00" | head
```
Expected: 无输出（没有任何文件被新建或修改）。

- [ ] **Step 3: 逐项实测并记录**

必须实测：标题界面 → 开场 → 剧情推进 → 存档 → 杀进程重开 → 读档成功 → 设置项可用；横屏沉浸全屏生效；屏幕常亮；触摸点击命中准确；音视频正常播放与拖动。

- [ ] **Step 4: 记录 Meta 演出表现**

对照 spec 5.6 逐条记录在安卓上的实际表现（设备名读取、壁纸替换、气泡提示、关机演出）。

- [ ] **Step 5: Commit**

```bash
cd /root/LoveNest && git add -A docs/verification && git commit -m "docs: record on-device acceptance results"
```

---

### Task 10: 收尾（图标、名称、返回键、音频焦点）

**Files:**
- Create: `android-app/app/src/main/res/mipmap-*/ic_launcher.png`
- Modify: `android-app/app/src/main/AndroidManifest.xml`
- Modify: `android-app/app/src/main/java/.../MainActivity.kt`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: v1.0.0 正式版 APK。

- [ ] **Step 1: 加入图标与中文应用名**

从 `asset/icon` 中选取现有素材（**复制到 APK 资源，不修改游戏目录**），应用名显示为 `爱之巢`。

- [ ] **Step 2: 处理返回键与音频焦点**

返回键先交给游戏内 UI（若可），否则弹确认后退出；进入后台时派发合成 `pause` 事件、回前台派发 `resume`，使引擎的音频暂停/恢复逻辑生效。

- [ ] **Step 3: 打 tag 出正式包**

Run: `git tag v1.0.0-final && git push origin v1.0.0-final && gh run watch --exit-status`
Expected: Release 中 APK 可下载安装，Task 9 的验收项复测通过。

- [ ] **Step 4: Commit**

```bash
cd /root/LoveNest && git add -A && git commit -m "feat: add icon, back-button and audio focus handling"
```

---

## Self-Review

**1. Spec coverage**
- 2.2 原文件零改动 → Task 1 Step 1 的 `gitignore` 与 Task 9 Step 2 的 `find -newermt` 验证；Task 7 Step 6 采用 `shouldInterceptRequest` 注入。
- 2.3 平台机制（必须落 platform 2）→ Task 5（无头环境用 `file://`）、Task 6/7（安卓用 `file://`）。
- 2.4 依赖面 → Task 2（path/os/process）、Task 3（fs）、Task 4（child_process/nw.gui）、Task 5 Step 2（`loader`/`Handler`/`readFile`/`nativePath`/`Buffer`/`global`）。
- 2.5 引擎 Cordova 能力改由原生实现 → Task 7 Step 6、Task 10 Step 2。
- 2.6 只能在 CI 构建 → Task 6。
- 5.2 注入方式与备选 → Task 7 Step 6。
- 5.3 WebSettings 取舍 → Task 7 Step 6。
- 5.4 同步 IO → Task 3。
- 5.5 IO 抽象层 → Task 7 Step 1–3、Task 9 Step 1。
- 5.6 Meta 映射 → Task 4、Task 9 Step 4。
- 5.7 触摸与适配 → Task 9 Step 3。
- 6 交付物 → Task 8。
- 7 风险 #2 `fetch` → Task 5 Step 2；风险 #5 首屏 → Task 5 Step 4。
- 9 验收标准 → Task 9。

**2. Step scan**：Task 5、Task 9 属反编译式发现工作，采用"运行—记录—补齐"的验证步骤而非 TDD，这是黑盒逆推的固有形态，已在步骤中写明确切命令与预期输出。其余任务均为测试先行。

**3. Type consistency**：`__GCNative` 方法清单只在 Task 3 Interfaces 定义一次，Task 4、Task 7 均引用之；`createHost`（Task 1）与 `GameBridge`（Task 7）实现同一清单。`DirectFileSource.resolve()` 在 Task 7 Step 1 与 Step 3 一致。

**4. Review Focus**：五条均已落到所属任务——#1 → Task 3 Step 1/3、Task 9 Step 1；#2 → Task 3 Step 3；#3 → Task 2 Step 1/3；#4 → Task 4 Step 1/3；#5 → Task 1 Step 2、Task 2 Step 1。

**5. Proportion**：计划长度与 spec 相当，代码块仅出现在测试断言与必须逐字固定的命令处，实现体一律只给签名与语义约束。
