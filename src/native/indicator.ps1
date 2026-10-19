# dsh-computer-use Windows 置顶操作指示器（协议 dsh-cua-indicator/1）。
#
# 宿主：powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File src/native/indicator.ps1
# 本文件必须保存为 **UTF-8 with BOM**：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI 读，
# 中文注释会破坏语法解析。
#
# 这个浮层在向用户声明「DSH 正在操作电脑」，所以它只有两个合格状态：**如实显示**或**如实消失**。
# 以下四点缺一不可（尖刺 tools/spike-indicator.ps1 实测确认）：
#   1) WPF 无边框透明窗：WindowStyle=None + AllowsTransparency + Background=Transparent + SizeToContent；
#   2) 窗口句柄创建后手工追加 WS_EX_TRANSPARENT|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW
#      —— 点击穿透 / 不抢焦点 / 不进任务栏，WPF 没有等价属性；
#   3) SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) —— 不污染模型自己的截图；
#   4) 定位后必须重新声明 Topmost：隐藏过的透明窗会被清掉 WS_EX_TOPMOST。
#
# 线程模型：主线程只跑 WPF Dispatcher（动画与计时器需要消息泵），stdin 由 C# 后台线程读、
# DispatcherTimer 轮询取行，请求处理全部在 UI 线程上串行执行。这样「动画进行中仍能处理下一条
# 请求」与「响应必须晚于离场动画完成」两个要求同时成立，且不需要 Start-Sleep 阻塞主循环。
#
# 铁律（与 cua.ps1 同构）：
#   1) stdout 只允许出现 NDJSON 协议行，诊断一律走 stderr；
#   2) 任何未接住的函数返回值都会进 stdout，所以调用一律 `[void]` / `$null =` / `| Out-Null`；
#   3) 单条请求的任何异常都必须转成失败响应，进程不得退出。

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
  try { [Console]::InputEncoding = $utf8 } catch { }
} catch {
  try { [Console]::Error.WriteLine('indicator: encoding setup failed: ' + $_.Exception.Message) } catch { }
}

function Write-Diag([string]$msg) {
  # 不带 `[indicator]` 前缀：调用方（src/indicator.js）已经给每条诊断加了来源标注，
  # 这层再加一次会打出 `[indicator] [indicator] ready: ...`。
  try { [Console]::Error.WriteLine($msg) } catch { }
}

# ---------------------------------------------------------------------------
# 规格常量（照上游 windowsCuaOperationIndicatorContent.ts）
# ---------------------------------------------------------------------------
$script:protocolName = 'dsh-cua-indicator/1'
$script:defaultText = 'DSH 正在操作电脑'
$script:cardHeight = 38
$script:cardRadius = 12
$script:cardPadX = 18
$script:cardFontSize = 13
$script:cardTopOffset = 12          # 工作区顶部 + 12px
$script:shadowInsetTop = 6          # 窗口相对卡片的上留白（= 12 - 6）
$script:shadowInsetRight = 8
$script:shadowInsetBottom = 12
$script:shadowInsetLeft = 8
$script:enterMs = 140
$script:leaveMs = 120
$script:autoHideMs = 30000
$script:dotSize = 4
$script:dotGap = 3
$script:dotTextGap = 10
$script:pulseMs = 1200
$script:pulseDelayMs = 120

# ---------------------------------------------------------------------------
# 原生互操作 + stdin 读取器
# ---------------------------------------------------------------------------
$script:nativeReady = $false
$script:nativeError = 'native bootstrap failed'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class IndicatorNative {
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOPMOST = 0x00000008;
  public const int WS_EX_TRANSPARENT = 0x00000020;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_NOACTIVATE = 0x08000000;
  public const uint WDA_NONE = 0x0;
  public const uint WDA_MONITOR = 0x1;
  public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;

  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOACTIVATE = 0x0010;

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }

  public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLongW(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLongW(IntPtr h, int index, int value);
  [DllImport("user32.dll")] static extern bool SetWindowDisplayAffinity(IntPtr h, uint affinity);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsProcessDPIAware();

  // 追加指示器必需的三条扩展样式，返回生效后的实际 ex-style（调用方按位回读，不写死）。
  public static int ApplyIndicatorStyles(IntPtr h) {
    int ex = GetWindowLongW(h, GWL_EXSTYLE);
    int next = ex | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
    if (next != ex) { SetWindowLongW(h, GWL_EXSTYLE, next); }
    return GetWindowLongW(h, GWL_EXSTYLE);
  }

  public static int ExStyle(IntPtr h) { return GetWindowLongW(h, GWL_EXSTYLE); }
  public static bool IsTopmost(IntPtr h) { return ((GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0); }
  public static bool IsClickThrough(IntPtr h) { return ((GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_TRANSPARENT) != 0); }
  public static bool IsNoActivate(IntPtr h) { return ((GetWindowLongW(h, GWL_EXSTYLE) & WS_EX_NOACTIVATE) != 0); }
  public static bool IsVisible(IntPtr h) { return IsWindowVisible(h); }

  // 成功返回实际使用的 affinity 值（0x11 优先，失败回退 0x1），全失败返回 0。
  // 0 的语义要分清：可能是「调用失败」，也可能是调用方**故意**要求可截取（文档预览）。
  public static int SetCaptureAffinity(IntPtr h) {
    try {
      if (SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE)) { return (int)WDA_EXCLUDEFROMCAPTURE; }
      if (SetWindowDisplayAffinity(h, WDA_MONITOR)) { return (int)WDA_MONITOR; }
    } catch { }
    return 0;
  }

  public static bool MoveTopmost(IntPtr h, int x, int y) {
    return SetWindowPos(h, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE);
  }

  public static bool AssertTopmost(IntPtr h) {
    return SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  // int[4] = { x, y, width, height }；失败返回 null。
  public static int[] WindowRect(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) { return null; }
    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
  }

  // int[4] = 鼠标所在显示器的工作区 { x, y, width, height }。
  public static int[] CursorWorkArea() {
    POINT p;
    if (!GetCursorPos(out p)) { return new int[] { 0, 0, 1, 1 }; }
    IntPtr mon = MonitorFromPoint(p, 2);   // MONITOR_DEFAULTTONEAREST
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (mon == IntPtr.Zero || !GetMonitorInfo(mon, ref mi)) { return new int[] { 0, 0, 1, 1 }; }
    return new int[] {
      mi.rcWork.Left, mi.rcWork.Top,
      mi.rcWork.Right - mi.rcWork.Left, mi.rcWork.Bottom - mi.rcWork.Top
    };
  }

  public static int MonitorCount() {
    int n = 0;
    try {
      MonitorEnumProc cb = delegate(IntPtr m, IntPtr dc, ref RECT r, IntPtr d) { n++; return true; };
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
      GC.KeepAlive(cb);
    } catch { }
    return n;
  }
}

