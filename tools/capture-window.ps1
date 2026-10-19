# 只抓某个窗口自身的内容（PrintWindow），不带桌面背景。
#
# 为什么不用 GDI 区域截图：那会把窗口**下面**的桌面内容一起拍进来——预览图会混入
# 用户当时的屏幕内容（实测拍到了游戏 HUD），既不整洁也不该进仓库。
# PrintWindow 让窗口把自己画到内存 DC 上，只有窗口自己的像素。
#
# 用途：tools/indicator-preview.mjs 生成文档预览图。
# 约束：Windows PowerShell 5.1；文件须带 UTF-8 BOM。
param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Backdrop = '',        # 可选：把透明区域合成到该颜色（如 '#FFFFFF'），默认不合成
  [switch]$Client
)

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint PW_RENDERFULLCONTENT = 0x00000002;
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

# 必须在读任何窗口几何之前开启 DPI 感知：150% 缩放下 GetWindowRect 会被虚拟化
# （339x84 变成 226x56），按虚拟尺寸建 DC 会把窗口右侧与底部裁掉。
# 这与 docs/native-protocol.md 里记的是同一个坑。
try { [void][WinShot]::SetProcessDPIAware() } catch { }

$handle = [IntPtr]([Convert]::ToInt64($Hwnd, 16))
if (-not [WinShot]::IsWindowVisible($handle)) { [Console]::Error.WriteLine("window is not visible: $Hwnd"); exit 3 }

$rect = New-Object WinShot+RECT
[void][WinShot]::GetWindowRect($handle, [ref]$rect)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { [Console]::Error.WriteLine("bad window rect: ${width}x${height}"); exit 4 }

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$ok = $false
try {
  $ok = [WinShot]::PrintWindow($handle, $hdc, [WinShot]::PW_RENDERFULLCONTENT)
} finally {
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
}
if (-not $ok) { $bitmap.Dispose(); [Console]::Error.WriteLine('PrintWindow failed'); exit 5 }

if ($Backdrop -ne '') {
  $color = [System.Drawing.ColorTranslator]::FromHtml($Backdrop)
  $composed = New-Object System.Drawing.Bitmap($width, $height)
  $g2 = [System.Drawing.Graphics]::FromImage($composed)
  $g2.Clear($color)
  $g2.DrawImage($bitmap, 0, 0, $width, $height)
  $g2.Dispose()
  $bitmap.Dispose()
  $bitmap = $composed
}

$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
[Console]::Out.WriteLine("WINDOW_SHOT $Out ${width}x${height}")
