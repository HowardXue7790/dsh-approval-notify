# dsh-approval-notify

给 DSH 的**权限审批请求**弹 Windows 通知：正文由模型改写成一句大白话，通知上带「允许本次 / 拒绝」两个按钮。点按钮直接决定，点正文把 DSH 抬到前台并把决定交给网页卡片。

只影响审批请求，不碰会话完成通知（那个 DSH 自带）。

## 装上

```sh
dsh plugin add github:HowardXue7790/dsh-approval-notify
```

装完在 DSH 的 **设置 → 已安装插件 → 审批通知** 里打开即可。

## 它做的事

1. 拦截 `approval/request`：先看前台是不是 DSH 窗口。是的话什么都不做，走 DSH 原本的网页卡片。
2. 不是的话，把审批理由交给模型改写成一句大白话（`原始说明` 太长、太技术，通知里没人看）。
3. 弹一个 Windows toast（`scenario="reminder"`，不会几秒自己消失），两个按钮通过自定义协议 `dsh-approval-notify://` 回调到插件自己起的 `127.0.0.1` 随机端口 + 随机 token 的回环服务。
4. 点「允许本次」→ `allowed-once`；点「拒绝」→ `rejected`；点正文 → 抬窗 + 交回网页卡片；`waitMs` 内没人理 → 也交回网页卡片，等于没装。
5. 任何一步失败、非 Windows、或拿不到端口，都原样 `next()`，退回 DSH 自己的审批链路。

## 设置项

设置里有**两处**入口：设置侧栏单独一栏，以及已安装插件里本插件那一页。

| 项 | 说明 |
| --- | --- |
| 语言 | 通知正文与按钮：中文 / English |
| 模型 | 和聊天窗口同一个下拉（provider / model，含推理等级）；不选则跟随会话默认模型 |
| Prompt | 翻译用的系统提示词，预填内置文案，清空即恢复内置 |
| 等待时长 | 分 + 秒；超时后交回网页卡片 |
| 前台时不弹通知 | 开着时，你正看着 DSH 窗口就不打扰你（默认开） |

## 它会往你机器上写什么

- `HKCU\Software\Classes\dsh-approval-notify`：按钮点击用的 URL 协议（指向包内的 `answer.vbs`）。**不需要管理员权限**；插件卸载时会删掉。
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DSH 审批通知.lnk`：只为一个 `AppUserModel.ID`，让通知标题显示 DSH 而不是 Windows PowerShell（未打包的 Electron 进程没有 package identity，只能这么绕）。插件卸载时同样删除。

没有别的写入，不改 profile 配置以外的东西，不发任何外部网络请求（只有 `127.0.0.1` 回环）。

## 已知边界

- 只在 **Windows** 上生效；其它平台直接交回原链路。
- DSH 已经缩到托盘时，点通知正文抬不起窗口（没有窗口句柄可操作），日志会记 `focus no-window`。
- 通知归属名依赖上面那个快捷方式；建不出来就退回 PowerShell 的 AUMID——通知照常工作，只是标题写着 Windows PowerShell。
- 只在 **DSH Desktop**（Electron 外壳）里验证过。

更多实现细节见 [docs/DETAIL.zh.md](docs/DETAIL.zh.md) / [docs/DETAIL.md](docs/DETAIL.md)，自检见 `node test.mjs`。

## License

MIT

---

# dsh-approval-notify (English)

Windows toast notifications for DSH **approval requests**: the reason is rewritten by a model into one plain-language sentence, and the toast carries `Allow` / `Deny` buttons. A button press decides; clicking the toast body brings DSH forward and hands the decision to the in-app card.

Only approval requests are affected; DSH's own turn-completion notifications are untouched.

## Install

```sh
dsh plugin add github:HowardXue7790/dsh-approval-notify
```

Then enable it under **Settings → Installed plugins → Approval notify**.

## What it does

1. Hooks `approval/request` and checks whether DSH is the foreground window. If it is, it does nothing and DSH's own card handles the request.
2. Otherwise it asks the model to rewrite the reason into one plain sentence.
3. Shows a Windows toast (`scenario="reminder"`, so it does not vanish after a few seconds). The two buttons call back through the `dsh-approval-notify://` protocol into a loopback server the plugin runs on `127.0.0.1` with a random port and per-request token.
4. `Allow` → `allowed-once`, `Deny` → `rejected`, clicking the body → raise the window and hand the decision to the card, no answer within `waitMs` → also hand it to the card, exactly as if the plugin were absent.
5. Any failure, non-Windows platform, or missing port falls through to `next()`.

## Settings

Two entry points: a dedicated section in Settings, and the plugin's own page under Installed plugins.

| Setting | Meaning |
| --- | --- |
| Language | Toast body and button labels: Chinese / English |
| Model | The same picker as the chat window (provider / model, plus reasoning effort); empty follows the session default |
| Prompt | System prompt used for the rewrite; prefilled with the built-in one, clearing it restores that |
| Wait | Minutes + seconds before falling back to the in-app card |
| Skip when focused | While DSH is in the foreground, don't interrupt (on by default) |

## What it writes on your machine

- `HKCU\Software\Classes\dsh-approval-notify` — the URL protocol behind the buttons (points at the bundled `answer.vbs`). No admin rights needed; removed on unload.
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\DSH 审批通知.lnk` — only to carry an `AppUserModel.ID`, so the toast header says DSH instead of Windows PowerShell (an unpacked Electron process has no package identity, so this is the only way). Also removed on unload.

Nothing else is written, no non-loopback network traffic.

## Known limits

- Windows only; other platforms fall through untouched.
- While DSH is minimized to the tray, clicking the toast body cannot raise it (no window to act on) and the log records `focus no-window`.
- The attribution depends on that Start Menu shortcut; if it cannot be created the toast still works under PowerShell's AUMID, just mislabelled.
- Verified only inside **DSH Desktop** (the Electron shell).

## License

MIT
