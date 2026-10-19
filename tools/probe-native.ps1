# 原生 Computer Use 四原语可行性探针：截图 / 窗口枚举 / UIA / 输入注入。
# 只做只读探测，不注入任何输入；输出为 JSON。
# 约束：必须兼容 Windows PowerShell 5.1（无 PS7 表达式语法：if/try 不可作表达式、无 ?? 与三目）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$result = [ordered]@{
  psVersion  = $PSVersionTable.PSVersion.ToString()
  is64Bit    = [Environment]::Is64BitProcess
  screens    = @()
  screenshot = $null
  windows    = @()
  uia        = $null
  dpi        = $null
  errors     = @()
}

# 1) 屏幕几何
try {
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $w = $s.WorkingArea
    $result.screens += [ordered]@{
      deviceName = $s.DeviceName
      primary    = $s.Primary
      bounds     = [ordered]@{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
      working    = [ordered]@{ x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height }
    }
  }
}
catch { $result.errors += "screens: $($_.Exception.Message)" }

# 1b) 主屏 DPI（用于坐标换算：UIA/窗口坐标是物理像素，GDI 截图为物理像素）
try {
  $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
  $result.dpi = [ordered]@{ x = $g.DpiX; y = $g.DpiY }
  $g.Dispose()
}
catch { $result.errors += "dpi: $($_.Exception.Message)" }

# 2) 虚拟屏截图
try {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp)
  $g2.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $g2.Dispose()
  $out = Join-Path $env:TEMP 'dsh-cua-probe.png'
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $result.screenshot = [ordered]@{
    path   = $out
    width  = $bmp.Width
    height = $bmp.Height
    bytes  = (Get-Item $out).Length
  }
  $bmp.Dispose()
}
catch { $result.errors += "screenshot: $($_.Exception.Message)" }

# 3) 顶层窗口枚举
try {
  $sig = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  public static List<string[]> List() {
    var rows = new List<string[]>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      if (t.Length == 0) return true;
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      uint pid; GetWindowThreadProcessId(h, out pid);
      rows.Add(new string[]{ h.ToInt64().ToString(), pid.ToString(), t.ToString(), c.ToString(), (h == fg) ? "1" : "0" });
      return true;
    }, IntPtr.Zero);
    return rows;
  }
}
'@
  Add-Type -TypeDefinition $sig -Language CSharp
  foreach ($r in [WinEnum]::List()) {
    $pname = '?'
    try { $pname = (Get-Process -Id ([int]$r[1]) -ErrorAction Stop).ProcessName }
    catch { }
    $fgFlag = $false
    if ($r[4] -eq '1') { $fgFlag = $true }
    $result.windows += [ordered]@{
      hwnd       = $r[0]
      pid        = [int]$r[1]
      process    = $pname
      title      = $r[2]
      className  = $r[3]
      foreground = $fgFlag
    }
  }
}
catch { $result.errors += "windows: $($_.Exception.Message)" }

# 4) UIA：读前台窗口的元素树
try {
  $fg = [System.Windows.Automation.AutomationElement]::FocusedElement
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $root = $walker.GetParent($fg)
  $children = New-Object System.Collections.ArrayList
  $focusedName = ''
  $focusedType = ''
  try { $focusedName = $fg.Current.Name } catch { }
  try { $focusedType = $fg.Current.ControlType.ProgrammaticName } catch { }
  $rootName = ''
  if ($root) {
    try { $rootName = $root.Current.Name } catch { }
    $child = $walker.GetFirstChild($root)
    $n = 0
    while ($child -and $n -lt 12) {
      $n++
      $cname = ''
      $ct = ''
      $cb = $null
      try { $cname = $child.Current.Name } catch { }
      try { $ct = $child.Current.ControlType.ProgrammaticName } catch { }
      try {
        $rc = $child.Current.BoundingRectangle
        $cb = [ordered]@{ x = [int]$rc.X; y = [int]$rc.Y; width = [int]$rc.Width; height = [int]$rc.Height }
      }
      catch { }
      [void]$children.Add([ordered]@{ name = $cname; controlType = $ct; bounds = $cb })
      $child = $walker.GetNextSibling($child)
    }
  }
  $result.uia = [ordered]@{
    focusedName = $focusedName
    focusedType = $focusedType
    rootName    = $rootName
    childCount  = $children.Count
    children    = $children
  }
}
catch { $result.errors += "uia: $($_.Exception.Message)" }

$result | ConvertTo-Json -Depth 8 -Compress
