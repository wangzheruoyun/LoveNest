# 黑屏诊断包（Task 11）验收记录

**状态：** 待真机取证 —— 本机无 Java / Android SDK / 模拟器，Kotlin 侧改动（渲染进程死亡钩子、
心跳看门狗、内存采样、WebGL 探针、亮度留痕）**无法在本机运行或验证**，必须由真机安装
`v1.0.0-diag1` 后产生日志再判定。

## 产物

| | |
|---|---|
| APK | `app-release.apk`（tag `v1.0.0-diag1`，正式密钥签名） |
| 日志落点 | `/storage/emulated/0/Documents/爱之巢-logs/session-<yyyyMMdd-HHmmss>.log` |
| 日志回退点 | `<应用私有目录>/files/爱之巢-logs/session-….log`（外部不可写时，头部记录） |

## 复现步骤（真机）

1. 安装 `v1.0.0-diag1` 的 `app-release.apk`（与已装版本同签名，可原地覆盖安装）。
2. 授予「所有文件访问」。
3. 启动游戏，点到标题界面、点一次出声音，等它进入「少女祈祷中」，直到画面变黑。
4. 黑屏后等 30 秒（让心跳与内存采样各写出若干行），再按返回键、再等 10 秒。
5. 用文件管理器或 `adb pull` 取出上表路径的日志。

## 判定表

见 `task-11-report.md`「四个假设如何在日志里区分」。

## 证据

- [ ] 真机日志（待补）
- [ ] RED / GREEN（见 `task-11-report.md`）
- [ ] CI run id（见 `task-11-report.md`）

---

# 黑屏诊断包 v2（Task 12）验收记录

**状态：** 待真机一次往返取证 —— 本机无 Java / Android SDK / 模拟器，Kotlin 侧改动
（HEARTBEAT 计数器、STALL 看门狗、音量键 dump / 模拟丢失、webgl2 探针修复）**无法在本机
编译或运行**；当前只有 CI 能证明它可编译。Node 侧探针（rAF 差分、上下文丢失、音频、
请求追踪、可见性、事实快照、dump）有本机 RED→GREEN 证据。

## 产物

| | |
|---|---|
| APK | `app-release.apk`（tag `v1.0.0-diag2`，正式密钥签名，与已装版本可原地覆盖） |
| 日志落点 | `/storage/emulated/0/Documents/爱之巢-logs/session-<yyyyMMdd-HHmmss>.log`（不变） |
| 判别记录 | 每次心跳一条 `NATIVE_HB …`；黑屏 6 秒后一条 `STALL …`（**无需用户操作**） |

## 复现步骤（真机）

1. 覆盖安装 `v1.0.0-diag2` 的 `app-release.apk`（与已装版本同签名）。
2. 启动游戏，点到标题界面、点一次出声音，等它进入「少女祈祷中」直到画面变黑。
3. **什么都不要按**，等 30 秒 —— STALL 记录会自己写出（心跳表格每 2 秒一行）。
4. 可选：按一次 **音量减** 立即 dump；按一次 **音量加** 模拟一次 WebGL 上下文丢失
   （diag2 专属，见报告「须在正式版移除」）。
5. 取出上表路径的日志。

## 判定表（一次运行即可落到某一分支）

| 观测 | 结论 |
|---|---|
| `rafFired` 冻结、`rafSched` 继续增长，`STALL` 出现 | **甲** 帧不再产生（合成器/GPU 静默停摆） |
| `rafSched` 也冻结、`hb` 继续增长 | **乙** 引擎自身循环停住 |
| `rafSched`、`rafFired`、`hb` 都在增长而画面纯黑 | 引擎在**画黑**（内容问题，非渲染停摆） |
| 额外看 `ctxLost` | `甲` 且 `ctxLost>0` ⇒ 上下文丢失是根因；`ctxLost=0` ⇒ 排除上下文丢失 |

## 证据

- [ ] 真机日志（待补：`NATIVE_HB` 表格 + `STALL` 记录）
- [x] RED（`fail 10`，新测试打旧 shim）→ GREEN（`102/102`）（见 `task-12-report.md`）
- [ ] CI run id（见 `task-12-report.md`）

---

# 黑屏诊断包 v3（Task 13）验收记录

