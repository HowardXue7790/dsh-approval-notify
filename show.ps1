# Show (or skip) the approval toast. Prints exactly one of: shown | focused | error: ...
# ASCII only: this file is read by Windows PowerShell without a BOM, so non-ASCII
# bytes would be decoded as ANSI and can break parsing. All UI text comes from the
# UTF-8 payload JSON; the shortcut name below is built from char codes for the same reason.
param([Parameter(Mandatory = $true)][string]$Payload)

$ErrorActionPreference = 'Stop'
try {
  $p = Get-Content -LiteralPath $Payload -Raw -Encoding UTF8 | ConvertFrom-Json

  # The user is looking at DSH: let the in-app card take over instead of interrupting.
  if ($p.focusExe) {
    Add-Type -Namespace DshNotify -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int pid);
'@
    $hwnd = [DshNotify.Win]::GetForegroundWindow()
    $targetPid = 0
    [void][DshNotify.Win]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
    if ($targetPid -gt 0) {
      $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
      if ($proc -and ($proc.ProcessName -ieq $p.focusExe)) { 'focused'; exit 0 }
    }
  }

  $esc = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }
  # Clicking the toast *body* (not a button) only opens DSH and hands the decision to the
  # in-app card: it activates v=focus, which never votes.
  $launchAttr = ''
  if ($p.focusUri) { $launchAttr = ' activationType="protocol" launch="' + (& $esc $p.focusUri) + '"' }
  $xml = @"
<toast duration="long" scenario="reminder"$launchAttr>
  <visual>
    <binding template="ToastGeneric">
      <text>$(& $esc $p.title)</text>
      <text>$(& $esc $p.body)</text>
    </binding>
  </visual>
  <actions>
    <action content="$(& $esc $p.allowText)" activationType="protocol" arguments="$(& $esc $p.allow)" />
    <action content="$(& $esc $p.denyText)" activationType="protocol" arguments="$(& $esc $p.deny)" />
  </actions>
</toast>
"@

  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $toast.Tag = [string]$p.tag
  $toast.Group = 'dsh-approval'

  # The toast header shows the *app name* behind the AUMID, so the only way to read
  # "DSH" instead of "Windows PowerShell" is to own an AUMID, which needs a Start Menu
  # shortcut carrying System.AppUserModel.ID. That shortcut is created once at plugin
  # startup by shortcut.ps1; if it is missing (creation failed) fall back to PowerShell's
  # AUMID, where the toast still works, only mislabelled.
  $appId = $p.appId
  if ($p.aumid -and $p.shortcut -and (Test-Path -LiteralPath $p.shortcut)) { $appId = $p.aumid }

  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  # Echo the AUMID the toast was actually filed under: watch.ps1 must withdraw it from
  # the same AUMID, otherwise History.Remove targets a different app and the toast stays.
  'shown ' + $appId
}
catch {
  'error: ' + $_.Exception.Message
  exit 1
}
