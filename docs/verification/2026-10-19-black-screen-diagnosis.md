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
