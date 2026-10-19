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