// stdin 行读取器：在 C# 后台线程上阻塞读管道，按 LF 切行入队。
// 放在 C# 里而不是 PowerShell 里，是因为 PowerShell 的 scriptblock 无法在没有 Runspace 的
// 后台线程上执行（"There is no Runspace available to run scripts in this thread"）。
public class IndicatorStdin {
  readonly object gate = new object();
  readonly Queue<string> lines = new Queue<string>();
  readonly StringBuilder pending = new StringBuilder();
  readonly Decoder decoder = new UTF8Encoding(false).GetDecoder();
  readonly char[] chars = new char[8192];
  Stream stream;
  volatile bool eof;

  public bool Eof { get { return eof; } }

  public void Start(Stream s) {
    stream = s;
    Thread t = new Thread(new ThreadStart(ReadLoop));
    t.IsBackground = true;
    t.Name = "indicator-stdin";
    t.Start();
  }

  void ReadLoop() {
    byte[] buf = new byte[4096];
    while (true) {
      int n = 0;
      try { n = stream.Read(buf, 0, buf.Length); } catch { n = 0; }
      if (n <= 0) { break; }
      int nc = 0;
      try { nc = decoder.GetChars(buf, 0, n, chars, 0); } catch { nc = 0; }
      if (nc <= 0) { continue; }
      lock (gate) {
        pending.Append(chars, 0, nc);
        Extract();
      }
    }
    lock (gate) {
      Extract();
      if (pending.Length > 0) {
        lines.Enqueue(pending.ToString());
        pending.Length = 0;
      }
      eof = true;
    }
  }

  // 调用方已持锁。
  void Extract() {
    string s = pending.ToString();
    int idx = s.IndexOf('\n');
    while (idx >= 0) {
      string line = s.Substring(0, idx);
      if (line.EndsWith("\r")) { line = line.Substring(0, line.Length - 1); }
      lines.Enqueue(line);
      s = s.Substring(idx + 1);
      idx = s.IndexOf('\n');
    }
    pending.Length = 0;
    pending.Append(s);
  }

  // 没有整行时返回 null。
  public string NextLine() {
    lock (gate) {
      if (lines.Count > 0) { return lines.Dequeue(); }
    }
    return null;
  }
}
'@ -Language CSharp | Out-Null
  $script:nativeReady = $true
} catch {
  $script:nativeError = $_.Exception.Message
  Write-Diag ('Add-Type failed: ' + $script:nativeError)
  [Console]::Error.WriteLine($_.Exception.ToString())
}

