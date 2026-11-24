# Approval notifications (approval-notify)

When DSH needs your permission it used to leave a card in the window. This plugin replaces that with a Windows toast:

- **Plain-language body**: the tool name and raw reason from `approval/request` are rewritten by the current default model into one sentence about what the action touches on your machine. If the model is unavailable or takes longer than 12s, the original text is used.
- **Buttons on the toast**: "Allow once" / "Deny" answer the request without switching back to the DSH window.
- **Clicking the toast body** (not a button) is not a vote: it brings DSH forward, dismisses the toast, and hands the request back to the in-app card.
- **A button press brings DSH forward**: once the loopback server has the answer it runs `focus.ps1` (`ShowWindowAsync` restore + top-most toggle + `SetForegroundWindow`). Relaunching its own executable does not work here (the foreground rights from the click belong to `wscript`, so `SetForegroundWindow` is refused), and `SwitchToThisWindow` is out too: it hid the window into the tray in testing. If DSH is already hidden in the tray no window call can bring it back; the log shows `focus no-window`.
- **No competing card**: when the DSH window is focused nothing is shown and the normal card is used; when a toast is shown the chain is ended there, so no un-dismissable card is left behind.
- **The toast does not slip away**: plain toasts only support `short`/`long` (and Windows 11 often ignores the duration), so the toast uses `scenario="reminder"` and stays on screen until you act on it.
- **Bringing DSH forward takes over**: while a toast is up, `watch.ps1` polls the foreground window; the moment DSH comes back to the front it removes the toast and hands the request to the in-app card instead of making you wait for the timeout.
- **Attributed to DSH**: the app name above a toast comes from its AUMID, so at plugin startup (`shortcut.ps1`, re-checked on every start) the plugin creates a `DSH Approval` shortcut in the Start Menu carrying `System.AppUserModel.ID = Dsh.ApprovalNotify` (the BurntToast trick) and sends the toast under that AUMID, with DSH's exe as the icon. Doing it at startup rather than on the first toast keeps it off the approval's critical path (the C# compile costs about half a second) and makes it independent of any toast ever firing. That shortcut is the only way to change the name: reusing Electron's `electron.app.<exe name>` fails with `0x80073D54` (an unpackaged process has no package identity), and the `<text placement="attribution">` line is not rendered on Windows 11. If the shortcut cannot be created the toast falls back to PowerShell's AUMID (still delivered, just labelled Windows PowerShell).
- **Windows only**: other platforms, a failed registry write, a failed PowerShell run, or no answer within the timeout (5 minutes by default) all fall back to the original approval path.

## Settings

The settings live in the plugin's `Config` (all `.volatile()` fields, so edits apply immediately without restarting the plugin) and show up in both places, editing either is the same:

- Settings → **Approval notifications** (its own section)
- Plugins → installed plugins → approval-notify

| Setting | Default | Meaning |
| --- | --- | --- |
| `locale` | `zh` | Language of the toast body and buttons (zh / en) |
| `waitMs` | `300000` | How long to wait before handing the request back to the in-app card (shown as minutes + seconds) |
| `focusCheck` | `true` | Skip the toast and use the in-app card while the DSH window is focused |
| `modelProvider` + `model` | empty | Which model writes the rewrite. One dropdown in the settings page, fed by the same `session.modelCatalog()` the chat picker uses; picking sets both fields, "Follow session default" clears both |
| `reasoningEffort` | empty | Reasoning effort (dropdown built from the chosen model's own efforts); empty uses the model default |
| `prompt` | empty | System prompt. The settings box is prefilled with the built-in wording (40 Chinese chars / 20 English words); edit it freely, or clear it and leave the box to restore the built-in text |

The browser half is `client.js`. It stores nothing of its own: reads and writes go through DSH's `configForms` — the plugin `Config` document kept under this entry's `config` in the profile's `cordis.patch.yml`. The host reads the volatile references on every request, so a change applies to the next toast.

## How it works

1. The plugin prepends a listener on the `approval/request` waterfall. When the window is not in the foreground it terminates the chain itself (never calling `next()`), so the web client never sees the request and no card appears.
2. `show.ps1` posts the toast through `ToastNotificationManager`, after checking `GetForegroundWindow` for the DSH process.
3. Toast buttons use `activationType="protocol"`, so Windows launches `dsh-approval-notify://127.0.0.1:<port>/a?v=allow|deny&t=<token>`.
4. `HKCU\Software\Classes\dsh-approval-notify\shell\open\command` points at the bundled `answer.vbs`, which silently GETs the plugin's loopback server (random port, per-request random token). The VBS only forwards targets starting with `//127.0.0.1:`.
5. The registry entry lives in `HKCU` (current user only) and is removed when the plugin stops; tokens are single use, so stale buttons do nothing.

## Troubleshooting

- No toast: read `%TEMP%\dsh-approval-notify.log` (apply / translate / toast / callback each log a line) and `%TEMP%\dsh-approval-notify.json` for the port.
- Manual toast test: `powershell -File <bundle>\show.ps1 -Payload <json>` with `{"title":"t","body":"b","allow":"dsh-approval-notify://127.0.0.1:1/a?v=allow","deny":"...","allowText":"Allow","denyText":"Deny","tag":"test","appId":"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"}`.
- The log says `shown` but nothing appears: Windows notification settings or Focus Assist are muting that AUMID.
- The toast is labelled "Windows PowerShell": the `DSH 审批通知.lnk` shortcut was not created; check the `shortcut exists|created|error: ...` line in the log (manual retry: `powershell -File <bundle>\shortcut.ps1 -Lnk "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\DSH 审批通知.lnk" -Icon "<DSH NEXT.exe path>"`).

## Known limits

- Toasts use PowerShell's built-in AUMID, so no extra exe is installed; on a machine where that AUMID is muted you see nothing and the request falls back to the card.
- Foreground detection compares the process name of `process.execPath`; if the DSH GUI is open in an ordinary browser it counts as "not focused", so you get a toast instead of the card.
- The toast body waits for one model sentence (usually 1–3s), while the tool call is waiting on a human anyway.
- Only `approval/request` (tool permission) is covered; `user-questions/request` style prompts are not.