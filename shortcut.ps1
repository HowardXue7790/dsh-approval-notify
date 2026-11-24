# Create the Start Menu shortcut that owns the toast AUMID, so notifications read "DSH"
# instead of "Windows PowerShell". Prints exactly one of: exists | created | error: ...
# Runs at plugin startup (see index.js) instead of on the first toast: nothing here
# depends on a notification ever firing, and the plugin process is not sandboxed.
# ASCII only: Windows PowerShell reads this file without a BOM and would decode
# non-ASCII bytes as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Lnk,
  [string]$AppId = 'Dsh.ApprovalNotify',
  [string]$Icon = ''
)

$ErrorActionPreference = 'Stop'
try {
  if (Test-Path -LiteralPath $Lnk) { 'exists'; exit 0 }

  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace DshToast {
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] public class ShellLinkCoClass { }
[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW {
  void GetPath([MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszFile, int cch, System.IntPtr pfd, uint fFlags);
  void GetIDList(out System.IntPtr ppidl);
  void SetIDList(System.IntPtr pidl);
  void GetDescription([MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszName, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszDir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
  void GetArguments([MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszArgs, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
  void GetHotkey(out short wHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int iShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] System.Text.StringBuilder pszIconPath, int cch, out int iIcon);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
  void Resolve(System.IntPtr hwnd, uint fFlags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  void GetCount(out uint cProps);
  void GetAt(uint iProp, out PROPERTYKEY pkey);
  void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
  void Commit();
}
[StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public System.IntPtr pointerValue; }
public static class AppId {
public static void Create(string lnkPath, string target, string iconPath, string appUserModelId) {
  var link = (IShellLinkW)new ShellLinkCoClass();
  link.SetPath(target);
  link.SetArguments("");
  if (!string.IsNullOrEmpty(iconPath)) link.SetIconLocation(iconPath, 0);
  var key = new PROPERTYKEY();
  key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"); // System.AppUserModel.ID
  key.pid = 5;
  var pv = new PROPVARIANT();
  pv.vt = 31; // VT_LPWSTR
  pv.pointerValue = Marshal.StringToCoTaskMemUni(appUserModelId);
  var store = (IPropertyStore)link;
  store.SetValue(ref key, ref pv);
  store.Commit();
  ((IPersistFile)link).Save(lnkPath, true);
}
}
}
'@

  $target = Join-Path $PSHOME 'powershell.exe'
  if ($Icon -and -not (Test-Path -LiteralPath $Icon)) { $Icon = '' }
  [DshToast.AppId]::Create($Lnk, $target, $Icon, $AppId)
  'created'
}
catch {
  'error: ' + $_.Exception.Message
  exit 1
}
