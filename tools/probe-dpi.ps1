# DPI 感知验证：确认开启 Per-Monitor DPI Awareness 后，截图像素、SystemInformation.VirtualScreen
# 与 UIA BoundingRectangle 是否落在同一个坐标空间（Computer Use 坐标映射的前提）。
# 约束：Windows PowerShell 5.1 兼容；文件须带 UTF-8 BOM。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$sig = @'
using System;
using System.Runtime.InteropServices;
public class DpiProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$out = [ordered]@{ dpiAwareCall = $null; screens = @(); virtualScreen = $null; foregroundRect = $null; foregroundDpi = $null; uiaFocusedRect = $null; screenshot = $null; errors = @() }

try { $out.dpiAwareCall = [DpiProbe]::SetProcessDPIAware() } catch { $out.errors += "SetProcessDPIAware: $($_.Exception.Message)" }

try {
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $out.screens += [ordered]@{ device = $s.DeviceName; x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
  }
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $out.virtualScreen = [ordered]@{ x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height }
}
catch { $out.errors += "screens: $($_.Exception.Message)" }

try {
  $h = [DpiProbe]::GetForegroundWindow()
  $r = New-Object DpiProbe+RECT
  if ([DpiProbe]::GetWindowRect($h, [ref]$r)) {
    $out.foregroundRect = [ordered]@{ x = $r.Left; y = $r.Top; width = $r.Right - $r.Left; height = $r.Bottom - $r.Top }
  }
  $out.foregroundDpi = [int][DpiProbe]::GetDpiForWindow($h)
}
catch { $out.errors += "foreground: $($_.Exception.Message)" }

try {
  $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $path = Join-Path $env:TEMP 'dsh-cua-dpi.png'
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.screenshot = [ordered]@{ path = $path; width = $bmp.Width; height = $bmp.Height; bytes = (Get-Item $path).Length }
  $bmp.Dispose()
}
catch { $out.errors += "screenshot: $($_.Exception.Message)" }

try {
  $fg = [System.Windows.Automation.AutomationElement]::FocusedElement
  $rc = $fg.Current.BoundingRectangle
  $out.uiaFocusedRect = [ordered]@{ x = [int]$rc.X; y = [int]$rc.Y; width = [int]$rc.Width; height = [int]$rc.Height }
}
catch { $out.errors += "uia: $($_.Exception.Message)" }

$out | ConvertTo-Json -Depth 6 -Compress
