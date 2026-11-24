# 审批通知（approval-notify）

需要你授权时，DSH 原本只在窗口里挂一张卡片。这个插件把它改成一条 Windows 通知：

- **正文是大白话**：把 `approval/request` 里的工具名和原始理由交给当前默认模型，改成一句「它会动到你电脑上的什么」的话。模型不可用或超时（12s）就退回原始文案。
- **通知上有按钮**：「允许本次」「拒绝」直接回传结果，不用切回 DSH 窗口。
- **点通知正文**（不是按钮）不算表态：它只把 DSH 抬到前台、收起通知，然后把这次审批交回网页卡片，由卡片上的按钮决定。
- **点按钮会把 DSH 抬到前台**：回环服务收到答案后跑 `focus.ps1`（`ShowWindowAsync` 还原 + 置顶/取消置顶翻转 + `SetForegroundWindow`）。不能用「再启动一次自己」那招（点通知时拿到前台权限的是 `wscript`，DSH 没有，`SetForegroundWindow` 被前台锁挡掉），也不能用 `SwitchToThisWindow`（实测会把窗口藏进托盘）。若 DSH 已经在托盘里，任何窗口调用都救不回来，日志会写 `focus no-window`。
- **通知不自己消失**：普通 toast 只支持 `short`/`long` 且 Win11 常忽略时长，这里用 `scenario="reminder"`，通知一直留在屏幕上直到你点按钮或关掉它。
- **切回 DSH 就自动换卡片**：通知还挂着的时候你打开 DSH 窗口，`watch.ps1` 立刻把通知收掉、把请求交回网页卡片——不用干等超时。
- **不抢卡片**：你正看着 DSH 窗口时不弹通知（走的还是原来的卡片）；弹了通知就不走卡片，所以不会留下点不掉的僵尸卡片。
- **显示成 DSH 发的**：通知顶部的应用名取自 AUMID，所以插件**启动时**（`shortcut.ps1`，每次启动确认一遍）会在开始菜单建一个 `DSH 审批通知` 快捷方式，给它带上 `System.AppUserModel.ID = Dsh.ApprovalNotify`（BurntToast 同款做法），之后用这个 AUMID 发通知，图标用 DSH 的 exe。放在启动时做而不是第一次发通知时做：不占审批那一秒（C# 编译要半秒），也不依赖「有没有弹过通知」。改归属名只能这么干：借 Electron 的 `electron.app.<exe 名>` 会报 `0x80073D54`（未打包进程没有 package identity），toast 里的 `placement="attribution"` 文本 Win11 也不显示。建快捷方式失败就退回 PowerShell 的 AUMID（通知照发，只是名字显示成 Windows PowerShell）。
- **只在 Windows 上生效**：其它平台、注册表写入失败、PS 脚本失败、无人应答（默认 5 分钟）——任何一步不成立都退回原来的审批链路。

## 设置

配置项写在插件 `Config` 里（都是 `.volatile()` 字段，改完立即生效、不重启插件），在两处出现，改哪一处都一样：

- 设置 → **审批通知**（单独一栏）
- 插件 → 已安装插件 → approval-notify

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `locale` | `zh` | 通知正文和按钮的语言（zh / en） |
| `waitMs` | `300000` | 没人点按钮时等多久把请求交回网页卡片（设置页按「几分几秒」显示） |
| `focusCheck` | `true` | DSH 窗口在前台时是否跳过通知、直接出网页卡片 |
| `modelProvider` + `model` | 空 | 翻译用哪个模型；设置页是一个下拉框，列表来自聊天窗口同一个 `session.modelCatalog()`，选中即同时写这两项，选「跟随会话默认」则两项清空 |
| `reasoningEffort` | 空 | 推理等级（同样是下拉，选项来自所选模型自己的 efforts）；留空用模型默认等级 |
| `prompt` | 空 | 系统提示词；设置页的输入框里预填的**就是内置那段**（中文 40 字 / 英文 20 词），可以直接改，清空后离开输入框即恢复内置 |

浏览器半体在 `client.js`：它不另存状态，读写都走 DSH 自己的 `configForms`（即插件 `Config` 那份设置文档，落在 profile 的 `cordis.patch.yml` 里这条 entry 的 `config` 上）。Host 侧读的是 volatile 引用，每次请求现取，所以改完下一分钟的通知就用新值。

## 它是怎么工作的

1. 插件在 `approval/request` waterfall 上 `prepend` 一个监听器。窗口不在前台时它自己终结整条链（不调 `next()`），于是网页端根本收不到这个请求，也就不会出现卡片。
2. 通知由 `show.ps1` 用 `ToastNotificationManager` 发；发之前用 `GetForegroundWindow` 判断前台是不是 DSH 自己。
3. 通知按钮是 `activationType="protocol"`，点击时 Windows 拉起自定义 URI `dsh-approval-notify://127.0.0.1:<port>/a?v=allow|deny&t=<token>`。
4. 注册项 `HKCU\Software\Classes\dsh-approval-notify\shell\open\command` 指向包内的 `answer.vbs`，它用 `MSXML2.XMLHTTP` 静默 GET 一次本插件的回环 HTTP 服务（随机端口 + 每请求随机 token），拿到的结果就是审批答案。VBS 只放行 `//127.0.0.1:` 开头的目标。
5. 注册表只在 `HKCU`（当前用户），插件停止/卸载时会删除；token 一次性，旧通知里的按钮点不动已经失效的请求。
6. 模型译出的那句话同时写进 `request.displayReason`，所以退回到网页卡片时，默认卡片正文也是这句白话（内置卡片只有一个正文位，原文不另显示）。

## 排查

- 通知没出现：看 `%TEMP%\dsh-approval-notify.log`（每次 apply / 翻译 / 发通知 / 回调都写一行），以及 `%TEMP%\dsh-approval-notify.json` 里的端口。
- 手动试通知：`powershell -File <包目录>\show.ps1 -Payload <一个 json 文件>`，payload 形如 `{"title":"t","body":"b","allow":"dsh-approval-notify://127.0.0.1:1/a?v=allow","deny":"...","allowText":"允许本次","denyText":"拒绝","tag":"test","appId":"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"}`。
- 通知不弹但日志说 `shown`：多半是 Windows 的通知设置/专注助手把这个 AUMID 静音了。
- 通知顶部写着「Windows PowerShell」：说明开始菜单里的 `DSH 审批通知.lnk` 没建成，看日志里 `shortcut exists|created|error: ...` 那一行（手动重试：`powershell -File <包目录>\shortcut.ps1 -Lnk "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DSH 审批通知.lnk" -Icon "<DSH NEXT.exe 路径>"`）。

## 取舍（已知上限）

- 用 PowerShell 自带的 AUMID 发通知，不安装任何额外 exe；个别机器上该 AUMID 被系统设置静音时会看不到通知，退回卡片。
- 前台判断靠进程名（`process.execPath` 的文件名），如果 DSH 的网页是在普通浏览器里打开的，判断为「不在前台」，此时会发通知而不是卡片。
- 通知正文要等模型一句话（通常 1–3 秒），这期间工具调用本来就在等人。
- 只覆盖 `approval/request`（工具授权）；`user-questions/request` 这类交互问答没有做。