**状态：** 待真机一次往返取证 —— 本机无 Java / Android SDK / 模拟器，Kotlin 侧改动
（v3 心跳字段、FB 采样触发）**只能由 CI 证明可编译**；页面侧探针（帧缓冲采样、绘制计数、
WebAudio 存活、字节口径、挂起表修复）有本机 RED→GREEN 证据。

## 产物

| | |
|---|---|
| APK | `app-release.apk`（tag `v1.0.0-diag3`，`versionName=1.0.0-diag3`、`versionCode=2`，正式密钥签名，可原地覆盖 diag1/diag2） |
| 日志落点 | `/storage/emulated/0/Documents/爱之巢-logs/session-<yyyyMMdd-HHmmss>.log`（不变） |
| 决定性记录 | `FB sample …`（t+8/16/30 秒各一次，帧内采样）＋每条 `NATIVE_HB …` 的 `draws/clear/texUp/readPx/absStart/ctxTime` |

## 复现步骤（真机）

1. 覆盖安装 `v1.0.0-diag3` 的 `app-release.apk`（与已装版本同签名）。
2. 启动游戏，点到标题界面、点一次出声音，等它进入「少女祈祷中」直到画面变黑。
3. **什么都不要按**，至少等 35 秒 —— `FB sample` 会在 t+8/16/30 秒各落一条（心跳表每 2 秒一行）。
4. 可选：按一次 **音量减** 立即 dump 并再触发一次采样；按一次 **音量加** 模拟一次 WebGL 上下文丢失（diag 构建专属）。
5. 取出上表路径的日志。

## 判定表（帧缓冲采样把结论钉死）

| 观测 | 结论 |
|---|---|
| `FB sample … nonBlack=0` 且 `draws`/`clear` 在涨 | 引擎在画，但画出来就是黑（场景状态为空/无效） |
| `FB sample … nonBlack>0`（mean/max 非零） | 引擎画对了，是合成/上屏那层没显示 |
| `draws` 不涨（`FB sample` 的 pts/内容与上一帧一致或采样根本没落） | 引擎的渲染路径停了（不是 rAF 停） |
| `ctxLost=true` 或 `glErr≠0` | 采样时刻上下文已丢 / GL 出错 |

## 证据

- [ ] 真机日志（待补：`FB sample` 序列 + `NATIVE_HB` 表格）
- [x] RED（`pending-probe` 5 中 4 失败；`bridge.test.js` 5 失败，均打旧 shim）→ GREEN（`112/112`）（见 `task-13-report.md`）
- [x] CI：分支 run `39215971255` success；tag run `39216236585` success（见 `task-13-report.md`）
- [x] Release：https://github.com/wangzheruoyun/LoveNest/releases/tag/v1.0.0-diag3 ，APK 1,868,332 B，
      SHA-256 `838d0907c5f747547ca825f0b2ebea03d57910c90b9c120461a03ca1c13a1b39`

---

# 黑屏根因与修复（`v1.0.0-fix1`）

**状态：** 根因已定案并在本机以真机 UA 复现、修复后同条件复跑通过；真机复验待用户安装
`v1.0.0-fix1` 确认。Kotlin 侧未改动，本次只改 `assets/gc-bridge.js` 与一条单测。

## 一句话根因

引擎的 `FileUtils.createDirectoryForce` / `FileUtils.saveFile` 用 `Browser.onPC` 分叉且
**没有 `else`**；手机 UA 下 `onPC = !onMobile` 为 `false`，两条分支被跳过时**它们的完成回调
被静默丢弃**，而 `SyncTask.taskOver(FileUtils.TASK_MODIFY_FILE)` 正长在这些回调里 ⇒ 文件任务
锁永不释放，加载完成后的一切（默认存档写入、Meta 演出、第一幕 BGM）全部卡在队列里。

## 引擎源码（`script.js`，行号为解码后行号）

```js
FileUtils.createDirectoryForce = function (localURL, onFin, taskLock, ...) {
    var taskF = function () {
        var onCreateDirectoryFin = Callback.New(function (success, localURL) {
            onFin && onFin.runWith([success, localURL]);
            if (taskLock)
                SyncTask.taskOver(FileUtils.TASK_MODIFY_FILE);   // 51173 ← 解锁唯一出口
        }, this);
        ...
        if (Browser.onPC) {                                       // 51197 ← 分叉，无 else
            ...
            createDirectoryForce(fullURL, function () {
                onCreateDirectoryFin.runWith([true, localURL]);   // 51204 ← 被丢弃
            }, function () { ... }, this);
        }
    };
    if (taskLock) new SyncTask(FileUtils.TASK_MODIFY_FILE, taskF);  // 51240
};
```