if (-not $script:nativeReady) {
  $esc = ([string]$script:nativeError).Replace('\', '\\').Replace('"', '\"').Replace("`r", ' ').Replace("`n", ' ')
  [Console]::Out.Write('{"id":null,"ok":false,"event":"ready","error":{"code":"INTERNAL","message":"native bootstrap failed: ' + $esc + '","details":{}}}')
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
  exit 2
}

# DPI：必须在任何窗口/屏幕 API 之前调用，否则进程被 DPI 虚拟化，
# 定位（物理像素）与截图（物理像素）会落在两个坐标空间。
$script:dpiAware = $false
try {
  [void][IndicatorNative]::SetProcessDPIAware()
  $script:dpiAware = [IndicatorNative]::IsProcessDPIAware()
} catch {
  Write-Diag ('SetProcessDPIAware failed: ' + $_.Exception.Message)
}

$wpfReady = $false
try {
  Add-Type -AssemblyName PresentationFramework | Out-Null
  Add-Type -AssemblyName PresentationCore | Out-Null
  Add-Type -AssemblyName WindowsBase | Out-Null
  $wpfReady = $true
} catch {
  Write-Diag ('WPF assembly load failed: ' + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 协议I/O
# ---------------------------------------------------------------------------
function Send-Line([string]$json) {
  if ($null -eq $json) { $json = '{}' }
  $one = $json.Replace("`r", '').Replace("`n", '')
  # 协议要求以 \n 结尾；WriteLine 在 Windows 上会写 CRLF，所以手工写 LF。
  [Console]::Out.Write($one)
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
}

function Send-Object($obj) {
  $json = $null
  try { $json = $obj | ConvertTo-Json -Depth 12 -Compress } catch { $json = $null }
  if ([string]::IsNullOrEmpty($json)) {
    $json = '{"id":null,"ok":false,"error":{"code":"INTERNAL","message":"JSON serialization failed","details":{}}}'
  }
  Send-Line $json
}

function Respond-Ok($id, $data) {
  $payload = [ordered]@{ id = $id; ok = $true; data = $data }
  Send-Object $payload
}

function Respond-Err($id, [string]$code, [string]$message, $details) {
  if ($null -eq $details) { $details = [ordered]@{} }
  $payload = [ordered]@{
    id = $id
    ok = $false
    error = [ordered]@{ code = $code; message = $message; details = $details }
  }
  Send-Object $payload
}

function Fail([string]$code, [string]$message, $details) {
  $ex = New-Object System.Exception($message)
  $ex.Data['indicatorCode'] = $code
  if ($null -ne $details) { $ex.Data['indicatorDetails'] = $details }
  throw $ex
}

function Get-Arg($obj, [string]$name, $default) {
  if ($null -eq $obj) { return $default }
  $prop = $null
  try { $prop = $obj.PSObject.Properties[$name] } catch { $prop = $null }
  if ($null -eq $prop) { return $default }
  $v = $prop.Value
  if ($null -eq $v) { return $default }
  return $v
}

function Get-StrArg($obj, [string]$name, [string]$default) {
  $raw = Get-Arg $obj $name $null
  if ($null -eq $raw) { return $default }
  $s = [string]$raw
  if ($s.Length -eq 0) { return $default }
  return $s
}

function Limit-Text([string]$s, [int]$max) {
  if ($null -eq $s) { return '' }
  $t = $s.Replace("`r", ' ').Replace("`n", ' ').Replace('"', "'")
  if ($t.Length -gt $max) { $t = $t.Substring(0, $max) + '...' }
  return $t
}

function Format-Hwnd($hwnd) {
  if ($null -eq $hwnd) { return $null }
  $v = [int64]0
  try {
    $h = [System.IntPtr]$hwnd
    if ($h -eq [System.IntPtr]::Zero) { return $null }
    $v = $h.ToInt64()
  } catch {
    return $null
  }
  if ($v -eq 0) { return $null }
  return ('0x{0:x8}' -f $v)
}

# ---------------------------------------------------------------------------
# 状态
# ---------------------------------------------------------------------------
$script:psVersion = $PSVersionTable.PSVersion.ToString()
$script:monitorCount = 0
try { $script:monitorCount = [IndicatorNative]::MonitorCount() } catch { $script:monitorCount = 0 }

$script:window = $null            # System.Windows.Window
$script:card = $null              # 圆角卡片 Border
$script:textBlock = $null
$script:translate = $null         # 卡片 TranslateTransform（进场/离场）
$script:dots = @()
$script:dotScales = @()
$script:hwnd = [System.IntPtr]::Zero
$script:windowShown = $false
$script:currentText = $script:defaultText
$script:affinityApplied = $false
$script:affinityUsed = 0
# 周期重申置顶的节拍计数（pollTick 是 15ms 一轮，67 轮 ≈ 1s）。
$script:topmostTickCounter = 0
$script:lightTheme = $true
$script:shouldExit = $false
$script:busy = $false
$script:reader = $null
$script:pollTimer = $null
$script:autoHideTimer = $null
$script:cmdResult = $null

# ---------------------------------------------------------------------------
# 主题（每次 show/update 重新判定；读不到按浅色）
# ---------------------------------------------------------------------------
function Test-LightTheme {
  # 调试/文档用覆盖：`DSH_CUA_INDICATOR_THEME=dark|light`。
  # 存在的理由：深色分支否则无法验证——去改用户的系统主题是不可接受的副作用。
  $forced = $env:DSH_CUA_INDICATOR_THEME
  if ($forced -eq 'dark') { return $false }
  if ($forced -eq 'light') { return $true }

  $light = $true
  try {
    $item = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
    if ($null -ne $item) {
      $raw = $null
      try { $raw = $item.PSObject.Properties['AppsUseLightTheme'] } catch { $raw = $null }
      if ($null -ne $raw -and $null -ne $raw.Value) {
        $light = ([int]$raw.Value -ne 0)
      }
    }
  } catch {
    $light = $true
  }
  return $light
}

function New-Brush([int]$a, [int]$r, [int]$g, [int]$b) {
  return (New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb($a, $r, $g, $b)))
}

function Apply-Theme {
  $light = Test-LightTheme
  $script:lightTheme = $light
  if ($light) {
    $script:card.Background = New-Brush 245 255 255 255        # rgba(255,255,255,0.96)
    $script:card.BorderBrush = New-Brush 36 15 23 42           # rgba(15,23,42,0.14)
    $script:textBlock.Foreground = New-Brush 255 32 33 36      # #202124
    foreach ($d in $script:dots) { $d.Fill = New-Brush 255 100 116 139 }
  } else {
    $script:card.Background = New-Brush 245 35 38 43           # rgba(35,38,43,0.96)
    $script:card.BorderBrush = New-Brush 36 255 255 255        # rgba(255,255,255,0.14)
    $script:textBlock.Foreground = New-Brush 255 248 250 252   # #f8fafc
    foreach ($d in $script:dots) { $d.Fill = New-Brush 255 168 179 196 }
  }
}

# ---------------------------------------------------------------------------
# 动画
# ---------------------------------------------------------------------------
function New-Ease {
  $ease = New-Object System.Windows.Media.Animation.CubicEase
  $ease.EasingMode = [System.Windows.Media.Animation.EasingMode]::EaseOut
  return $ease
}

function Start-EnterAnimation {
  try {
    $span = [TimeSpan]::FromMilliseconds($script:enterMs)
    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.From = 0.0
    $fade.To = 1.0
    $fade.Duration = New-Object System.Windows.Duration($span)
    # 基值就是终态（Opacity=1 / Y=0），Stop 收尾不会跳变。
    $fade.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::Stop
    $fade.EasingFunction = New-Ease
    [void]$script:card.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)

    $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
    $slide.From = -6.0
    $slide.To = 0.0
    $slide.Duration = New-Object System.Windows.Duration($span)
    $slide.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::Stop
    $slide.EasingFunction = New-Ease
    [void]$script:translate.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $slide)
  } catch {
    Write-Diag ('enter animation failed: ' + $_.Exception.Message)
  }
}

