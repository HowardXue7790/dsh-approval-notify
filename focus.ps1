param([string]$ProcessName = 'DSH NEXT')

$ErrorActionPreference = 'Continue'

# Raise the DSH window the way a taskbar click would. SwitchToThisWindow was tried
# first and it *hid* the window (Electron parked it in the tray), so this only uses
# the top-most toggle + SetForegroundWindow, which lifts a window whose owner has no
# foreground rights. A result of no-window means DSH is hidden in the tray, which no
# window call can undo -- only DSH's own tray click can.
Add-Type -Namespace DshFocus -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
'@

try {
  $target = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Where-Object { [DshFocus.Win]::IsWindowVisible($_.MainWindowHandle) -and [DshFocus.Win]::GetWindowTextLength($_.MainWindowHandle) -gt 0 } |
    Select-Object -First 1
  if (-not $target) { 'no-window'; exit 0 }

  $hWnd = [IntPtr]$target.MainWindowHandle
  if ([DshFocus.Win]::IsIconic($hWnd)) {
    [void][DshFocus.Win]::ShowWindowAsync($hWnd, 9)   # SW_RESTORE
  } else {
    [void][DshFocus.Win]::ShowWindowAsync($hWnd, 5)   # SW_SHOW
  }
  $flags = 0x0002 -bor 0x0001                                  # SWP_NOMOVE | SWP_NOSIZE
  [void][DshFocus.Win]::SetWindowPos($hWnd, [IntPtr](-1), 0, 0, 0, 0, $flags)   # HWND_TOPMOST
  [void][DshFocus.Win]::SetWindowPos($hWnd, [IntPtr](-2), 0, 0, 0, 0, $flags)   # HWND_NOTOPMOST
  [void][DshFocus.Win]::BringWindowToTop($hWnd)
  [void][DshFocus.Win]::SetForegroundWindow($hWnd)
  'shown'
} catch {
  'error: ' + $_.Exception.Message
  exit 1
}
