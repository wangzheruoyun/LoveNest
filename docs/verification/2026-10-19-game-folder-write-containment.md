# 游戏目录写入越界：引擎在游戏根目录里建目录（发现记录）

日期：2026-10-19
状态：**已发现，未修复**（等用户决定）
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

## 未决问题

1. 那 5 个空目录要不要清掉，把游戏目录恢复成原始状态？（清理属于「动游戏目录」，需用户同意。）
2. `《爱之巢》游戏攻略.txt` 是否是用户自己从 `Download/123云盘/爱之巢DemoV1.52.rar`
   里单独解出来的（10:21），还是引擎写的？本机没有 rar 工具，无法与原始包逐文件比对。
3. 修复方案需确认：**写入重挂到 `docsRoot`、读取保持游戏根优先**；`\AppData\...` 这类
   Windows 相对路径需要先把 `\` 归一化成 `/` 再判断归属。