function Start-LeaveAnimation {
  try {
    $span = [TimeSpan]::FromMilliseconds($script:leaveMs)
    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation
    $fade.From = 1.0
    $fade.To = 0.0
    $fade.Duration = New-Object System.Windows.Duration($span)
    # HoldEnd：动画结束后保持透明，直到窗口隐藏完成后再复位，避免收尾闪一帧。
    $fade.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::HoldEnd
    $fade.EasingFunction = New-Ease
    [void]$script:card.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $fade)

    $slide = New-Object System.Windows.Media.Animation.DoubleAnimation
    $slide.From = 0.0
    $slide.To = -6.0
    $slide.Duration = New-Object System.Windows.Duration($span)
    $slide.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::HoldEnd
    $slide.EasingFunction = New-Ease
    [void]$script:translate.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $slide)
  } catch {
    Write-Diag ('leave animation failed: ' + $_.Exception.Message)
  }
}

function Reset-CardVisual {
  try {
    [void]$script:card.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
    [void]$script:translate.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
    $script:card.Opacity = 1.0
    $script:translate.Y = 0.0
  } catch {
    Write-Diag ('card visual reset failed: ' + $_.Exception.Message)
  }
}

function New-LinearKeyFrame([double]$value, [double]$percent) {
  return (New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame($value, [System.Windows.Media.Animation.KeyTime]::FromPercent($percent)))
}

function Start-PulseAnimation($shape, $scale, [int]$delayMs) {
  try {
    $span = [TimeSpan]::FromMilliseconds($script:pulseMs)
    # 上游 CSS：0%,70%,100% { opacity:.35; scale:.8 } / 35% { opacity:1; scale:1 }
    # 每个 KeyTime 必须有自己的关键帧实例：同一个 Freezable 复用到不同 KeyTime 上，
    # 只会保留它自带的那一个时间点，动画会退化成常量。
    $opacity = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
    $opacity.Duration = New-Object System.Windows.Duration($span)
    $opacity.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    if ($delayMs -gt 0) { $opacity.BeginTime = [TimeSpan]::FromMilliseconds($delayMs) }
    [void]$opacity.KeyFrames.Add((New-LinearKeyFrame 0.35 0.0))
    [void]$opacity.KeyFrames.Add((New-LinearKeyFrame 1.0 0.35))
    [void]$opacity.KeyFrames.Add((New-LinearKeyFrame 0.35 0.7))
    [void]$opacity.KeyFrames.Add((New-LinearKeyFrame 0.35 1.0))
    [void]$shape.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $opacity)

    $grow = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
    $grow.Duration = New-Object System.Windows.Duration($span)
    $grow.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
    if ($delayMs -gt 0) { $grow.BeginTime = [TimeSpan]::FromMilliseconds($delayMs) }
    [void]$grow.KeyFrames.Add((New-LinearKeyFrame 0.8 0.0))
    [void]$grow.KeyFrames.Add((New-LinearKeyFrame 1.0 0.35))
    [void]$grow.KeyFrames.Add((New-LinearKeyFrame 0.8 0.7))
    [void]$grow.KeyFrames.Add((New-LinearKeyFrame 0.8 1.0))
    [void]$scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $grow)
    [void]$scale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $grow)
  } catch {
    Write-Diag ('pulse animation failed: ' + $_.Exception.Message)
  }
}