`FileUtils.saveFile` 同样形状：`else if (Browser.onPC) { mainDomain_fs.writeFile(...) }`（51143）。

Laya 侧：`Browser.onMobile = Browser.u.indexOf("Mobile") > -1;`（6946）、
`Browser.onPC = !Browser.onMobile;`（6956）⇒ 任何手机 UA 都得到 `onPC = false`。
Demo 只发行过 Windows 版（`onPC = true`），所以移动端这条分支是从未被完成的死代码。

## 为什么症状是「进度条走完 → 纯黑、无异常、心跳照跑」

- 加载期的素材请求由引擎自带的 loader 独立驱动，与文件任务锁无关 ⇒ 进度条正常走完。
- 加载结束后引擎进入「建目录 → 写存档 → Meta 演出 → 载 BGM → 建第一幕」的串行队列，
  第一步就卡在未释放的锁上 ⇒ 转场幕布被画上后再没人来揭。
- 没有异常、没有宿主调用、页面心跳与渲染循环继续 ⇒ 与真机日志完全一致
  （diag3 会话：141 个请求后彻底安静、`pageerrors: 0`、暗屏冻结在 `draws` 持续增长）。

## 本机复现与修复证据

无头驱动新增 `--ua-mobile`：在 Laya 读 UA 之前把 `navigator.userAgent` 换成真机那支
Android WebView UA，于是 Laya **自己**算出 `onMobile=true / onPC=false` —— 不强制任何属性，
不会与桩层互相打架。

| 运行 | 引擎请求数 | 末尾请求 | `Pray_1.ogg` | Meta 演出 ×3 | 第一幕 BGM |
|---|---|---|---|---|---|
| 已知良好基线（桌面 UA） | 179 | 第一幕 BGM | ✅ | ✅ | ✅ |
| 真机 diag3 日志 | 141 | `btn_normal.png` | ❌ | ❌ | ❌ |
| `--ua-mobile`，修复前 | **与真机一致** | `btn_normal.png` | ❌ | ❌ | ❌ |
| `--ua-mobile`，修复后 | 179 | 第一幕 BGM | ✅ | ✅ | ✅ |

- 修复后 `--ua-mobile` 的请求流与已知良好基线**逐条相同（179/179，0 处差异）**。
- 桌面 UA 下修复前后同为 179 条、地标全中，且不打印 `Desktop parity` ⇒ **修复在桌面环境是惰性的**。
- 单测 `bridge.test.js`「onPC」三例：修复前 RED（3 例全失败）→ 修复后 GREEN；全集 115/115。

## 修复内容

`gc-bridge.js` 在发布 `require`/`process` 之后调用 `enforceDesktopPlatform()`：每 250 ms 检查
一次 `Laya.Browser`，把 `onPC` 置为 `true`。用定时器而不是一次性赋值，是因为
`Browser.__init__` 是**惰性且只跑一次**的（首次访问 `Browser.*` 时执行），可能晚于本脚本。
只动 `onPC` 一个字段：整个引擎里它只被读 3 处（上述两条分支 + Laya `TextInput` 的
`input.focus()`）；`Browser.onMobile` 保持设备真实值，Laya 的触摸绑定不受影响。

## 真机复验清单（安装 `v1.0.0-fix1`）

- [ ] 覆盖安装（同正式密钥签名），保留「所有文件访问」授权。
- [ ] 从标题穿过「少女祈祷中」进入第一幕：有画面、有声音、可操作。
- [ ] 黑屏期间按一次**音量减**可立即 dump（该构建仍带观测）；如已正常则无需。
- [ ] 取 `/storage/emulated/0/Documents/爱之巢-logs/` 最新会话日志留档。
- [ ] 复核游戏目录 `/storage/emulated/0/Download/爱之巢DemoV1.52/` 仍是 2047 个文件、
      无 `savedata/`、无 `log/`（**存档写入落到游戏目录**的问题另行处理，见台账）。

## 本机复现命令

```bash
cd tools/headless
node transition-probe.js --seconds 25 --ua-mobile   # 修复前：地标全 false
node transition-probe.js --seconds 25               # 桌面：地标全 true
node --test --test-name-pattern='onPC'              # 单测
```
