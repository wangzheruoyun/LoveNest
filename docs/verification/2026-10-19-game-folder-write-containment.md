# 游戏目录写入越界：引擎在游戏根目录里建目录（发现记录）

日期：2026-10-19
状态：**已修复**（`v1.0.0-fix3`；游戏目录已复原并逐字节核对）
发现方式：交付 `v1.0.0-fix2` 后按惯例复核游戏目录，发现目录数变化。

## 结论

需求「游戏文件夹必须逐字节不变」目前**被违反**。用户用 `v1.0.0-fix1` 玩过一次之后，
引擎在**游戏根目录内**创建了 5 个空目录：

```
/storage/emulated/0/Download/爱之巢DemoV1.52/savedata
/storage/emulated/0/Download/爱之巢DemoV1.52/log
/storage/emulated/0/Download/爱之巢DemoV1.52/晴小姐
/storage/emulated/0/Download/爱之巢DemoV1.52/\AppData\Roaming\cicigames
/storage/emulated/0/Download/爱之巢DemoV1.52/\AppData\Roaming\cicigames\LoveNest
```

全部为空目录（`ls -A` 计数 0）。游戏根目录本身的 mtime 也被改动
（`10-19 10:07`）。

## 证据

| 观测 | 值 |
|---|---|
| 新增目录数 | 5（`savedata`、`log`、`晴小姐`、两个 `\AppData\...`） |
| 新增文件数 | 1（`《爱之巢》游戏攻略.txt`，内容完整、是随游戏附带的攻略文档，10:21 时间戳） |
| 新增目录内容 | 全部为空 |
| 文件总数 | 2047（`fix1` 验收时）→ 2048 |
| 目录总数 | 119（不含根目录） |
| 目录 mtime | `晴小姐` 10:06；`log` 10:23；`savedata` 10:23 |
| 根目录 mtime | 10:07 |

`\AppData\Roaming\cicigames` 与 `\AppData\Roaming\cicigames\LoveNest` 是两个**平级**目录，
名字里是字面反斜杠——即引擎按 Windows 习惯调了两条路径，在 Linux/Android 上各自变成了
一个「名字带反斜杠」的目录，没有形成嵌套。

## 与设计意图的差距

设计上引擎的写入应当被**重挂到** `Documents/<游戏名>/` 下（`docsRoot`），读取仍以游戏根目录
为优先。实测 `docsRoot` 侧确实出现了：

```
/storage/emulated/0/Documents/爱之巢DemoV1.52/Documents/爱之巢/logs
```

也就是说**一部分**写入（host IO 那条路）走了 `docsRoot`，但引擎自己用相对路径做的
`FileUtils.createDirectoryForce` / `FileUtils.saveFile` 仍然落在 `process.cwd()`（= 游戏根目录）上，
于是同一次运行里两条路都留下了痕迹。

台账里第 2 条（`RootedPathAuthority` 游戏根优先 → 保存写入可能落进游戏目录）就是这个现象，
本次拿到了真机实证。

## 影响

- 违反「游戏文件夹零改动」这一硬需求；每次游玩都会新增/改动目录。
- 保存与日志可能被拆成两份（游戏目录 + `Documents`），后续诊断/迁移会分不清哪份是权威。
- 单机游戏本身仍可玩（用户已确认 fix1 正常），所以这不是黑屏级故障。

## 用户决定（2026-10-19）

「现在就修，并清掉那 5 个空目录」——清理与修复同时进行。

## 清理（游戏目录复原）

按用户授权删除 5 个空目录（删除前各自 `ls -A` 计数为 0）：

| 删除项 | 结果 |
|---|---|
| `savedata/` | 已删 |
| `log/` | 已删 |
| `晴小姐/` | 已删 |
| `\AppData\Roaming\cicigames/` | 已删 |
| `\AppData\Roaming\cicigames\LoveNest/` | 已删 |
| `《爱之巢》游戏攻略.txt` | 已删（**第 6 个**引擎产物，见下） |

删完后 `find -type f` = 2047、`find -mindepth 1 -type d` = 114。

### 逐字节核对（对原始压缩包）

原始包还在 `Download/123云盘/爱之巢DemoV1.52.rar`（RAR5）。本机没有 rar 工具，于是用纯
Python 直接走 RAR5 头部链（`/tmp/opencode/rar5diff.py`），把包内 `爱之巢DemoV1.52/`
前缀下的每一条与手机目录逐条比对：

| 项 | 结果 |
|---|---|
| 包内（前缀下） | 2047 文件 / 114 目录 |
| 清理后目录 | 2047 文件 / 114 目录 |
| 多出的文件 | 无 |
| 缺失的文件/目录 | 无 |
| 大小不一致 | 0 |
| mtime 不一致 | 0 |

### 第 6 个产物：`《爱之巢》游戏攻略.txt`