# ---------------------------------------------------------------------------
# 窗口构建
# ---------------------------------------------------------------------------
function New-IndicatorWindow {
  $script:window = $null
  $script:card = $null
  $script:textBlock = $null
  $script:hwnd = [System.IntPtr]::Zero
  $script:windowShown = $false
  $script:affinityApplied = $false
  $script:affinityUsed = 0
  $script:dots = @()

  # 脉冲动画在窗口构建末尾统一开跑（关键帧实例在 Start-PulseAnimation 里逐个新建）
  $window = New-Object System.Windows.Window
  $window.WindowStyle = [System.Windows.WindowStyle]::None
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowInTaskbar = $false
  $window.ShowActivated = $false
  $window.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $window.SizeToContent = [System.Windows.SizeToContent]::WidthAndHeight

  $translate = New-Object System.Windows.Media.TranslateTransform(0, 0)

  $card = New-Object System.Windows.Controls.Border
  $card.Height = $script:cardHeight
  $card.CornerRadius = New-Object System.Windows.CornerRadius($script:cardRadius)
  $card.BorderThickness = New-Object System.Windows.Thickness(1)
  $card.Padding = New-Object System.Windows.Thickness($script:cardPadX, 0, $script:cardPadX, 0)
  $card.RenderTransform = $translate

  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 12
  $shadow.ShadowDepth = 1
  $shadow.Direction = 270
  $shadow.Opacity = 0.18
  $shadow.Color = [System.Windows.Media.Color]::FromRgb(15, 23, 42)
  $card.Effect = $shadow

  $row = New-Object System.Windows.Controls.StackPanel
  $row.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $row.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

  $dots = New-Object System.Windows.Controls.StackPanel
  $dots.Orientation = [System.Windows.Controls.Orientation]::Horizontal
  $dots.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

  $dotList = New-Object System.Collections.ArrayList
  $scaleList = New-Object System.Collections.ArrayList
  $i = 0
  while ($i -lt 3) {
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = $script:dotSize
    $dot.Height = $script:dotSize
    $dot.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
    $scale = New-Object System.Windows.Media.ScaleTransform(0.8, 0.8)
    $scale.CenterX = $script:dotSize / 2
    $scale.CenterY = $script:dotSize / 2
    $dot.RenderTransform = $scale
    $gap = $script:dotGap
    if ($i -eq 2) { $gap = $script:dotTextGap }
    $dot.Margin = New-Object System.Windows.Thickness(0, 0, $gap, 0)
    [void]$dots.Children.Add($dot)
    [void]$dotList.Add($dot)
    [void]$scaleList.Add($scale)
    $i++
  }

  $textBlock = New-Object System.Windows.Controls.TextBlock
  $textBlock.Text = $script:currentText
  $textBlock.FontSize = $script:cardFontSize
  $textBlock.FontWeight = [System.Windows.FontWeights]::SemiBold
  $textBlock.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Variable, Segoe UI')
  $textBlock.TextWrapping = [System.Windows.TextWrapping]::NoWrap
  $textBlock.VerticalAlignment = [System.Windows.VerticalAlignment]::Center

  [void]$row.Children.Add($dots)
  [void]$row.Children.Add($textBlock)
  $card.Child = $row

  # 外层只负责给阴影留透明边距：窗口 = 卡片 + 左右 8、上 6 / 下 12。
  $outer = New-Object System.Windows.Controls.Border
  $outer.Background = [System.Windows.Media.Brushes]::Transparent
  $outer.Margin = New-Object System.Windows.Thickness($script:shadowInsetLeft, $script:shadowInsetTop, $script:shadowInsetRight, $script:shadowInsetBottom)
  $outer.Child = $card
  $window.Content = $outer

  $script:window = $window
  $script:card = $card
  $script:textBlock = $textBlock
  $script:translate = $translate
  $script:dots = $dotList.ToArray()

  # 先建句柄但不显示：这样在首次 show 之前就能套上扩展样式 / display affinity，
  # 并且第一次 SetWindowPos 与 Show() 落在同一个 dispatcher 回调里（不闪）。
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
  $hwnd = $helper.EnsureHandle()
  $script:hwnd = $hwnd

  $script:window.Add_SourceInitialized({
    try { Sync-NativeStyles } catch { Write-Diag ('source init styles failed: ' + $_.Exception.Message) }
  })

  Apply-Theme
  Sync-NativeStyles

  $d = 0
  foreach ($dot in $script:dots) {
    Start-PulseAnimation $dot $scaleList[$d] ($d * $script:pulseDelayMs)
    $d++
  }
  return
}

# ---------------------------------------------------------------------------
# 原生样式 / 布局 / 定位
# ---------------------------------------------------------------------------
function Sync-NativeStyles {
  if ($script:hwnd -eq [System.IntPtr]::Zero) { return }
  try { [void][IndicatorNative]::ApplyIndicatorStyles($script:hwnd) } catch { Write-Diag ('ex-style apply failed: ' + $_.Exception.Message) }
  # 文档/调试开关：`DSH_CUA_INDICATOR_CAPTURABLE=1` 时**故意**不设 capture affinity，
  # 让这份代码本身能被截图（tools/indicator-preview.mjs 用它产出 README 预览图）。
  # 生产路径永远不设这个变量，因此浮窗照旧不进任何截图。
  # 此时如实回报 `excludedFromCapture=false` —— 说谎比不可截取更糟。
  if ($env:DSH_CUA_INDICATOR_CAPTURABLE -eq '1') {
    $script:affinityApplied = $false
    $script:affinityUsed = 0
    return
  }
  if (-not $script:affinityApplied) {
    try {
      $used = [IndicatorNative]::SetCaptureAffinity($script:hwnd)
      if ($used -gt 0) {
        $script:affinityUsed = $used
        $script:affinityApplied = $true
      }
    } catch {
      Write-Diag ('display affinity failed: ' + $_.Exception.Message)
    }
  }
}

