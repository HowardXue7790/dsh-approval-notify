# While a toast is up, watch the foreground window. The moment the DSH window comes
# back to the front, take the toast away and print `focused` so the caller can hand the
# request over to the in-app card. Prints `timeout` if it never happens.
# ASCII only (Windows PowerShell reads this without a BOM).
param(
  [Parameter(Mandatory = $true)][string]$FocusExe,
  [Parameter(Mandatory = $true)][string]$AppId,
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$Group,
  [int]$TimeoutMs = 300000
)

$ErrorActionPreference = 'Stop'
Add-Type -Namespace DshNotify2 -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int pid);
'@

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
while ([DateTime]::UtcNow -lt $deadline) {
  Start-Sleep -Milliseconds 500
  $hwnd = [DshNotify2.Win]::GetForegroundWindow()
  $targetPid = 0
  [void][DshNotify2.Win]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
  if ($targetPid -le 0) { continue }
  $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
  if ($proc -and ($proc.ProcessName -ieq $FocusExe)) {
    try {
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($Tag, $Group, $AppId)
    } catch { }
    'focused'
    exit 0
  }
}
'timeout'