它是**引擎写的**，不是随包分发的：包内 2163 条记录里没有任何名字含 `攻略` 或 `《`，而
清理前的手机目录相对包内恰好只多这一个文件（2010 B，mtime `10-19 10:21`，落在同一次运行
的 10:06–10:23 区间）。内容即那条「打破第四面墙」的攻略文档（开头「您在找我对吗？那我就
来帮您啦。」）。备份在 `/tmp/opencode/engine-created-walkthrough.bak.txt`。

修复后它会被重挂到 `docsRoot` 侧（见下），安卓等价物仍然存在，只是不再落进游戏目录。

## 修复

修复放在 **shim**（`gc-bridge.js`），不动 Kotlin 宿主：

- 新增 `mirrorOf()`、`HOST_WRITE_OPS = { writeBase64:1, mkdirp:1, unlink:1, rmdir:1, rename:2 }`、
  `writeTowardMirror()`、`hostRead(name, abs, isMiss)`。
- 一次写入 → 先把目标换成 `docsRoot/` 下的镜像路径，再交给宿主；宿主一侧因此**只见到**
  `docsRoot` 内的路径，`RootedPathAuthority` 的纯字符串包含判定就足够，不需要存在性回退。
- 读取走「先游戏根、后镜像」的**双向**规则：`existsSync`/`readFileSync`/`readdirSync`/
  `statSync`/`accessSync` 命中游戏根就用游戏根，未命中才落到镜像。这样引擎写出去的存档
  （例如 `savedata/life.gcdata`）能被它自己读回来。
- **不归一化反斜杠**：镜像只是纯前缀替换，`\AppData\Roaming\cicigames` 这类字面反斜杠名字
  原样保留，于是引擎回读时解析到的是同一批字节。
- `mkdirSync` 的 EEXIST 判定也走同一条读规则（先游戏根、后镜像），避免镜像里已存在时误报。

配套：

- `tools/headless/inpage-host.js` 增加宿主侧兜底：写入目标落在游戏根内时打
  `[host:LEAK] write inside the game root: …` 并让该次写入失败（正常路径下永远不该触发）。
- `tools/headless/bridge.test.js` 增加 6 条用例（沙箱 `mkdtemp` 根）：针对旧 shim（`41ad994e`）
  先 RED（4 失败 / 2 通过），修复后 GREEN；全套 121/121。

## 验证

### 端到端：真实引擎（`transition-probe.js --seconds 25 --ua-mobile`）

RED = 已发布 `v1.0.0-fix2` 里的那个 shim（sha256 以 `41ad994e` 开头）；GREEN = 修复后的 shim。

| 观测 | RED（fix2 shim） | GREEN（修复后） |
|---|---|---|
| `[host:LEAK]` | **1**（`…/爱之巢DemoV1.52/savedata`） | **0** |
| 写目标 | 游戏根 `savedata` + `docsRoot/…/logs` | 全部在 `docsRoot` 镜像内 |
| landmark | 5 项全 false | 全 true |
| pageerrors | 1 | 0 |
| `total REQ start` | 151（停在第 151 条） | 205（完整启动） |

RED 那一行 `[host:LEAK]` 精确指出越界写入的落点就是游戏根下的 `savedata/`；无头宿主拒绝这次
写入（返回 false），引擎的 `FileUtils.createDirectoryForce` 因此拿不到 `SyncTask.taskOver`，
请求流停在第 151 条、landmark 全 false。真机上宿主不拒绝，所以表现为目录被污染而不卡死
（用户已确认 fix1/fix2 能正常游玩）。

日志（本地产物，`tools/headless/out/` 按约定不入库）：
`out/transition-probe.containment-red.log`、`out/transition-probe.containment-green.log`；
复现命令见上。

### 游戏目录核对

RED/GREEN 两次运行后各复核一次，`rar5diff` 均为 0 差异——无头宿主的写路径是 no-op，
所以无头运行本身不会污染游戏目录；真机侧的保证来自上面的 shim 改写。

## 修复方案与最初设想的差异（原未决问题 3）

最初打算在 Kotlin 侧把 `\` 归一化成 `/` 再判断归属。实际改为在 shim 里做**纯前缀替换**的
镜像映射，并**保留**字面反斜杠。理由：引擎写完之后会按同一路径读回来，任何归一化都会让
回读解析到不同的字节（`\AppData\...` 会变成嵌套目录）。归一化因此被放弃。

## 无头宿主的一个坑（记录一下，非本次修复引入）

清理前，探针会在 `file://…/爱之巢DemoV1.52/savedata`（手机上由 App 建出来的空目录）上**挂死**：
同步 XHR 打到一个「由安卓侧创建、经本机挂载」的目录时，Chromium 的 `file://` 目录列举一直不
返回，约 5 分钟后 Playwright 报 page closed。干净的发行目录（`asset/`、`locales/`、
`swiftshader/`）几十毫秒就返回 `status=0` 的列举页。这与修复无关（修复前后 `existsSync` 的
第一步都是问宿主），删掉那 5 个目录后即消失。