function Sync-Layout {
  if ($null -eq $script:window) { return }
  try { $script:window.UpdateLayout() } catch { Write-Diag ('UpdateLayout failed: ' + $_.Exception.Message) }
  $attempt = 0
  while ($attempt -lt 4) {
    $cw = 0.0
    try { $cw = [double]$script:card.ActualWidth } catch { $cw = 0.0 }
    if ($cw -gt 0) { break }
    # 布局还没落地：让 dispatcher 把 Render 优先级以上的队列跑完（不是 Start-Sleep，消息泵仍在转）。
    try {
      [void][System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([System.Windows.Threading.DispatcherPriority]::Background, [action]{ })
    } catch {
      Write-Diag ('layout flush failed: ' + $_.Exception.Message)
      break
    }
    try { $script:window.UpdateLayout() } catch { }
    $attempt++
  }
}

function Position-Indicator {
  if ($script:hwnd -eq [System.IntPtr]::Zero) { return }
  $rect = $null
  try { $rect = [IndicatorNative]::WindowRect($script:hwnd) } catch { $rect = $null }
  if ($null -eq $rect) { return }
  $w = [int]$rect[2]
  $work = [IndicatorNative]::CursorWorkArea()
  $workLeft = [int]$work[0]
  $workTop = [int]$work[1]
  $workWidth = [int]$work[2]
  $x = [int][Math]::Round([double]$workLeft + ([double]$workWidth - [double]$w) / 2.0)
  $y = [int]($workTop + $script:cardTopOffset - $script:shadowInsetTop)
  try { [void][IndicatorNative]::MoveTopmost($script:hwnd, $x, $y) } catch { Write-Diag ('SetWindowPos failed: ' + $_.Exception.Message) }
}

function Assert-Topmost {
  if ($null -eq $script:window) { return }
  # 上游注释：隐藏过的透明窗可能被清掉 WS_EX_TOPMOST，show 之后必须重新声明层级，
  # 所以这里不依赖 Topmost 依赖属性的旧值，直接再走一次 SetWindowPos(HWND_TOPMOST)。
  try { $script:window.Topmost = $true } catch { }
  if ($script:hwnd -eq [System.IntPtr]::Zero) { return }
  try { [void][IndicatorNative]::AssertTopmost($script:hwnd) } catch { Write-Diag ('topmost assert failed: ' + $_.Exception.Message) }
}

# ---------------------------------------------------------------------------
# 事实回报（全部从真实窗口状态读回，不写死）
# ---------------------------------------------------------------------------
function Get-Facts {
  $visible = $false
  $topmost = $false
  $clickThrough = $false
  $noActivate = $false
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($script:hwnd -ne [System.IntPtr]::Zero) {
    try {
      $visible = [bool][IndicatorNative]::IsVisible($script:hwnd)
      $topmost = [bool][IndicatorNative]::IsTopmost($script:hwnd)
      $clickThrough = [bool][IndicatorNative]::IsClickThrough($script:hwnd)
      $noActivate = [bool][IndicatorNative]::IsNoActivate($script:hwnd)
      $rect = [IndicatorNative]::WindowRect($script:hwnd)
      if ($null -ne $rect) {
        $x = [int]$rect[0]; $y = [int]$rect[1]; $w = [int]$rect[2]; $h = [int]$rect[3]
      }
    } catch {
      Write-Diag ('fact read failed: ' + $_.Exception.Message)
    }
  }
  return [ordered]@{
    visible = $visible
    text = [string]$script:currentText
    width = $w
    height = $h
    x = $x
    y = $y
    topmost = $topmost
    clickThrough = $clickThrough
    noActivate = $noActivate
    excludedFromCapture = [bool]$script:affinityApplied
    affinity = [int]$script:affinityUsed
    hwnd = (Format-Hwnd $script:hwnd)
  }
}

# ---------------------------------------------------------------------------
# 显示 / 更新 / 隐藏
# ---------------------------------------------------------------------------
function Restart-AutoHide {
  if ($null -eq $script:autoHideTimer) { return }
  try {
    $script:autoHideTimer.Stop()
    $script:autoHideTimer.Start()
  } catch {
    Write-Diag ('auto hide timer failed: ' + $_.Exception.Message)
  }
}

function Present-Indicator([string]$text, [bool]$ensureVisible) {
  if ($null -eq $script:window) { $null = New-IndicatorWindow }
  if ($null -eq $script:window) { Fail 'INTERNAL' 'Indicator window is unavailable' @{} }
  $script:currentText = $text
  Apply-Theme
  $script:textBlock.Text = $text
  Sync-NativeStyles

  $becameVisible = $false
  if ($ensureVisible -and (-not $script:windowShown)) {
    [void]$script:window.Show()
    $script:windowShown = $true
    $becameVisible = $true
  }

  Sync-Layout
  Position-Indicator
  Assert-Topmost
  if ($becameVisible) { Start-EnterAnimation }
  Restart-AutoHide
}

function Destroy-IndicatorWindow {
  try { if ($null -ne $script:window) { $script:window.Close() } } catch { Write-Diag ('window close failed: ' + $_.Exception.Message) }
  $script:window = $null
  $script:card = $null
  $script:textBlock = $null
  $script:translate = $null
  $script:dots = @()
  $script:hwnd = [System.IntPtr]::Zero
  $script:windowShown = $false
  $script:affinityApplied = $false
  $script:affinityUsed = 0
}

function Hide-IndicatorWindow {
  # 关闭是这个浮层的安全底线：它在声称「DSH 正在操作电脑」，隐藏失败就等于向用户撒谎。
  # 所以 hide 抛错时降级为销毁窗口，宁可下次重建也不留一个说不清的浮层。
  $failed = $false
  try {
    $script:window.Hide()
  } catch {
    $failed = $true
    Write-Diag ('window hide failed, destroying: ' + $_.Exception.Message)
  }
  $script:windowShown = $false
  if ($failed) {
    Destroy-IndicatorWindow
    return
  }
  Reset-CardVisual
}

function Hide-Indicator {
  if ($null -eq $script:window) { return }
  if (-not $script:windowShown) { return }
  Start-LeaveAnimation
  Wait-Dispatcher $script:leaveMs
  Hide-IndicatorWindow
}

# ---------------------------------------------------------------------------
# 嵌套消息帧：离场动画必须真的跑完才隐藏窗口，但期间不能掐断 dispatcher。
# ---------------------------------------------------------------------------
$script:waitFrame = $null
$script:waitTimer = $null
$script:waitTick = {
  try {
    if ($null -ne $script:waitTimer) { $script:waitTimer.Stop() }
    if ($null -ne $script:waitFrame) { $script:waitFrame.Continue = $false }
  } catch { }
}

function Wait-Dispatcher([int]$milliseconds) {
  if ($milliseconds -le 0) { return }
  try {
    $script:waitFrame = New-Object System.Windows.Threading.DispatcherFrame
    $script:waitTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:waitTimer.Interval = [TimeSpan]::FromMilliseconds($milliseconds)
    $script:waitTimer.Add_Tick($script:waitTick)
    $script:waitTimer.Start()
    try {
      [System.Windows.Threading.Dispatcher]::PushFrame($script:waitFrame) | Out-Null
    } finally {
      try { $script:waitTimer.Stop() } catch { }
      $script:waitTimer = $null
      $script:waitFrame = $null
    }
  } catch {
    Write-Diag ('dispatcher wait failed, falling back to sleep: ' + $_.Exception.Message)
    $script:waitTimer = $null
    $script:waitFrame = $null
    Start-Sleep -Milliseconds $milliseconds
  }
}

# ---------------------------------------------------------------------------
# 方法实现
# ---------------------------------------------------------------------------
function Invoke-Cmd([string]$cmd, $argObj) {
  switch ($cmd) {
    'ping' {
      $facts = Get-Facts
      $facts['pong'] = $true
      $script:cmdResult = $facts
      return
    }

    'show' {
      $text = Get-StrArg $argObj 'text' $script:defaultText
      Present-Indicator $text $true
      $script:cmdResult = Get-Facts
      return
    }

    'update' {
      $text = Get-StrArg $argObj 'text' $script:defaultText
      # 只改文案并重新自适应宽度/重新定位；不做 hide→show，避免闪烁。
      Present-Indicator $text $false
      $script:cmdResult = Get-Facts
      return
    }

    'hide' {
      Hide-Indicator
      $script:cmdResult = Get-Facts
      return
    }

    'shutdown' {
      try { if ($null -ne $script:autoHideTimer) { $script:autoHideTimer.Stop() } } catch { }
      try { if ($null -ne $script:window) { Hide-IndicatorWindow } } catch { Write-Diag ('shutdown hide failed: ' + $_.Exception.Message) }
      $facts = Get-Facts
      $facts['stopped'] = $true
      $script:cmdResult = $facts
      $script:shouldExit = $true
      return
    }

    default {
      Fail 'UNKNOWN_METHOD' ('Unknown cmd "' + $cmd + '"') @{ cmd = $cmd }
    }
  }
}

function Invoke-Line([string]$line) {
  if ($null -eq $line) { return }
  if ($line.Trim().Length -eq 0) { return }

  $reqId = $null
  $cmd = ''
  $argObj = $null
  try {
    $req = ConvertFrom-Json $line
    if ($null -ne $req) {
      $idProp = $req.PSObject.Properties['id']
      if ($null -ne $idProp -and $null -ne $idProp.Value) { $reqId = [string]$idProp.Value }
      $cmdProp = $req.PSObject.Properties['cmd']
      if ($null -ne $cmdProp -and $null -ne $cmdProp.Value) { $cmd = [string]$cmdProp.Value }
      $argsProp = $req.PSObject.Properties['args']
      if ($null -ne $argsProp) { $argObj = $argsProp.Value }
    }
  } catch {
    Respond-Err $reqId 'BAD_REQUEST' ('Request is not valid JSON: ' + $_.Exception.Message) @{ line = (Limit-Text $line 200) }
    return
  }

  if ([string]::IsNullOrEmpty($cmd)) {
    Respond-Err $reqId 'BAD_REQUEST' 'Request is missing the "cmd" field' @{}
    return
  }

  $script:cmdResult = $null
  $failed = $false
  $failCode = 'INTERNAL'
  $failMessage = ''
  $failDetails = $null
  try {
    Invoke-Cmd $cmd $argObj | Out-Null
  } catch {
    $failed = $true
    $ex = $_.Exception
    $failMessage = $ex.Message
    try {
      if ($null -ne $ex.Data -and $ex.Data.Contains('indicatorCode')) { $failCode = [string]$ex.Data['indicatorCode'] }
    } catch { }
    try {
      if ($null -ne $ex.Data -and $ex.Data.Contains('indicatorDetails')) { $failDetails = $ex.Data['indicatorDetails'] }
    } catch { }
    if ($failCode -eq 'INTERNAL') {
      try {
        if ($null -ne $ex.InnerException) { $failMessage = $failMessage + ' | ' + $ex.InnerException.Message }
      } catch { }
      Write-Diag ('cmd=' + $cmd + ' failed: ' + $ex.ToString())
    }
  }

  if ($failed) {
    Respond-Err $reqId $failCode $failMessage $failDetails
  } else {
    $data = $script:cmdResult
    if ($null -eq $data) { $data = [ordered]@{} }
    Respond-Ok $reqId $data
  }

  if ($cmd -eq 'shutdown') {
    $script:shouldExit = $true
    try { if ($null -ne $script:pollTimer) { $script:pollTimer.Stop() } } catch { }
    try {
      [void][System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown([System.Windows.Threading.DispatcherPriority]::Normal)
    } catch {
      Write-Diag ('dispatcher shutdown request failed: ' + $_.Exception.Message)
    }
  }
}

# ---------------------------------------------------------------------------
# 轮询取行（DispatcherTimer 在 UI 线程上跑，所以请求处理天然串行）
# ---------------------------------------------------------------------------
$script:pollTick = {
  try {
    if ($script:busy) { return }
    if ($script:shouldExit) { return }

    # 可见期间周期性重申置顶：上游用 Electron 的 `alwaysOnTop('screen-saver')` 拿到很高
    # 的 z-band，WPF 只有 `Topmost`，**后创建的其它 topmost 窗口会盖住它**。
    # 每秒重申一次（SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE，无闪烁、不抢焦点），
    # 保证「一直在屏幕最前端」这条对用户的承诺成立。
    # 15ms 一轮 → 67 轮 ≈ 1s。
    $script:topmostTickCounter = $script:topmostTickCounter + 1
    if ($script:topmostTickCounter -ge 67) {
      $script:topmostTickCounter = 0
      if ($script:hwnd -ne [System.IntPtr]::Zero) {
        $anyVisible = $false
        try { $anyVisible = [bool][IndicatorNative]::IsVisible($script:hwnd) } catch { $anyVisible = $false }
        if ($anyVisible) {
          try { [void][IndicatorNative]::AssertTopmost($script:hwnd) } catch { }
        }
      }
    }

    $line = $script:reader.NextLine()
    while ($null -ne $line) {
      if ($line.Trim().Length -gt 0) {
        $script:busy = $true
        try {
          Invoke-Line $line
        } catch {
          Write-Diag ('request handling failed: ' + $_.Exception.ToString())
        } finally {
          $script:busy = $false
        }
      }
      if ($script:shouldExit) { return }
      $line = $script:reader.NextLine()
    }
    if ($script:reader.Eof) {
      Write-Diag 'stdin closed; shutting down'
      $script:shouldExit = $true
      [void][System.Windows.Threading.Dispatcher]::CurrentDispatcher.BeginInvokeShutdown([System.Windows.Threading.DispatcherPriority]::Normal)
    }
  } catch {
    Write-Diag ('poll tick failed: ' + $_.Exception.ToString())
  }
}

$script:autoHideTick = {
  try {
    if ($null -ne $script:autoHideTimer) { $script:autoHideTimer.Stop() }
    Hide-Indicator
    Write-Diag 'auto-hidden after idle timeout'
  } catch {
    Write-Diag ('auto hide failed: ' + $_.Exception.ToString())
  }
}

# ---------------------------------------------------------------------------
# 引导：建窗 → 就绪横幅 → 主循环
# ---------------------------------------------------------------------------
$bootError = ''
if (-not $wpfReady) { $bootError = 'WPF assemblies are unavailable' }
if ($bootError -eq '') {
  try {
    $null = New-IndicatorWindow
  } catch {
    $bootError = 'indicator window bootstrap failed: ' + $_.Exception.Message
    Write-Diag $bootError
    [Console]::Error.WriteLine($_.Exception.ToString())
  }
}

if ($bootError -ne '') {
  $esc = $bootError.Replace('\', '\\').Replace('"', '\"').Replace("`r", ' ').Replace("`n", ' ')
  [Console]::Out.Write('{"id":null,"ok":false,"event":"ready","error":{"code":"INTERNAL","message":"' + $esc + '","details":{}}}')
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
  exit 2
}

$ready = [ordered]@{
  id = $null
  ok = $true
  event = 'ready'
  data = [ordered]@{
    protocol = $script:protocolName
    psVersion = $script:psVersion
    monitors = [int]$script:monitorCount
  }
}
Send-Object $ready
Write-Diag ('ready: dpiAware=' + [string]$script:dpiAware + ' hwnd=' + [string](Format-Hwnd $script:hwnd))

$script:reader = New-Object IndicatorStdin
try {
  $script:reader.Start([Console]::OpenStandardInput())
} catch {
  Write-Diag ('stdin reader failed: ' + $_.Exception.Message)
}

$script:pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:pollTimer.Interval = [TimeSpan]::FromMilliseconds(15)
$script:pollTimer.Add_Tick($script:pollTick)
$script:pollTimer.Start()

$script:autoHideTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:autoHideTimer.Interval = [TimeSpan]::FromMilliseconds($script:autoHideMs)
$script:autoHideTimer.Add_Tick($script:autoHideTick)

[void][System.Windows.Threading.Dispatcher]::Run()

try { if ($null -ne $script:pollTimer) { $script:pollTimer.Stop() } } catch { }
try { if ($null -ne $script:autoHideTimer) { $script:autoHideTimer.Stop() } } catch { }
try { if ($null -ne $script:window) { $script:window.Hide() } } catch { }
exit 0
