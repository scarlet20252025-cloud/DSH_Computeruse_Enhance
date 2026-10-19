# 指示器技术尖刺：验证 WPF 能否做到「无边框透明 + 最前端 + 点击穿透 + 不抢焦点」，
# 以及 SetWindowDisplayAffinity 能不能让它**不出现在我们自己的截图里**。
#
# 这两点决定整个指示器方案是否成立：
#   - 抢焦点 = 键盘注入会打进指示器，Computer Use 直接失效；
#   - 出现在截图里 = 模型每张截图都被自己的浮层污染。
#
# 输出：一组 `SPIKE <key> = <value>` 行。
# 约束：Windows PowerShell 5.1 + STA；文件须带 UTF-8 BOM。
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$sig = @'
using System;
using System.Runtime.InteropServices;
public class SpikeNative {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int index, int value);
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x00000020
$WS_EX_NOACTIVATE = 0x08000000
$WS_EX_TOOLWINDOW = 0x00000080
$WDA_NONE = 0x0
$WDA_MONITOR = 0x1
$WDA_EXCLUDEFROMCAPTURE = 0x11

$window = New-Object System.Windows.Window
$window.WindowStyle = [System.Windows.WindowStyle]::None
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.ResizeMode = [System.Windows.ResizeMode]::NoResize
$window.SizeToContent = [System.Windows.SizeToContent]::WidthAndHeight

$border = New-Object System.Windows.Controls.Border
$border.CornerRadius = New-Object System.Windows.CornerRadius(12)
$border.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(245, 255, 255, 255))
$border.BorderThickness = New-Object System.Windows.Thickness(1)
$border.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(40, 15, 23, 42))
$border.Padding = New-Object System.Windows.Thickness(18, 0, 18, 0)
$border.Height = 38

$text = New-Object System.Windows.Controls.TextBlock
$text.Text = 'DSH 正在操作电脑（尖刺）'
$text.FontSize = 13
$text.FontWeight = [System.Windows.FontWeights]::SemiBold
$text.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$border.Child = $text
$window.Content = $border

$window.Add_SourceInitialized({
  $h = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  $ex = [SpikeNative]::GetWindowLong($h, $GWL_EXSTYLE)
  $new = $ex -bor $WS_EX_TRANSPARENT -bor $WS_EX_NOACTIVATE -bor $WS_EX_TOOLWINDOW
  [void][SpikeNative]::SetWindowLong($h, $GWL_EXSTYLE, $new)

  $affinity = [SpikeNative]::SetWindowDisplayAffinity($h, $WDA_EXCLUDEFROMCAPTURE)
  $usedAffinity = $WDA_EXCLUDEFROMCAPTURE
  if (-not $affinity) {
    $affinity = [SpikeNative]::SetWindowDisplayAffinity($h, $WDA_MONITOR)
    $usedAffinity = $WDA_MONITOR
  }
  [Console]::Out.WriteLine("SPIKE hwnd = $h")
  [Console]::Out.WriteLine("SPIKE exstyle_applied = $([bool]($ex -ne $new))")
  [Console]::Out.WriteLine("SPIKE click_through = $([bool](($new -band $WS_EX_TRANSPARENT) -ne 0))")
  [Console]::Out.WriteLine("SPIKE no_activate = $([bool](($new -band $WS_EX_NOACTIVATE) -ne 0))")
  [Console]::Out.WriteLine("SPIKE display_affinity = $usedAffinity (call ok=$affinity)")
})

$window.Add_ContentRendered({
  Start-Sleep -Milliseconds 250

  # 定位：鼠标所在显示器的工作区顶部居中
  $pt = New-Object SpikeNative+POINT
  [void][SpikeNative]::GetCursorPos([ref]$pt)
  $mon = [SpikeNative]::MonitorFromPoint($pt, 2)
  $info = New-Object SpikeNative+MONITORINFO
  $info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
  [void][SpikeNative]::GetMonitorInfo($mon, [ref]$info)
  $w = [int]$window.ActualWidth; $h = [int]$window.ActualHeight
  $window.Left = [Math]::Round($info.rcWork.Left + ($info.rcWork.Right - $info.rcWork.Left - $w) / 2)
  $window.Top = $info.rcWork.Top + 6      # 12 - shadowInset.top(6)
  Start-Sleep -Milliseconds 250

  [Console]::Out.WriteLine("SPIKE window_size = ${w}x${h}")
  [Console]::Out.WriteLine("SPIKE window_pos = $([int]$window.Left),$([int]$window.Top)")
  [Console]::Out.WriteLine("SPIKE topmost = $($window.Topmost)")
  [Console]::Out.WriteLine("SPIKE is_active = $($window.IsActive)")
  $fg = [SpikeNative]::GetForegroundWindow()
  $self = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  [Console]::Out.WriteLine("SPIKE foreground_is_self = $([bool]($fg -eq $self))")

  # 关键：用我们后端同款的 GDI 截图，看指示器会不会被拍进去
  $cx = [int]$window.Left + [int]($w / 2)
  $cy = [int]$window.Top + 20
  $bmp = New-Object System.Drawing.Bitmap(400, 60)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($cx - 200, $cy - 20, 0, 0, $bmp.Size)
  $g.Dispose()
  $lum = 0
  foreach ($x in @(40, 120, 200, 280, 360)) {
    $p = $bmp.GetPixel($x, 30)
    $lum += [int](($p.R + $p.G + $p.B) / 3)
  }
  $avg = [int]($lum / 5)
  [Console]::Out.WriteLine("SPIKE capture_card_luma = $avg")
  # 同一屏的别处（卡片左侧 300px 外）作为背景对照
  $bmp2 = New-Object System.Drawing.Bitmap(200, 60)
  $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
  $g2.CopyFromScreen([Math]::Max(0, $cx - 700), $cy - 20, 0, 0, $bmp2.Size)
  $g2.Dispose()
  $lum2 = 0
  foreach ($x in @(20, 60, 100, 140, 180)) { $p = $bmp2.GetPixel($x, 30); $lum2 += [int](($p.R + $p.G + $p.B) / 3) }
  [Console]::Out.WriteLine("SPIKE capture_bg_luma = $([int]($lum2 / 5))")
  $bmp.Dispose(); $bmp2.Dispose()

  [Console]::Out.WriteLine('SPIKE done = true')
  [Console]::Out.Flush()
  $window.Close()
})

[void]$window.ShowDialog()
