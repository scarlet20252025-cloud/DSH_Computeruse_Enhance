# dsh-computer-use Windows 原生后端（协议 dsh-cua/1）。
#
# 宿主：Windows PowerShell 5.1（powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File cua.ps1）
# 本文件必须保存为 **UTF-8 with BOM**，否则 5.1 会按 ANSI 解析中文注释并报出位置错乱的语法错误。
#
# 铁律：
#   1) stdout 只能出现 NDJSON 协议行。任何未捕获的函数返回值都会进 stdout，
#      所以每个调用都要 `| Out-Null` 或 `$null =`。
#   2) 诊断一律走 stderr（[Console]::Error.WriteLine）。
#   3) 单条请求的任何异常都必须转成失败响应，进程不得退出。
#
# 兼容性约束（PS 5.1 / .NET Framework 4.x）：
#   * 无 `??`、`?.`、三目 `? :`；if/try/foreach 不能当表达式用。
#   * UIA 用 GetCachedPropertyValue（.NET Framework 没有 TryGetCachedPropertyValue）。
#   * TreeWalker 导航不会填充 CacheRequest 缓存，必须用 FindAll + CacheRequest。
#   * TextPatternRange 的真名是 System.Windows.Automation.Text.TextPatternRange。

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

# ---------------------------------------------------------------------------
# stdout / stdin 编码（NDJSON，UTF-8 无 BOM）
# ---------------------------------------------------------------------------
try {
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
  try { [Console]::InputEncoding = $utf8 } catch { }
} catch {
  [Console]::Error.WriteLine("encoding setup failed: " + $_.Exception.Message)
}

function Write-Diag([string]$msg) {
  try { [Console]::Error.WriteLine("[cua] " + $msg) } catch { }
}

# ---------------------------------------------------------------------------
# DPI：必须在任何窗口/屏幕 API 之前调用，否则进程被 DPI 虚拟化，
#      截图（1707x1067）与 UIA/窗口坐标（2560x1600）落在两个坐标空间。
# ---------------------------------------------------------------------------
$dpiAwareResult = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CuaWinRow {
  public long Hwnd;
  public uint Pid;
  public string Title = "";
  public string ClassName = "";
  public bool Visible;
  public bool Minimized;
  public bool Cloaked;
  public bool ToolWindow;
  public bool Owned;
  public bool AppWindow;
  public int Left, Top, Right, Bottom;
  public int Width { get { return Right - Left; } }
  public int Height { get { return Bottom - Top; } }
  public long Area { get { return (long)(Right - Left) * (long)(Bottom - Top); } }
}

public class CuaChildInfo {
  public long Hwnd;
  public uint Pid;
}

public class CuaNative {
  public const int SM_XVIRTUALSCREEN = 76;
  public const int SM_YVIRTUALSCREEN = 77;
  public const int SM_CXVIRTUALSCREEN = 78;
  public const int SM_CYVIRTUALSCREEN = 79;

  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOOLWINDOW = 0x00000080;
  public const int WS_EX_APPWINDOW  = 0x00040000;
  public const uint GW_OWNER = 4;
  public const int SW_RESTORE = 9;
  public const int DWMWA_CLOAKED = 14;

  public const uint MOUSEEVENTF_MOVE        = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN    = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP      = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN   = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP     = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN  = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP    = 0x0040;
  public const uint MOUSEEVENTF_WHEEL       = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL      = 0x1000;
  public const uint MOUSEEVENTF_ABSOLUTE    = 0x8000;
  public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

  public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
  public const uint KEYEVENTF_KEYUP       = 0x0002;
  public const uint KEYEVENTF_UNICODE     = 0x0004;

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool IsProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  public delegate bool CuaEnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool EnumWindows(CuaEnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, CuaEnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern ushort MapVirtualKeyW(uint code, uint mapType);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanW(char ch);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  public static int InputStructSize() { return Marshal.SizeOf(typeof(INPUT)); }

  // 单个可打印字符 → VK 码（含 + = ; , 等标点）。失败返回 -1。
  public static int VkForChar(char ch) {
    try {
      short r = VkKeyScanW(ch);
      if (r == -1) { return -1; }
      return (int)(r & 0xFF);
    } catch { return -1; }
  }

  public static long GetForegroundHwnd() { return GetForegroundWindow().ToInt64(); }
  public static bool IsWindowHandle(long h) { return IsWindow(new IntPtr(h)); }
  public static bool IsMinimized(long h) { return IsIconic(new IntPtr(h)); }

  public static List<CuaWinRow> ListWindows() {
    List<CuaWinRow> rows = new List<CuaWinRow>();
    CuaEnumProc cb = delegate(IntPtr h, IntPtr p) {
      CuaWinRow r = new CuaWinRow();
      r.Hwnd = h.ToInt64();
      StringBuilder sb = new StringBuilder(1024);
      GetWindowTextW(h, sb, sb.Capacity);
      r.Title = sb.ToString();
      StringBuilder cb2 = new StringBuilder(512);
      GetClassNameW(h, cb2, cb2.Capacity);
      r.ClassName = cb2.ToString();
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      r.Pid = pid;
      r.Visible = IsWindowVisible(h);
      r.Minimized = IsIconic(h);
      int ck = 0;
      try { DwmGetWindowAttribute(h, DWMWA_CLOAKED, out ck, 4); } catch { ck = 0; }
      r.Cloaked = (ck != 0);
      int ex = GetWindowLongW(h, GWL_EXSTYLE);
      r.ToolWindow = ((ex & WS_EX_TOOLWINDOW) != 0);
      r.AppWindow = ((ex & WS_EX_APPWINDOW) != 0);
      r.Owned = (GetWindow(h, GW_OWNER) != IntPtr.Zero);
      RECT rc = new RECT();
      if (GetWindowRect(h, out rc)) { r.Left = rc.Left; r.Top = rc.Top; r.Right = rc.Right; r.Bottom = rc.Bottom; }
      rows.Add(r);
      return true;
    };
    EnumWindows(cb, IntPtr.Zero);
    GC.KeepAlive(cb);
    return rows;
  }

  public static CuaChildInfo FindForeignChild(long parentHwnd, int parentPid) {
    CuaChildInfo info = null;
    IntPtr parent = new IntPtr(parentHwnd);
    CuaEnumProc cb = delegate(IntPtr h, IntPtr p) {
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      if ((int)pid != parentPid) {
        info = new CuaChildInfo();
        info.Hwnd = h.ToInt64();
        info.Pid = pid;
        return false;
      }
      return true;
    };
    try { EnumChildWindows(parent, cb, IntPtr.Zero); } catch { }
    GC.KeepAlive(cb);
    return info;
  }

  public static int DpiForPoint(int x, int y) {
    try {
      POINT p = new POINT();
      p.X = x; p.Y = y;
      IntPtr mon = MonitorFromPoint(p, 2);
      if (mon == IntPtr.Zero) { return 0; }
      uint dx = 0; uint dy = 0;
      int hr = GetDpiForMonitor(mon, 0, out dx, out dy);
      if (hr != 0) { return 0; }
      return (int)dx;
    } catch { return 0; }
  }

  static int NormX(int x) {
    int vl = GetSystemMetrics(SM_XVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    if (vw < 2) { return 0; }
    double nx = (double)(x - vl) * 65535.0 / (double)(vw - 1);
    if (nx < 0.0) { nx = 0.0; }
    if (nx > 65535.0) { nx = 65535.0; }
    return (int)Math.Round(nx);
  }

  static int NormY(int y) {
    int vt = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (vh < 2) { return 0; }
    double ny = (double)(y - vt) * 65535.0 / (double)(vh - 1);
    if (ny < 0.0) { ny = 0.0; }
    if (ny > 65535.0) { ny = 65535.0; }
    return (int)Math.Round(ny);
  }

  public static bool MouseTo(int x, int y) {
    MOUSEINPUT mi = new MOUSEINPUT();
    mi.dx = NormX(x);
    mi.dy = NormY(y);
    mi.mouseData = 0;
    mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    mi.time = 0;
    mi.dwExtraInfo = IntPtr.Zero;
    return SendMouse(mi);
  }

  public static bool MouseFlag(uint flag) {
    MOUSEINPUT mi = new MOUSEINPUT();
    mi.dx = 0; mi.dy = 0; mi.mouseData = 0;
    mi.dwFlags = flag;
    mi.time = 0;
    mi.dwExtraInfo = IntPtr.Zero;
    return SendMouse(mi);
  }

  public static bool MouseWheel(int delta, bool horizontal) {
    MOUSEINPUT mi = new MOUSEINPUT();
    mi.dx = 0; mi.dy = 0;
    mi.mouseData = unchecked((uint)delta);
    mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    mi.time = 0;
    mi.dwExtraInfo = IntPtr.Zero;
    return SendMouse(mi);
  }

  static bool SendMouse(MOUSEINPUT mi) {
    INPUT inp = new INPUT();
    inp.type = 0;
    inp.u.mi = mi;
    INPUT[] arr = new INPUT[] { inp };
    uint sent = SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
    return sent == 1;
  }

  static bool IsExtendedVk(int vk) {
    switch (vk) {
      case 0x21: case 0x22: case 0x23: case 0x24:
      case 0x25: case 0x26: case 0x27: case 0x28:
      case 0x2C: case 0x2D: case 0x2E:
      case 0x5B: case 0x5C: case 0x5D:
      case 0x6F: case 0x90:
      case 0xA3: case 0xA5:
        return true;
      default:
        return false;
    }
  }

  static INPUT MakeVkInput(int vk, bool up) {
    KEYBDINPUT ki = new KEYBDINPUT();
    ki.wVk = (ushort)vk;
    ki.wScan = MapVirtualKeyW((uint)vk, 0);
    uint flags = 0;
    if (up) { flags |= KEYEVENTF_KEYUP; }
    if (IsExtendedVk(vk)) { flags |= KEYEVENTF_EXTENDEDKEY; }
    ki.dwFlags = flags;
    ki.time = 0;
    ki.dwExtraInfo = IntPtr.Zero;
    INPUT inp = new INPUT();
    inp.type = 1;
    inp.u.ki = ki;
    return inp;
  }

  static INPUT MakeUnicodeInput(ushort codeUnit, bool up) {
    KEYBDINPUT ki = new KEYBDINPUT();
    ki.wVk = 0;
    ki.wScan = codeUnit;
    uint flags = KEYEVENTF_UNICODE;
    if (up) { flags |= KEYEVENTF_KEYUP; }
    ki.dwFlags = flags;
    ki.time = 0;
    ki.dwExtraInfo = IntPtr.Zero;
    INPUT inp = new INPUT();
    inp.type = 1;
    inp.u.ki = ki;
    return inp;
  }

  public static bool KeyVk(int vk, bool up) {
    INPUT[] arr = new INPUT[] { MakeVkInput(vk, up) };
    return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool KeyUnicodeCodeUnit(int codeUnit, bool up) {
    INPUT[] arr = new INPUT[] { MakeUnicodeInput((ushort)codeUnit, up) };
    return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  // 一次性把整段文本作为 down/up 对发出去，减少跨进程往返。
  public static int TypeUnicodeText(string text) {
    if (text == null || text.Length == 0) { return 0; }
    List<INPUT> list = new List<INPUT>();
    for (int i = 0; i < text.Length; i++) {
      ushort cu = (ushort)text[i];
      list.Add(MakeUnicodeInput(cu, false));
      list.Add(MakeUnicodeInput(cu, true));
    }
    INPUT[] arr = list.ToArray();
    int size = Marshal.SizeOf(typeof(INPUT));
    int total = 0;
    int offset = 0;
    int chunk = 128;
    while (offset < arr.Length) {
      int n = arr.Length - offset;
      if (n > chunk) { n = chunk; }
      INPUT[] part = new INPUT[n];
      Array.Copy(arr, offset, part, 0, n);
      uint sent = SendInput((uint)n, part, size);
      total += (int)sent;
      offset += n;
      if (sent != (uint)n) { break; }
    }
    return total;
  }

  public static bool ForceForeground(long hwndLong) {
    IntPtr hwnd = new IntPtr(hwndLong);
    if (GetForegroundWindow() == hwnd) { return true; }
    uint dummy = 0;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = 0;
    if (fg != IntPtr.Zero) { fgThread = GetWindowThreadProcessId(fg, out dummy); }
    uint targetThread = GetWindowThreadProcessId(hwnd, out dummy);
    uint cur = GetCurrentThreadId();
    bool a1 = false;
    bool a2 = false;
    try {
      if (fgThread != 0 && fgThread != cur) { a1 = AttachThreadInput(fgThread, cur, true); }
      if (targetThread != 0 && targetThread != cur && targetThread != fgThread) { a2 = AttachThreadInput(targetThread, cur, true); }
      if (IsIconic(hwnd)) { ShowWindow(hwnd, SW_RESTORE); }
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
    } catch {
    } finally {
      if (a1) { try { AttachThreadInput(fgThread, cur, false); } catch { } }
      if (a2) { try { AttachThreadInput(targetThread, cur, false); } catch { } }
    }
    return GetForegroundWindow() == hwnd;
  }
}
'@ -Language CSharp | Out-Null

  $dpiAwareResult = [CuaNative]::SetProcessDPIAware()
  $isAware = [CuaNative]::IsProcessDPIAware()
} catch {
  Write-Diag ("Add-Type/bootstrap failed: " + $_.Exception.Message)
  [Console]::Error.WriteLine($_.Exception.ToString())
  # 关键类型不可用时也要给出可解析的失败横幅，然后退出。
  $esc = $_.Exception.Message
  $esc = $esc.Replace('\', '\\').Replace('"', '\"').Replace("`r", ' ').Replace("`n", ' ')
  [Console]::Out.WriteLine('{"id":null,"ok":false,"event":"ready","error":{"code":"INTERNAL","message":"native bootstrap failed: ' + $esc + '","details":{}}}')
  exit 2
}

Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName WindowsBase | Out-Null
Add-Type -AssemblyName UIAutomationClient | Out-Null
Add-Type -AssemblyName UIAutomationTypes | Out-Null

# UIA 可选：加载失败时其它方法仍要可用。
$script:uiaOk = $true
$script:uiaError = ''
try {
  $null = [System.Windows.Automation.AutomationElement]
  $script:AE = [System.Windows.Automation.AutomationElement]
  $script:PName = [System.Windows.Automation.AutomationElement]::NameProperty
  $script:PControlType = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
  $script:PAutomationId = [System.Windows.Automation.AutomationElement]::AutomationIdProperty
  $script:PClassName = [System.Windows.Automation.AutomationElement]::ClassNameProperty
  $script:PIsEnabled = [System.Windows.Automation.AutomationElement]::IsEnabledProperty
  $script:PIsOffscreen = [System.Windows.Automation.AutomationElement]::IsOffscreenProperty
  $script:PBoundingRect = [System.Windows.Automation.AutomationElement]::BoundingRectangleProperty
  $script:PIsKeyboardFocusable = [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty
  $script:PHasKeyboardFocus = [System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty
  $script:PRuntimeId = [System.Windows.Automation.AutomationElement]::RuntimeIdProperty
  $script:TrueCondition = [System.Windows.Automation.Condition]::TrueCondition
  $script:PatternInvoke = [System.Windows.Automation.InvokePattern]::Pattern
  $script:PatternExpandCollapse = [System.Windows.Automation.ExpandCollapsePattern]::Pattern
  $script:PatternToggle = [System.Windows.Automation.TogglePattern]::Pattern
  $script:PatternSelectionItem = [System.Windows.Automation.SelectionItemPattern]::Pattern
  $script:PatternSelection = [System.Windows.Automation.SelectionPattern]::Pattern
  $script:PatternValue = [System.Windows.Automation.ValuePattern]::Pattern
  $script:PatternText = [System.Windows.Automation.TextPattern]::Pattern
  $script:PatternScroll = [System.Windows.Automation.ScrollPattern]::Pattern
  $script:PatternScrollItem = [System.Windows.Automation.ScrollItemPattern]::Pattern
  # ---- UIA 树遍历的 C# 快路径 ---------------------------------------------
  # 动机：同样的 BFS + 缓存快照逻辑，PowerShell 版实测 400 元素 700~1000 ms，
  # 其中绝大部分是 PowerShell 的循环/属性绑定开销，而不是 UIA 的跨进程成本；
  # 同一逻辑用 C# 写是 280~310 ms（Firefox 1920x1080，400 元素 / depth 16）。
  # 所以把热循环下沉到 C#，PowerShell 只负责 JSON 组包；编译失败时保留 PS 实现兜底。
  $script:treeApi = $false
  try {
    $cuaSourcePath = $null
    try { $cuaSourcePath = $PSCommandPath } catch { $cuaSourcePath = $null }
    if ([string]::IsNullOrEmpty($cuaSourcePath)) { $cuaSourcePath = $MyInvocation.MyCommand.Path }
    $treeCsPath = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName($cuaSourcePath), 'cua-tree.cs')
    if (-not [System.IO.File]::Exists($treeCsPath)) { throw ('missing ' + $treeCsPath) }
    Add-Type -Path $treeCsPath -ReferencedAssemblies @('System', 'System.Core', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') | Out-Null
    $script:treeApi = $true
  } catch {
    $script:treeApi = $false
    Write-Diag ('C# tree walker unavailable, falling back to PowerShell: ' + $_.Exception.Message)
  }
} catch {
  $script:uiaOk = $false
  $script:uiaError = $_.Exception.Message
  Write-Diag ("UIA unavailable: " + $script:uiaError)
}

$script:jpegCodec = $null
try {
  foreach ($codec in [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()) {
    if ($codec.MimeType -eq 'image/jpeg') { $script:jpegCodec = $codec }
  }
} catch {
  Write-Diag ("jpeg codec lookup failed: " + $_.Exception.Message)
}

# ---------------------------------------------------------------------------
# 全局状态
# ---------------------------------------------------------------------------
$script:startedAt = Get-Date
$script:processId = $PID
$script:psVersion = $PSVersionTable.PSVersion.ToString()

$script:frameCounter = 0
$script:latestFrame = $null       # @{ id; source; raster; scale }

$script:stateCounter = 0
$script:currentState = $null      # @{ id; hwnd; pid; appKey; elements = object[] }

$script:heldKeys = New-Object System.Collections.ArrayList   # @{ name; vk }
$script:dragButton = $null                                    # 'left'|'right'|'middle'
$script:cursorX = 0
$script:cursorY = 0

$script:cmdResult = $null

# ---------------------------------------------------------------------------
# 错误与响应
# ---------------------------------------------------------------------------
function Fail([string]$code, [string]$message, $details) {
  $ex = New-Object System.Exception($message)
  $ex.Data['cuaCode'] = $code
  if ($null -ne $details) { $ex.Data['cuaDetails'] = $details }
  throw $ex
}

function Send-Line([string]$json) {
  if ($null -eq $json) { $json = '{}' }
  $one = $json.Replace("`r", '').Replace("`n", '')
  # 协议 §2 要求以 \n 结尾；WriteLine 在 Windows 上会写 CRLF，所以手工写 LF。
  [Console]::Out.Write($one)
  [Console]::Out.Write("`n")
  [Console]::Out.Flush()
}

function Send-Object($obj) {
  $json = $null
  try { $json = $obj | ConvertTo-Json -Depth 12 -Compress } catch { $json = $null }
  if ($null -eq $json) {
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

# ---------------------------------------------------------------------------
# 参数读取
# ---------------------------------------------------------------------------
function Get-Arg($obj, [string]$name, $default) {
  if ($null -eq $obj) { return $default }
  $prop = $null
  try { $prop = $obj.PSObject.Properties[$name] } catch { $prop = $null }
  if ($null -eq $prop) { return $default }
  $v = $prop.Value
  if ($null -eq $v) { return $default }
  return $v
}

function Has-Arg($obj, [string]$name) {
  if ($null -eq $obj) { return $false }
  $prop = $null
  try { $prop = $obj.PSObject.Properties[$name] } catch { $prop = $null }
  if ($null -eq $prop) { return $false }
  if ($null -eq $prop.Value) { return $false }
  return $true
}

function Get-IntArg($obj, [string]$name, [int]$default) {
  if (-not (Has-Arg $obj $name)) { return $default }
  $raw = Get-Arg $obj $name $null
  $n = 0
  if (-not [int]::TryParse([string]$raw, [ref]$n)) {
    Fail 'BAD_REQUEST' ("Argument '" + $name + "' must be an integer") @{ argument = $name; value = [string]$raw }
  }
  return $n
}

function Get-DoubleArg($obj, [string]$name, [double]$default) {
  if (-not (Has-Arg $obj $name)) { return $default }
  $raw = Get-Arg $obj $name $null
  $d = 0.0
  if (-not [double]::TryParse([string]$raw, [ref]$d)) {
    Fail 'BAD_REQUEST' ("Argument '" + $name + "' must be a number") @{ argument = $name; value = [string]$raw }
  }
  return $d
}

function Get-StrArg($obj, [string]$name, [string]$default) {
  if (-not (Has-Arg $obj $name)) { return $default }
  return [string](Get-Arg $obj $name $null)
}

function Get-BoolArg($obj, [string]$name, [bool]$default) {
  if (-not (Has-Arg $obj $name)) { return $default }
  $raw = Get-Arg $obj $name $null
  if ($raw -is [bool]) { return [bool]$raw }
  $s = ([string]$raw).ToLowerInvariant()
  if ($s -eq 'true' -or $s -eq '1' -or $s -eq 'yes') { return $true }
  if ($s -eq 'false' -or $s -eq '0' -or $s -eq 'no') { return $false }
  Fail 'BAD_REQUEST' ("Argument '" + $name + "' must be a boolean") @{ argument = $name; value = [string]$raw }
  return $default
}

function Clamp-Int([int]$value, [int]$min, [int]$max) {
  if ($value -lt $min) { return $min }
  if ($value -gt $max) { return $max }
  return $value
}


# ---------------------------------------------------------------------------
# 参数白名单（协议 §5：键名未知 = BAD_REQUEST）
#
# 背景：协议解析以前**静默忽略**不认识的键，导致「传了参数、实现没读」这类
# 契约漂移无法被发现（实测案例：get_app_state 传 root:'document' 返回 ok:true，
# 但原生代码根本不读 root；zoom 的 max_width 也是同一类静默失效）。
# 这里先按 cmd 精确列出每个方法真正读取的键，其余键一律拒绝并点名。
# ---------------------------------------------------------------------------
$script:argWhitelist = @{
  'ping'             = @()
  'screen_info'      = @()
  'screenshot'       = @('format', 'quality', 'max_width', 'monitor', 'left', 'top', 'width', 'height', 'clamp', 'target_hwnd')
  'zoom'             = @('left', 'top', 'width', 'height', 'scale', 'format', 'quality', 'clamp', 'max_width', 'target_hwnd')
  'list_apps'        = @('include_minimized')
  'list_windows'     = @('appKey', 'hwnd', 'pid', 'window_index', 'title')
  'get_app_state'    = @('appKey', 'hwnd', 'pid', 'window_index', 'title', 'max_elements', 'max_depth', 'timeout_ms')
  'click'            = @('appKey', 'hwnd', 'pid', 'element_index', 'state_id', 'x', 'y', 'frame_id', 'space', 'button', 'clicks', 'interval_ms')
  'mouse_move'       = @('x', 'y', 'frame_id', 'space', 'duration_ms')
  'drag'             = @('from_element_index', 'to_element_index', 'state_id', 'from', 'to', 'x', 'y', 'frame_id', 'space', 'button', 'duration_ms')
  'scroll'           = @('element_index', 'state_id', 'x', 'y', 'frame_id', 'space', 'direction', 'amount')
  'type'             = @('text', 'element_index', 'state_id', 'interval_ms')
  'key'              = @('key', 'text', 'element_index', 'state_id')
  'hold_key'         = @('key', 'text', 'duration_ms')
  'set_value'        = @('element_index', 'state_id', 'value', 'submit')
  'select_text'      = @('element_index', 'state_id', 'start', 'length', 'all')
  'perform_action'   = @('element_index', 'state_id', 'action')
  'open_application' = @('url', 'path', 'name', 'args', 'wait_ms')
  'focus_window'     = @('appKey', 'hwnd', 'pid', 'window_index', 'title')
  'clipboard_read'   = @()
  'clipboard_write'  = @('text')
  'wait'             = @('duration_ms', 'appKey', 'hwnd', 'pid', 'window_index', 'title', 'max_elements', 'max_depth')
  'stop'             = @('release_keys')
  'shutdown'         = @()
}

function Assert-Args($cmd, $argObj) {
  if ($null -eq $argObj) { return }
  $allowed = $script:argWhitelist[$cmd]
  if ($null -eq $allowed) { return }
  $unknown = New-Object System.Collections.ArrayList
  $names = @()
  try { $names = @($argObj.PSObject.Properties | ForEach-Object { [string]$_.Name }) } catch { $names = @() }
  foreach ($n in $names) {
    if ($allowed -notcontains $n) { [void]$unknown.Add($n) }
  }
  if ($unknown.Count -gt 0) {
    Fail 'BAD_REQUEST' ('Unknown argument(s) for ' + $cmd + ': ' + ($unknown -join ', ') + '. Accepted: ' + (($allowed -join ', '))) @{
      cmd = $cmd
      unknown = $unknown.ToArray()
      accepted = $allowed
    }
  }
}


function Format-Hwnd($hwnd) {
  if ($null -eq $hwnd) { return $null }
  $v = [int64]$hwnd
  if ($v -eq 0) { return $null }
  return ('0x{0:x8}' -f $v)
}

function Limit-Text([string]$s, [int]$max) {
  if ($null -eq $s) { return '' }
  $t = $s.Replace("`r", ' ').Replace("`n", ' ').Replace('"', "'")
  if ($t.Length -gt $max) { $t = $t.Substring(0, $max) + '...' }
  return $t
}

# ---------------------------------------------------------------------------
# 屏幕几何
# ---------------------------------------------------------------------------
function Get-VirtualScreen {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @{ x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height }
}

function Get-Monitors {
  $list = New-Object System.Collections.ArrayList
  $idx = 0
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $w = $s.WorkingArea
    $dpi = 0
    try { $dpi = [CuaNative]::DpiForPoint($b.Left + [int]($b.Width / 2), $b.Top + [int]($b.Height / 2)) } catch { $dpi = 0 }
    if ($dpi -le 0) {
      try {
        $g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
        $dpi = [int]$g.DpiX
        $g.Dispose()
      } catch { $dpi = 96 }
    }
    [void]$list.Add([ordered]@{
      index   = $idx
      device  = $s.DeviceName
      primary = [bool]$s.Primary
      dpi     = $dpi
      bounds  = [ordered]@{ x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
      working = [ordered]@{ x = $w.X; y = $w.Y; width = $w.Width; height = $w.Height }
    })
    $idx++
  }
  return $list.ToArray()
}

function Get-ScreenPayload {
  $vs = Get-VirtualScreen
  return [ordered]@{
    dpiAware = [bool][CuaNative]::IsProcessDPIAware()
    virtual  = [ordered]@{ x = $vs.x; y = $vs.y; width = $vs.width; height = $vs.height }
    monitors = @(Get-Monitors)
  }
}

# ---------------------------------------------------------------------------
# 截屏
# ---------------------------------------------------------------------------
function New-CaptureBitmap([int]$left, [int]$top, [int]$width, [int]$height) {
  if ($width -le 0 -or $height -le 0) {
    Fail 'SCREENSHOT_FAILED' ("Invalid capture size " + $width + "x" + $height) @{ left = $left; top = $top; width = $width; height = $height }
  }
  $bmp = $null
  $g = $null
  try {
    $bmp = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $size = New-Object System.Drawing.Size($width, $height)
    $g.CopyFromScreen($left, $top, 0, 0, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  } catch {
    if ($null -ne $g) { $g.Dispose() }
    if ($null -ne $bmp) { $bmp.Dispose() }
    Fail 'SCREENSHOT_FAILED' ("Screen capture failed: " + $_.Exception.Message) @{ left = $left; top = $top; width = $width; height = $height }
  } finally {
    if ($null -ne $g) { $g.Dispose() }
  }
  return $bmp
}

function Resize-Bitmap($src, [int]$width, [int]$height) {
  $dst = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = $null
  try {
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
    $g.DrawImage($src, $rect)
  } finally {
    if ($null -ne $g) { $g.Dispose() }
  }
  return $dst
}

function Encode-Bitmap($bmp, [string]$format, [int]$quality) {
  $ms = New-Object System.IO.MemoryStream
  try {
    if ($format -eq 'jpeg') {
      if ($null -eq $script:jpegCodec) {
        Fail 'SCREENSHOT_FAILED' 'JPEG encoder is not available on this host' @{}
      }
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
      try {
        $bmp.Save($ms, $script:jpegCodec, $ep)
      } finally {
        $ep.Dispose()
      }
    } else {
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    return $ms.ToArray()
  } catch {
    Fail 'SCREENSHOT_FAILED' ("Image encoding failed: " + $_.Exception.Message) @{ format = $format }
  } finally {
    $ms.Dispose()
  }
  return $null
}

function New-FramePayload {
  param(
    [string]$FrameId,
    [byte[]]$Bytes,
    [string]$MediaType,
    [int]$RasterWidth,
    [int]$RasterHeight,
    $Source,
    [string]$Mode,
    [bool]$Clamped,
    [bool]$Zoomed,
    [double]$SourceWidth,
    [double]$SourceHeight
  )
  $scaleX = 1.0
  $scaleY = 1.0
  if ($SourceWidth -gt 0) { $scaleX = [double]$RasterWidth / $SourceWidth }
  if ($SourceHeight -gt 0) { $scaleY = [double]$RasterHeight / $SourceHeight }
  $payload = [ordered]@{
    frame_id = $FrameId
    image = [ordered]@{
      base64    = [Convert]::ToBase64String($Bytes)
      mediaType = $MediaType
      width     = $RasterWidth
      height    = $RasterHeight
      bytes     = $Bytes.Length
    }
    source = [ordered]@{ x = $Source.x; y = $Source.y; width = $Source.width; height = $Source.height }
    scale  = [ordered]@{ x = $scaleX; y = $scaleY }
    screenshot_display = [ordered]@{
      mode   = $Mode
      bounds = [ordered]@{ x = 0; y = 0; width = $RasterWidth; height = $RasterHeight }
      raster = [ordered]@{ width = $RasterWidth; height = $RasterHeight }
      screen = [ordered]@{ width = $Source.width; height = $Source.height }
    }
  }
  if ($Zoomed) {
    $payload['zoomed'] = $true
    $payload['clamped'] = $Clamped
  } elseif ($Clamped) {
    $payload['clamped'] = $true
  }
  return $payload
}

function Set-LatestFrame([string]$FrameId, $Source, [int]$RasterWidth, [int]$RasterHeight, $TargetHwnd) {
  $scaleX = 1.0
  $scaleY = 1.0
  if ($Source.width -gt 0) { $scaleX = [double]$RasterWidth / [double]$Source.width }
  if ($Source.height -gt 0) { $scaleY = [double]$RasterHeight / [double]$Source.height }
  $owner = [int64]0
  if ($null -ne $TargetHwnd) { $owner = [int64]$TargetHwnd }
  $script:latestFrame = @{
    id     = $FrameId
    source = @{ x = $Source.x; y = $Source.y; width = $Source.width; height = $Source.height }
    raster = @{ width = $RasterWidth; height = $RasterHeight }
    scale  = @{ x = $scaleX; y = $scaleY }
    # 这一帧是给哪个窗口拍的。0 = 整屏/未知（不参与跨窗口校验）。
    hwnd   = $owner
  }
}

function Next-FrameId {
  $script:frameCounter = $script:frameCounter + 1
  return 'f' + $script:frameCounter
}

function Intersect-Rect([int]$left, [int]$top, [int]$width, [int]$height) {
  $vs = Get-VirtualScreen
  $right = $left + $width
  $bottom = $top + $height
  $vsRight = $vs.x + $vs.width
  $vsBottom = $vs.y + $vs.height
  $nl = $left
  if ($nl -lt $vs.x) { $nl = $vs.x }
  $nt = $top
  if ($nt -lt $vs.y) { $nt = $vs.y }
  $nr = $right
  if ($nr -gt $vsRight) { $nr = $vsRight }
  $nb = $bottom
  if ($nb -gt $vsBottom) { $nb = $vsBottom }
  $w = $nr - $nl
  $h = $nb - $nt
  if ($w -lt 0) { $w = 0 }
  if ($h -lt 0) { $h = 0 }
  return @{
    x = $nl; y = $nt; width = $w; height = $h
    changed = (($nl -ne $left) -or ($nt -ne $top) -or ($w -ne $width) -or ($h -ne $height))
  }
}

# ---------------------------------------------------------------------------
# 窗口 / 应用枚举
# ---------------------------------------------------------------------------
function Get-ProcessInfo([int]$procId) {
  # 热点：以前每次 Get-Process -Id 单独查（实测 72ms/次），再查一次 Path（+38ms 版本信息）。
  # list_windows 要枚举几十个窗口 → 秒级。改成「一次取全量进程表 + 按 pid 查表」，
  # 全量 Get-Process 实测只要 12ms（413 个进程），一次调用摊到所有窗口上。
  $info = @{ name = ''; path = ''; description = '' }
  $table = Get-ProcessTable
  if ($null -eq $table) { return $info }
  $key = [string]$procId
  if (-not $table.ContainsKey($key)) { return $info }
  $row = $table[$key]
  $info.name = [string]$row.name
  $info.path = [string]$row.path
  $info.description = [string]$row.description
  if ([string]::IsNullOrEmpty($info.description)) { $info.description = $info.name }
  return $info
}

#
# 全量进程表（pid → name/path/description），带 TTL 缓存。
# 用 [System.Diagnostics.Process]::GetProcesses() 一次拿到，避免 Get-Process -Id 的
# 每进程 ~72ms 开销；Path 走 MainModule，取不到（权限/已退出）就留空。
#
function Get-ProcessTable {
  $now = [DateTime]::UtcNow
  if ($null -ne $script:procTable -and $null -ne $script:procTableAt) {
    if (($now - $script:procTableAt).TotalMilliseconds -lt (Get-ProcInfoTtlMs)) { return $script:procTable }
  }
  $table = @{}
  $procs = $null
  try { $procs = [System.Diagnostics.Process]::GetProcesses() } catch { $procs = $null }
  if ($null -eq $procs) { return $table }
  foreach ($p in $procs) {
    if ($null -eq $p) { continue }
    $id = 0
    $name = ''
    $path = ''
    $desc = ''
    try { $id = [int]$p.Id } catch { continue }
    if ($id -le 0) { continue }
    try { $name = [string]$p.ProcessName } catch { $name = '' }
    try { $path = [string]$p.MainModule.FileName } catch { $path = '' }
    if (-not [string]::IsNullOrEmpty($path)) {
      try {
        $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
        if ($null -ne $vi -and -not [string]::IsNullOrEmpty($vi.FileDescription)) { $desc = [string]$vi.FileDescription }
      } catch { }
    }
    $table[[string]$id] = @{ name = $name; path = $path; description = $desc }
  }
  try { foreach ($p in $procs) { $p.Dispose() } } catch { }
  $script:procTable = $table
  $script:procTableAt = $now
  return $table
}

$script:procInfoCache = @{}
$script:procInfoCacheAt = $null
$script:procInfoTtlMs = 30000
$script:procTable = $null
$script:procTableAt = $null
$script:rootCacheHwnd = $null
$script:rootCacheEl = $null

function Get-CachedProcessInfo([int]$procId) {
  $key = [string]$procId
  if ($script:procInfoCache.ContainsKey($key)) { return $script:procInfoCache[$key] }
  $info = Get-ProcessInfo $procId
  $script:procInfoCache[$key] = $info
  return $info
}

function Reset-ProcessInfoCache {
  # 兼容保留：老调用点仍可用它强制失效。
  $script:procInfoCache = @{}
  $script:procInfoCacheAt = [DateTime]::UtcNow
}

#
# 进程信息（名字/路径/描述）过期策略：
# 以前每个命令都 Reset 一次，于是「413 个进程 × 每个 72ms 的 Get-Process -Id」
# 在 list_windows / list_apps / get_app_state 上反复重付。实测 list_windows 中位
# 309ms，其中绝大部分是这里。现在改成 TTL 缓存：默认 30s 内复用，
# 进程退出/新启由 TTL 兜住（这些信息只用于展示名与 appKey，不参与安全判断）。
#
function Get-ProcInfoTtlMs {
  if ($null -ne $script:procInfoTtlMs) { return [int]$script:procInfoTtlMs }
  return 30000
}

function Reset-ProcessInfoCacheIfStale {
  if ($null -eq $script:procInfoCache -or $null -eq $script:procInfoCacheAt) {
    $script:procInfoCache = @{}
    $script:procInfoCacheAt = [DateTime]::UtcNow
    return
  }
  $age = ([DateTime]::UtcNow - $script:procInfoCacheAt).TotalMilliseconds
  if ($age -ge (Get-ProcInfoTtlMs)) {
    $script:procInfoCache = @{}
    $script:procInfoCacheAt = [DateTime]::UtcNow
  }
}

$script:uwpHosts = @('applicationframehost', 'wwahost', 'winstore.app')

function Get-AppKeyForWindow($row) {
  # 返回 @{ appKey; displayName; pid; process; exePath; uwp=$true/$false }
  $info = Get-CachedProcessInfo ([int]$row.Pid)
  $pname = $info.name
  $appInfo = @{
    appKey = $pname.ToLowerInvariant()
    displayName = $info.description
    pid = [int]$row.Pid
    process = $pname
    exePath = $info.path
    uwp = $false
  }
  if ($script:uwpHosts -contains $pname.ToLowerInvariant()) {
    $child = $null
    try { $child = [CuaNative]::FindForeignChild($row.Hwnd, [int]$row.Pid) } catch { $child = $null }
    if ($null -ne $child) {
      $cinfo = Get-CachedProcessInfo ([int]$child.Pid)
      if (-not [string]::IsNullOrEmpty($cinfo.name)) {
        $appInfo.appKey = $cinfo.name.ToLowerInvariant()
        $appInfo.displayName = $cinfo.description
        $appInfo.pid = [int]$child.Pid
        $appInfo.process = $cinfo.name
        $appInfo.exePath = $cinfo.path
        $appInfo.uwp = $true
        return $appInfo
      }
    }
    # 拿不到真实应用名 → 用 <process>:<pid> 兜底
    $appInfo.appKey = $pname.ToLowerInvariant() + ':' + [string]$row.Pid
    $appInfo.displayName = $pname
    $appInfo.uwp = $true
  }
  return $appInfo
}

function Test-AppWindow($row) {
  if (-not $row.Visible) { return $false }
  if ($row.Cloaked) { return $false }
  if ([string]::IsNullOrEmpty($row.Title)) { return $false }
  if ($row.ToolWindow) { return $false }
  if ($row.Owned -and (-not $row.AppWindow)) { return $false }
  return $true
}

function Get-AppWindows([bool]$includeMinimized) {
  $result = New-Object System.Collections.ArrayList
  foreach ($row in [CuaNative]::ListWindows()) {
    if (-not (Test-AppWindow $row)) { continue }
    if ($row.Minimized -and (-not $includeMinimized)) { continue }
    $appInfo = Get-AppKeyForWindow $row
    $entry = [ordered]@{
      row = $row
      appKey = $appInfo.appKey
      displayName = $appInfo.displayName
      pid = $appInfo.pid
      process = $appInfo.process
      exePath = $appInfo.exePath
      uwp = $appInfo.uwp
    }
    [void]$result.Add($entry)
  }
  return $result
}

function New-WindowPayload($entry, [int]$foregroundHwnd) {
  $row = $entry.row
  return [ordered]@{
    hwnd        = Format-Hwnd $row.Hwnd
    title       = [string]$row.Title
    className   = [string]$row.ClassName
    pid         = [int]$row.Pid
    appKey      = $entry.appKey
    displayName = $entry.displayName
    foreground  = ([int64]$row.Hwnd -eq [int64]$foregroundHwnd)
    minimized   = [bool]$row.Minimized
    bounds      = [ordered]@{ x = $row.Left; y = $row.Top; width = $row.Width; height = $row.Height }
  }
}

function Get-EntryScore($entry, [int]$foregroundHwnd) {
  $score = 0
  if ([int64]$entry.row.Hwnd -eq [int64]$foregroundHwnd) { $score = $score + 1000000 }
  if (-not $entry.row.Minimized) { $score = $score + 100000 }
  if (-not [string]::IsNullOrEmpty($entry.row.Title)) { $score = $score + 1000 }
  $area = [int64]$entry.row.Width * [int64]$entry.row.Height
  if ($area -lt 0) { $area = 0 }
  if ($area -gt 999) { $area = 999 }
  return $score + [int]$area
}

function Select-BestEntry($entries, [int]$foregroundHwnd) {
  $best = $null
  $bestScore = -1
  foreach ($e in $entries) {
    $s = Get-EntryScore $e $foregroundHwnd
    if ($s -gt $bestScore) { $bestScore = $s; $best = $e }
  }
  return $best
}

# ---------------------------------------------------------------------------
# 目标解析：hwnd > pid > appKey
# ---------------------------------------------------------------------------
function Resolve-Target($argObj) {
  $fg = 0
  try { $fg = [int][CuaNative]::GetForegroundHwnd() } catch { $fg = 0 }
  $includeMinimized = $true

  # window_index / title：DSH 的 windowSelectorToArgs 会发这两个键，但以前原生完全没读，
  # 于是「按窗口标题选窗口」静默退化成「按 appKey 选第一个窗口」。
  $wantIndexRaw = Get-Arg $argObj 'window_index' $null
  if ($null -ne $wantIndexRaw) {
    $wantIndex = 0
    if (-not [int]::TryParse([string]$wantIndexRaw, [ref]$wantIndex)) {
      Fail 'BAD_REQUEST' ('Invalid window_index: ' + [string]$wantIndexRaw) @{ argument = 'window_index' }
    }
    $pool = New-Object System.Collections.ArrayList
    $appKeyForPool = Get-Arg $argObj 'appKey' $null
    foreach ($e in (Get-AppWindows $includeMinimized)) {
      if ($null -ne $appKeyForPool -and $e.appKey.ToLowerInvariant() -ne ([string]$appKeyForPool).ToLowerInvariant()) { continue }
      [void]$pool.Add($e)
    }
    if ($wantIndex -lt 0 -or $wantIndex -ge $pool.Count) {
      Fail 'WINDOW_NOT_FOUND' ('window_index ' + [string]$wantIndex + ' is out of range (0..' + [string]($pool.Count - 1) + ')') @{ window_index = $wantIndex; windowCount = $pool.Count }
    }
    return (Select-BestEntry @($pool[$wantIndex]) $fg)
  }

  $titleRaw = Get-Arg $argObj 'title' $null
  if ($null -ne $titleRaw) {
    $needle = ([string]$titleRaw).ToLowerInvariant()
    if ($needle.Trim().Length -gt 0) {
      $matches2 = New-Object System.Collections.ArrayList
      $appKeyForTitle = Get-Arg $argObj 'appKey' $null
      foreach ($e in (Get-AppWindows $includeMinimized)) {
        if ($null -ne $appKeyForTitle -and $e.appKey.ToLowerInvariant() -ne ([string]$appKeyForTitle).ToLowerInvariant()) { continue }
        if (([string]$e.row.Title).ToLowerInvariant().Contains($needle)) { [void]$matches2.Add($e) }
      }
      if ($matches2.Count -eq 0) {
        Fail 'WINDOW_NOT_FOUND' ('No window title contains "' + [string]$titleRaw + '"') @{ title = [string]$titleRaw }
      }
      return (Select-BestEntry $matches2 $fg)
    }
  }

  $hwndRaw = Get-Arg $argObj 'hwnd' $null
  if ($null -ne $hwndRaw) {
    $hw = [int64]0
    if ($hwndRaw -is [int]) { $hw = [int64]$hwndRaw }
    elseif ($hwndRaw -is [long]) { $hw = [int64]$hwndRaw }
    else {
      $s = ([string]$hwndRaw).Trim()
      if ($s.StartsWith('0x') -or $s.StartsWith('0X')) {
        try { $hw = [Convert]::ToInt64($s.Substring(2), 16) } catch { $hw = 0 }
      } else {
        try { $hw = [int64]$s } catch { $hw = 0 }
      }
    }
    if ($hw -eq 0) {
      Fail 'BAD_REQUEST' ('Invalid hwnd: ' + [string]$hwndRaw) @{ argument = 'hwnd' }
    }
    if (-not [CuaNative]::IsWindowHandle($hw)) {
      Fail 'WINDOW_NOT_FOUND' ('No such window: ' + [string]$hwndRaw) @{ hwnd = Format-Hwnd $hw }
    }
    foreach ($row in [CuaNative]::ListWindows()) {
      if ([int64]$row.Hwnd -eq $hw) {
        $appInfo = Get-AppKeyForWindow $row
        return [ordered]@{
          row = $row; appKey = $appInfo.appKey; displayName = $appInfo.displayName
          pid = $appInfo.pid; process = $appInfo.process; exePath = $appInfo.exePath
        }
      }
    }
    # 窗口存在但不是顶层枚举可见的窗口：手工构造
    $row2 = New-Object CuaWinRow
    $row2.Hwnd = $hw
    $row2.Pid = 0
    $row2.Title = ''
    $row2.ClassName = ''
    $row2.Visible = $true
    $row2.Minimized = $false
    $row2.Cloaked = $false
    $row2.ToolWindow = $false
    $row2.Owned = $false
    $row2.AppWindow = $false
    return [ordered]@{ row = $row2; appKey = ''; displayName = ''; pid = 0; process = ''; exePath = '' }
  }

  $pidRaw = Get-Arg $argObj 'pid' $null
  if ($null -ne $pidRaw) {
    $wantPid = 0
    if (-not [int]::TryParse([string]$pidRaw, [ref]$wantPid)) {
      Fail 'BAD_REQUEST' ('Invalid pid: ' + [string]$pidRaw) @{ argument = 'pid' }
    }
    $candidates = New-Object System.Collections.ArrayList
    foreach ($e in (Get-AppWindows $includeMinimized)) {
      if ([int]$e.row.Pid -eq $wantPid -or [int]$e.pid -eq $wantPid) { [void]$candidates.Add($e) }
    }
    if ($candidates.Count -eq 0) {
      Fail 'WINDOW_NOT_FOUND' ('No visible window for pid ' + [string]$wantPid) @{ pid = $wantPid }
    }
    return (Select-BestEntry $candidates $fg)
  }

  $appKeyRaw = Get-Arg $argObj 'appKey' $null
  if ($null -ne $appKeyRaw) {
    $want = ([string]$appKeyRaw).ToLowerInvariant()
    $candidates = New-Object System.Collections.ArrayList
    foreach ($e in (Get-AppWindows $includeMinimized)) {
      if ($e.appKey.ToLowerInvariant() -eq $want) { [void]$candidates.Add($e) }
    }
    if ($candidates.Count -eq 0) {
      Fail 'APP_NOT_FOUND' ('No application with appKey ' + [string]$appKeyRaw) @{ appKey = [string]$appKeyRaw }
    }
    return (Select-BestEntry $candidates $fg)
  }

  Fail 'BAD_REQUEST' 'One of hwnd, pid or appKey is required' @{ arguments = @('hwnd', 'pid', 'appKey') }
  return $null
}

# ---------------------------------------------------------------------------
# UIA 遍历
# ---------------------------------------------------------------------------
function Get-CachedValue($el, $prop, [bool]$ignoreDefault) {
  try {
    return $el.GetCachedPropertyValue($prop, $ignoreDefault)
  } catch {
    return $null
  }
}

function Get-ElementSnapshot($el) {
  # 返回 @{ role; name; value; automationId; className; enabled; focused; offscreen;
  #          focusable; rect; actions; runtimeId; available }
  #
  # 性能要点：属性一律走「一次 el.Cached 批量读」而不是逐属性 GetCachedPropertyValue。
  # 实测（Firefox，400 元素）：逐属性 299 ms -> 批量 77 ms，快 3.9 倍，字段完全一致。
  # 原因：GetCachedPropertyValue 每次调用都是一次跨进程序列化，10 个属性 = 10 次；
  # el.Cached 拿到的是同一个缓存对象的强类型视图，10 个字段只付一次代价。
  $snap = @{
    role = ''; name = ''; value = ''; automationId = ''; className = ''
    enabled = $true; focused = $false; offscreen = $false; focusable = $false
    rect = $null; actions = @(); runtimeId = $null; available = $false
  }
  $controlType = Get-CachedValue $el $script:PControlType $false
  if ($null -eq $controlType) {
    # 缓存未命中（例如缓存在激活之前取得的元素）→ 退回 Current 读取
    try {
      $ci = $el.Current
      $controlType = $ci.ControlType
      $snap.name = Convert-Str $ci.Name
      $snap.automationId = Convert-Str $ci.AutomationId
      $snap.className = Convert-Str $ci.ClassName
      $snap.enabled = [bool]$ci.IsEnabled
      $snap.offscreen = [bool]$ci.IsOffscreen
      $snap.focusable = [bool]$ci.IsKeyboardFocusable
      $snap.focused = [bool]$ci.HasKeyboardFocus
      $snap.rect = Convert-Rect $ci.BoundingRectangle
    } catch {
      return $snap
    }
  } else {
    $ci = $null
    try { $ci = $el.Cached } catch { $ci = $null }
    if ($null -ne $ci) {
      try { $snap.name = Convert-Str $ci.Name } catch { }
      try { $snap.automationId = Convert-Str $ci.AutomationId } catch { }
      try { $snap.className = Convert-Str $ci.ClassName } catch { }
      try { $snap.enabled = [bool]$ci.IsEnabled } catch { }
      try { $snap.offscreen = [bool]$ci.IsOffscreen } catch { }
      try { $snap.focusable = [bool]$ci.IsKeyboardFocusable } catch { }
      try { $snap.focused = [bool]$ci.HasKeyboardFocus } catch { }
      try { $snap.rect = Convert-Rect $ci.BoundingRectangle } catch { }
    }
    if ($null -eq $snap.rect) {
      try { $snap.rect = Convert-Rect $el.Current.BoundingRectangle } catch { }
    }
  }
  if ($null -ne $controlType) {
    $pn = Convert-Str $controlType.ProgrammaticName
    if ($pn.StartsWith('ControlType.')) { $pn = $pn.Substring(12) }
    $snap.role = $pn
  }
  # offscreen 元素探测 pattern 要跨进程问 UIA，实测 400 元素时占掉约 27% 总耗时，
  # 而这些元素本来就不能点（模型拿到 actions 也没用）。跳过它们；可交互集合仍然准确，
  # 因为「能点」的前提是 onscreen。
  if ($snap.offscreen) { $snap.actions = @() } else { $snap.actions = @(Get-ElementActions $el) }
  # GetRuntimeId 是每个元素一次 COM 调用；只有 onscreen 元素会被点击定位，
  # offscreen 的 runtimeId 永远不会用到，跳过。
  if ($snap.offscreen) { $snap.runtimeId = $null }
  else { try { $snap.runtimeId = $el.GetRuntimeId() } catch { $snap.runtimeId = $null } }
  $snap.available = $true
  return $snap
}

function Convert-Str($value) {
  # UIA 缓存会把属性以 COM 包装对象返回（System.__ComObject），直接 [string] 强转会得到
  # 字面量 "System.__ComObject"。但**不能因此一律丢弃**：合法字符串值也会被这样包起来
  # （真机端到端抓到：WPF TextBox 的 ValuePattern.Value 就被包成 __ComObject，
  # 于是 get_app_state 的 elements[].value 恒为空，模型的读值通道被整条打断）。
  # 正确做法是取到字符串后再判断它是不是类型名，而不是按对象类型提前放弃。
  if ($null -eq $value) { return '' }
  if ($value -is [string]) { return $value }
  $tn = ''
  try { $tn = $value.GetType().FullName } catch { return '' }
  if ($tn -eq 'System.Windows.Automation.ControlType') { return '' }
  $text = ''
  try { $text = [string]$value } catch { $text = '' }
  if ($text -eq '' -or $text.StartsWith('System.')) {
    # [string] 给出的是类型名（或失败）→ 再试一次 ToString()：COM 包装的 BSTR
    # 走这一条能取回真实文本。
    try { $text = $value.ToString() } catch { $text = '' }
  }
  if ($text -eq '' -or $text -eq $tn -or $text.StartsWith('System.')) { return '' }
  return $text
}

function Convert-Rect($rect) {
  if ($null -eq $rect) { return $null }
  # 缓存值偶尔会以 COM 包装对象返回（System.__ComObject），这里按类型名甄别。
  $typeName = ''
  try { $typeName = $rect.GetType().FullName } catch { return $null }
  if ($typeName -ne 'System.Windows.Rect') { return $null }
  $isEmpty = $false
  try { $isEmpty = [bool]$rect.IsEmpty } catch { return $null }
  if ($isEmpty) { return $null }
  $w = 0
  $h = 0
  try {
    $w = [int][math]::Round([double]$rect.Width)
    $h = [int][math]::Round([double]$rect.Height)
  } catch { return $null }
  if ($w -le 0 -or $h -le 0) { return $null }
  return @{
    x = [int][math]::Round([double]$rect.X)
    y = [int][math]::Round([double]$rect.Y)
    width = $w
    height = $h
  }
}

function Get-PatternInfo($el, $pattern) {
  $obj = $null
  try {
    if ($el.TryGetCachedPattern($pattern, [ref]$obj)) {
      $info = $null
      try { $info = $obj.Cached } catch { $info = $null }
      if ($null -eq $info) {
        try { $info = $obj.Current } catch { $info = $null }
      }
      return @{ pattern = $obj; info = $info }
    }
  } catch { }
  return $null
}

function Get-ElementActions($el) {
  $actions = New-Object System.Collections.ArrayList
  try {
    $pi = Get-PatternInfo $el $script:PatternInvoke
    if ($null -ne $pi) { [void]$actions.Add('invoke') }
  } catch { }
  try {
    $pi = Get-PatternInfo $el $script:PatternExpandCollapse
    if ($null -ne $pi) {
      $state = $null
      if ($null -ne $pi.info) { try { $state = [string]$pi.info.ExpandCollapseState } catch { $state = $null } }
      if ($state -eq 'Expanded') { [void]$actions.Add('collapse') }
      elseif ($state -eq 'Collapsed') { [void]$actions.Add('expand') }
      elseif ($state -eq 'PartiallyExpanded') { [void]$actions.Add('expand'); [void]$actions.Add('collapse') }
      elseif ($state -eq 'LeafNode') { }
      else { [void]$actions.Add('expand'); [void]$actions.Add('collapse') }
    }
  } catch { }
  try {
    $pi = Get-PatternInfo $el $script:PatternToggle
    if ($null -ne $pi) { [void]$actions.Add('toggle') }
  } catch { }
  try {
    $pi = Get-PatternInfo $el $script:PatternSelectionItem
    if ($null -ne $pi) { [void]$actions.Add('select') }
  } catch { }
  try {
    $pi = Get-PatternInfo $el $script:PatternValue
    if ($null -ne $pi) {
      $readOnly = $false
      if ($null -ne $pi.info) { try { $readOnly = [bool]$pi.info.IsReadOnly } catch { $readOnly = $false } }
      if (-not $readOnly) { [void]$actions.Add('set_value') }
    }
  } catch { }
  try {
    $pi = Get-PatternInfo $el $script:PatternText
    if ($null -ne $pi) { [void]$actions.Add('select_text') }
  } catch { }
  try {
    $pi = Get-PatternInfo $el $script:PatternScrollItem
    if ($null -ne $pi) { [void]$actions.Add('scroll') }
  } catch { }
  return $actions.ToArray()
}

function Read-ElementValue($el) {
  # 分层读取，逐级兜底：缓存 pattern → 缓存属性 → 未缓存 pattern → TextPattern（只读文档）。
  # 任何一级拿到非空字符串就返回；全都拿不到才回空串。
  try {
    $pi = Get-PatternInfo $el $script:PatternValue
    if ($null -ne $pi -and $null -ne $pi.info) {
      $v = $null
      try { $v = $pi.info.Value } catch { $v = $null }
      $s = Convert-Str $v
      if ($s -ne '') { return $s }
    }
  } catch { }

  try {
    $v = $el.GetCachedPropertyValue([System.Windows.Automation.ValuePattern]::ValueProperty, $true)
    $s = Convert-Str $v
    if ($s -ne '') { return $s }
  } catch { }

  try {
    $obj = $null
    if ($el.TryGetCurrentPattern($script:PatternValue, [ref]$obj)) {
      $s = Convert-Str $obj.Current.Value
      if ($s -ne '') { return $s }
    }
  } catch { }

  # 只读文档（只有 TextPattern）：取前 500 字符即可，避免整篇文本的跨进程拷贝。
  try {
    $tp = Get-PatternInfo $el $script:PatternText
    if ($null -ne $tp -and $null -ne $tp.info) {
      $s = Convert-Str $tp.info.DocumentRange.GetText(500)
      if ($s -ne '') { return $s }
    }
  } catch { }

  return ''
}

function Convert-NodeToSnap($node) {
  # C# CuaNode -> PS 快照（字段名与老 Get-ElementSnapshot 一致，下游零改动）。
  $rect = $null
  if ($node.HasRect) {
    $rect = @{ x = [int]$node.X; y = [int]$node.Y; width = [int]$node.W; height = [int]$node.H }
  }
  return @{
    role = [string]$node.Role
    name = [string]$node.Name
    value = [string]$node.Value
    automationId = [string]$node.AutomationId
    className = [string]$node.ClassName
    enabled = [bool]$node.Enabled
    focused = [bool]$node.Focused
    offscreen = [bool]$node.Offscreen
    focusable = [bool]$node.Focusable
    rect = $rect
    actions = @($node.Actions)
    runtimeId = $node.RuntimeId
    depth = [int]$node.Depth
    index = [int]$node.Index
    available = $true
  }
}

function Build-ElementTreeCSharp($rootEl, [int]$maxElements, [int]$maxDepth, [int]$budgetMs) {
  # 走 C# 快路径（src/native/cua-tree.cs）。统计位用 int[4] 回传：
  # [0]=truncated [1]=walkMs [2]=focusedIndex [3]=error flag
  $result = @{ elements = @(); truncated = $false; error = ''; focusedIndex = -1; walkMs = 0 }
  $stats = New-Object 'int[]' 8
  $nodes = $null
  try {
    $nodes = [CuaTree]::Walk($rootEl, $maxElements, $maxDepth, $budgetMs, $stats)
  } catch {
    $result.error = $_.Exception.Message
    return $result
  }
  if ($null -eq $nodes) { $result.error = 'tree walker returned null'; return $result }
  $out = New-Object System.Collections.ArrayList
  foreach ($node in $nodes) { [void]$out.Add((Convert-NodeToSnap $node)) }
  $result.elements = $out.ToArray()
  $result.truncated = ($stats[0] -ne 0)
  if ($stats[3] -ne 0 -and [string]::IsNullOrEmpty($result.error)) { $result.error = 'tree walker reported a failure' }
  $result.focusedIndex = [int]$stats[2]
  $result.walkMs = [int]$stats[1]
  return $result
}

function Build-ElementTree($rootEl, [int]$maxElements, [int]$maxDepth, [int]$budgetMs) {
  if ($script:treeApi) {
    try { return (Build-ElementTreeCSharp $rootEl $maxElements $maxDepth $budgetMs) } catch {
      Write-Diag ("C# tree walk failed, falling back to PowerShell: " + $_.Exception.Message)
    }
  }
  $result = @{ elements = @(); truncated = $false; error = ''; focusedIndex = -1 }
  $cache = New-Object System.Windows.Automation.CacheRequest
  $props = @(
    $script:PName, $script:PControlType, $script:PAutomationId, $script:PClassName,
    $script:PIsEnabled, $script:PIsOffscreen, $script:PBoundingRect,
    $script:PIsKeyboardFocusable, $script:PHasKeyboardFocus
  )
  $patterns = @(
    $script:PatternInvoke, $script:PatternExpandCollapse, $script:PatternToggle,
    $script:PatternSelectionItem, $script:PatternSelection, $script:PatternValue,
    $script:PatternText, $script:PatternScroll, $script:PatternScrollItem
  )
  foreach ($p in $props) { try { $cache.Add($p) } catch { } }
  foreach ($p in $patterns) { try { $cache.Add($p) } catch { } }
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $activation = $null
  $out = New-Object System.Collections.ArrayList
  $queue = New-Object System.Collections.ArrayList
  # 与 C# 快路径同一个策略：已经有可见 Document 在前时，不再展开后面的离屏
  # Document（浏览器后台标签页的 DOM）。判定口径必须是「已有可见文档」而不是
  # 「这个文档离屏」——窗口最小化时所有 Document 都是离屏的，按离屏跳过会把
  # 整页正文一起丢掉。
  $sawOnscreenDoc = $false
  try {
    $activation = $cache.Activate()
    $realRoot = $rootEl
    [void]$queue.Add([pscustomobject]@{ el = $realRoot; depth = 0 })
    $cursor = 0
    while ($cursor -lt $queue.Count) {
      if ($out.Count -ge $maxElements) { $result.truncated = $true; break }
      if ($sw.ElapsedMilliseconds -gt $budgetMs) { $result.truncated = $true; break }
      $node = $queue[$cursor]
      $cursor++
      $snap = $null
      try { $snap = Get-ElementSnapshot $node.el } catch { $snap = $null }
      if ($null -eq $snap) { continue }
      $snap['depth'] = $node.depth
      $snap['index'] = $out.Count
      $snap['value'] = ''
      if (($snap.actions -contains 'set_value') -or ($snap.actions -contains 'select_text')) {
        try { $snap['value'] = Read-ElementValue $node.el } catch { $snap['value'] = '' }
      }
      [void]$out.Add($snap)
      if ($node.depth -ge $maxDepth) { continue }
      if ($snap.role -eq 'Document') {
        if (-not $snap.offscreen) { $sawOnscreenDoc = $true }
        elseif ($sawOnscreenDoc) { continue }
      }
      $kids = $null
      try {
        $kids = $node.el.FindAll([System.Windows.Automation.TreeScope]::Children, $script:TrueCondition)
      } catch {
        $kids = $null
      }
      if ($null -eq $kids) { continue }
      # 子节点入队顺序：onscreen 优先。
      # 浏览器会把几十个离屏右键菜单模板排在 DOM 里，纯 BFS 会被它们吃光 max_elements
      # 预算（实测 Firefox：400 个里 376 个 offscreen，正文全被截断）。
      # 这里先探一次 IsOffscreen（走缓存，便宜），把 onscreen 的插到队首分支、离屏的排后。
      $onKids = New-Object System.Collections.ArrayList
      $offKids = New-Object System.Collections.ArrayList
      foreach ($k in $kids) {
        # 走 $k.Cached 批量视图而不是 Get-CachedValue：后者是一次跨进程序列化，
        # 前者是同一缓存对象的强类型字段（单个属性约 1/4 代价）。
        # 这个循环对整个子节点集合做一次，是 400 元素档的主要成本之一。
        $isOff = $false
        try { $isOff = [bool]$k.Cached.IsOffscreen } catch { $isOff = $false }
        if ($isOff) { [void]$offKids.Add($k) } else { [void]$onKids.Add($k) }
      }
      foreach ($k in $onKids) {
        if ($out.Count + $queue.Count - $cursor -ge $maxElements) { $result.truncated = $true; break }
        [void]$queue.Add([pscustomobject]@{ el = $k; depth = $node.depth + 1 })
      }
      foreach ($k in $offKids) {
        if ($out.Count + $queue.Count - $cursor -ge $maxElements) { $result.truncated = $true; break }
        [void]$queue.Add([pscustomobject]@{ el = $k; depth = $node.depth + 1 })
      }
    }
  } catch {
    $result.error = $_.Exception.Message
  } finally {
    if ($null -ne $activation) { try { $activation.Dispose() } catch { } }
    try { $cache.Dispose() } catch { }
  }
  $result.elements = $out.ToArray()
  return $result
}

function New-StateId {
  $script:stateCounter = $script:stateCounter + 1
  return 's' + $script:stateCounter
}

function Format-ElementLine($snap) {
  $line = '[' + [string]$snap.index + ']'
  if (-not [string]::IsNullOrEmpty($snap.role)) { $line = $line + ' ' + $snap.role }
  $name = Limit-Text ([string]$snap.name) 80
  $line = $line + ' "' + $name + '"'
  $value = [string]$snap.value
  if (-not [string]::IsNullOrEmpty($value)) {
    $line = $line + ' value="' + (Limit-Text $value 60) + '"'
  }
  if (-not [string]::IsNullOrEmpty($snap.automationId)) {
    $line = $line + ' id="' + (Limit-Text ([string]$snap.automationId) 40) + '"'
  }
  $r = $snap.rect
  if ($null -ne $r) {
    $line = $line + ' @(' + [string]$r.x + ',' + [string]$r.y + ',' + [string]$r.width + ',' + [string]$r.height + ')'
  } else {
    $line = $line + ' @(none)'
  }
  if ($snap.focused) { $line = $line + ' focused' }
  if ($snap.offscreen) { $line = $line + ' offscreen' }
  if (-not $snap.enabled) { $line = $line + ' disabled' }
  return $line
}

function Build-StateText($app, $window, $elements, [bool]$truncated) {
  $sb = New-Object System.Text.StringBuilder
  $appName = Limit-Text ([string]$app.displayName) 60
  [void]$sb.Append('<app name="' + $appName + '" pid="' + [string]$app.pid + '"')
  if ($null -ne $window) {
    $wt = Limit-Text ([string]$window.title) 100
    [void]$sb.Append(' window="' + $wt + '"')
    if ($window.minimized) { [void]$sb.Append(' minimized="true"') }
    if (-not $window.foreground) { [void]$sb.Append(' foreground="false"') }
  }
  [void]$sb.Append('>')
  [void]$sb.Append("`n")
  foreach ($snap in $elements) {
    [void]$sb.Append((Format-ElementLine $snap))
    [void]$sb.Append("`n")
  }
  if ($truncated) {
    [void]$sb.Append('... truncated (raise max_elements / max_depth or timeout_ms)')
    [void]$sb.Append("`n")
  }
  [void]$sb.Append('</app>')
  return $sb.ToString()
}

function Invoke-AppState($argObj, [bool]$standalone) {
  if (-not $script:uiaOk) {
    Fail 'UIA_UNAVAILABLE' ('UI Automation is not available: ' + $script:uiaError) @{}
  }
  $maxElements = Clamp-Int (Get-IntArg $argObj 'max_elements' 120) 1 400
  $maxDepth = Clamp-Int (Get-IntArg $argObj 'max_depth' 8) 0 16
  $timeoutMs = Clamp-Int (Get-IntArg $argObj 'timeout_ms' 4000) 50 60000

  Reset-ProcessInfoCacheIfStale
  $target = Resolve-Target $argObj
  $row = $target.row
  $hwnd = [int64]$row.Hwnd

  try { $fg = [int][CuaNative]::GetForegroundHwnd() } catch { $fg = 0 }
  $rootEl = $null
  try {
    # FromHandle 会跨进程建立 UIA 连接（实测占用 get_app_state 固定开销的一部分）。
    # 同一个 hwnd 且窗口仍存在时复用上次的 root，省掉重复握手。
    if ($null -ne $script:rootCacheHwnd -and [int64]$script:rootCacheHwnd -eq $hwnd -and $null -ne $script:rootCacheEl) {
      $rootEl = $script:rootCacheEl
    } else {
      $rootEl = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
      $script:rootCacheHwnd = $hwnd
      $script:rootCacheEl = $rootEl
    }
  } catch {
    Fail 'WINDOW_NOT_FOUND' ('Cannot attach UI Automation to window ' + [string](Format-Hwnd $hwnd) + ': ' + $_.Exception.Message) @{ hwnd = Format-Hwnd $hwnd }
  }
  if ($null -eq $rootEl) {
    Fail 'WINDOW_NOT_FOUND' ('Window disappeared: ' + [string](Format-Hwnd $hwnd)) @{ hwnd = Format-Hwnd $hwnd }
  }

  $tree = Build-ElementTree $rootEl $maxElements $maxDepth $timeoutMs
  $elements = $tree.elements
  $treeFocusedIndex = -1
  if ($null -ne $tree['focusedIndex']) { $treeFocusedIndex = [int]$tree['focusedIndex'] }

  $focusedIndex = $treeFocusedIndex
  $focusedName = ''
  $focusedRole = ''
  if ($focusedIndex -ge 0 -and $focusedIndex -lt $elements.Count) {
    $focusedName = [string]$elements[$focusedIndex].name
    $focusedRole = [string]$elements[$focusedIndex].role
  }
  # C# 快路径已经把 focused 元素定位算好了（同一份缓存视图内比对 runtimeId）；
  # 只有走 PS 兜底实现时才需要在这里重新找一遍。
  if ($focusedIndex -lt 0) {
    try {
      $fe = [System.Windows.Automation.AutomationElement]::FocusedElement
      if ($null -ne $fe) {
        $focusedRid = $fe.GetRuntimeId()
        $i = 0
        foreach ($snap in $elements) {
          $rid = $snap.runtimeId
          if ($null -ne $rid -and $null -ne $focusedRid -and $rid.Length -eq $focusedRid.Length) {
            $same = $true
            $j = 0
            while ($j -lt $rid.Length) {
              if ($rid[$j] -ne $focusedRid[$j]) { $same = $false; break }
              $j++
            }
            if ($same) { $focusedIndex = $i; $focusedName = [string]$snap.name; $focusedRole = [string]$snap.role; break }
          }
          $i++
        }
      }
    } catch { }
  }

  $stateId = New-StateId
  $storedElements = New-Object System.Collections.ArrayList
  foreach ($snap in $elements) {
    [void]$storedElements.Add(@{
      index = [int]$snap.index
      runtimeId = $snap.runtimeId
      rect = $snap.rect
      role = [string]$snap.role
      name = [string]$snap.name
      offscreen = [bool]$snap.offscreen
      enabled = [bool]$snap.enabled
      actions = $snap.actions
    })
  }

  $windowPayload = [ordered]@{
    hwnd       = Format-Hwnd $hwnd
    title      = [string]$row.Title
    className  = [string]$row.ClassName
    bounds     = [ordered]@{ x = $row.Left; y = $row.Top; width = $row.Width; height = $row.Height }
    foreground = ([int64]$hwnd -eq [int64]$fg)
    minimized  = [bool]$row.Minimized
  }
  $appPayload = [ordered]@{
    appKey      = $target.appKey
    displayName = $target.displayName
    pid         = [int]$row.Pid
  }

  $script:currentState = @{
    id = $stateId
    hwnd = $hwnd
    elements = $storedElements.ToArray()
    app = $appPayload
    window = $windowPayload
  }

  $elementPayloads = New-Object System.Collections.ArrayList
  foreach ($snap in $elements) {
    $valueOut = $null
    if (-not [string]::IsNullOrEmpty([string]$snap.value)) { $valueOut = [string]$snap.value }
    $boundsOut = $null
    if ($null -ne $snap.rect) {
      $boundsOut = [ordered]@{ x = $snap.rect.x; y = $snap.rect.y; width = $snap.rect.width; height = $snap.rect.height }
    }
    [void]$elementPayloads.Add([ordered]@{
      index        = [int]$snap.index
      role         = [string]$snap.role
      name         = [string]$snap.name
      value        = $valueOut
      automationId = [string]$snap.automationId
      className    = [string]$snap.className
      enabled      = [bool]$snap.enabled
      focused      = [bool]$snap.focused
      offscreen    = [bool]$snap.offscreen
      bounds       = $boundsOut
      actions      = $snap.actions
    })
  }

  $focusedPayload = $null
  if ($focusedIndex -ge 0) {
    $focusedPayload = [ordered]@{ elementIndex = $focusedIndex; name = $focusedName; role = $focusedRole }
  }

  $text = Build-StateText $appPayload $windowPayload $elements $tree.truncated
  if ($elements.Count -eq 0) {
    $text = $text + "`n(no UI Automation elements found for this window)"
  }
  if (-not [string]::IsNullOrEmpty($tree.error)) {
    $text = $text + "`n(traversal warning: " + $tree.error + ")"
  }

  return [ordered]@{
    state_id     = $stateId
    app          = $appPayload
    window       = $windowPayload
    focused      = $focusedPayload
    elementCount = $elements.Count
    truncated    = [bool]$tree.truncated
    elements     = $elementPayloads.ToArray()
    text         = $text
  }
}

# ---------------------------------------------------------------------------
# state 元素解析（RuntimeId 重定位 + 几何兜底）
# ---------------------------------------------------------------------------
function Get-StateElement($argObj) {
  if (-not (Has-Arg $argObj 'element_index')) {
    Fail 'BAD_REQUEST' 'element_index is required' @{ argument = 'element_index' }
  }
  $wantStateId = Get-Arg $argObj 'state_id' $null
  if ($null -eq $wantStateId) {
    Fail 'BAD_REQUEST' 'state_id is required together with element_index' @{ argument = 'state_id' }
  }
  $wantStateId = [string]$wantStateId
  if ($null -eq $script:currentState) {
    Fail 'ELEMENT_STALE' ('No app state has been captured yet (got state_id ' + $wantStateId + '); call get_app_state first') @{ state_id = $wantStateId }
  }
  if ($script:currentState.id -ne $wantStateId) {
    Fail 'ELEMENT_STALE' ('state_id ' + $wantStateId + ' is stale, current is ' + [string]$script:currentState.id) @{ state_id = $wantStateId; currentStateId = [string]$script:currentState.id }
  }
  $idx = Get-IntArg $argObj 'element_index' -1
  $all = $script:currentState.elements
  if ($idx -lt 0 -or $idx -ge $all.Count) {
    Fail 'ELEMENT_NOT_FOUND' ('element_index ' + [string]$idx + ' is out of range (0..' + [string]($all.Count - 1) + ')') @{ element_index = $idx; elementCount = $all.Count }
  }
  return $all[$idx]
}

function Find-ElementByRuntimeId($runtimeId) {
  if ($null -eq $runtimeId) { return $null }
  if (-not $script:uiaOk) { return $null }
  try {
    $value = [object]$runtimeId
    $cond = New-Object System.Windows.Automation.PropertyCondition -ArgumentList $script:PRuntimeId, $value
    return [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond)
  } catch {
    return $null
  }
}

function Test-ElementRelocation($stored) {
  # 返回 @{ el; fallback; text }
  $el = Find-ElementByRuntimeId $stored.runtimeId
  if ($null -ne $el) {
    $rect = $null
    try { $rect = Convert-Rect $el.Current.BoundingRectangle } catch { $rect = $null }
    if ($null -eq $rect -and $null -ne $stored.rect) { $rect = $stored.rect }
    return @{ el = $el; rect = $rect; fallback = $false; reason = '' }
  }
  if ($null -ne $stored.rect) {
    return @{ el = $null; rect = $stored.rect; fallback = $true; reason = 'element no longer present in the UI Automation tree; used the geometry captured by get_app_state' }
  }
  Fail 'ELEMENT_UNAVAILABLE' ('Element #' + [string]$stored.index + ' is gone and has no cached geometry') @{ element_index = [int]$stored.index }
  return $null
}

function Ensure-TargetForeground($state) {
  if ($null -eq $state) { return }
  try { $fg = [int64][CuaNative]::GetForegroundHwnd() } catch { $fg = 0 }
  if ($fg -eq [int64]$state.hwnd) { return }
  $ok = $false
  try { $ok = [CuaNative]::ForceForeground([int64]$state.hwnd) } catch { $ok = $false }
  if (-not $ok) {
    Start-Sleep -Milliseconds 60
    try { $ok = [CuaNative]::ForceForeground([int64]$state.hwnd) } catch { $ok = $false }
  }
  if (-not $ok) {
    Fail 'FOREGROUND_REQUIRED' ('Window ' + [string](Format-Hwnd $state.hwnd) + ' could not be brought to the foreground') @{ hwnd = Format-Hwnd $state.hwnd }
  }
}

function Resolve-ElementCenter($stored) {
  $reloc = Test-ElementRelocation $stored
  $rect = $reloc.rect
  if ($null -eq $rect) {
    Fail 'ELEMENT_UNAVAILABLE' ('Element #' + [string]$stored.index + ' has no usable geometry') @{ element_index = [int]$stored.index }
  }
  $cx = [int][math]::Round($rect.x + $rect.width / 2.0)
  $cy = [int][math]::Round($rect.y + $rect.height / 2.0)
  return @{ x = $cx; y = $cy; rect = $rect; fallback = $reloc.fallback; reason = $reloc.reason; el = $reloc.el }
}

# ---------------------------------------------------------------------------
# 坐标映射（协议 §3）
# ---------------------------------------------------------------------------
function Resolve-Frame($argObj, [bool]$requireFrame) {
  $frameId = Get-Arg $argObj 'frame_id' $null
  if ($null -ne $frameId) {
    $frameId = [string]$frameId
    if ($null -eq $script:latestFrame -or $script:latestFrame.id -ne $frameId) {
      $current = $null
      if ($null -ne $script:latestFrame) { $current = $script:latestFrame.id }
      Fail 'ELEMENT_STALE' ('frame_id ' + $frameId + ' is not the latest frame (' + [string]$current + ')') @{ frame_id = $frameId; currentFrameId = $current }
    }
  }
  if (-not $requireFrame) { return $null }
  if ($null -eq $script:latestFrame) {
    Fail 'NO_FRAME' 'No screenshot has been taken yet; call screenshot or zoom first (or pass space:"screen")' @{}
  }
  # 跨窗口保护：帧带着「给哪个窗口拍的」。若本次输入操作的 app 解析到另一个窗口，
  # 绝不复用旧帧的几何——否则坐标会被上一个窗口的 source/scale 静默平移
  # （实测案例：给 firefox 拍 400,300 起始的局部图后，对 notepad 点 (250,100)
  #  实际落在 (525,350)，还返回 ok:true）。
  $frameOwner = 0
  if ($script:latestFrame.ContainsKey('hwnd')) { $frameOwner = [int64]$script:latestFrame.hwnd }
  if ($frameOwner -ne 0) {
    $targetHwnd = 0
    try { $targetHwnd = [int64](Resolve-Target $argObj).row.Hwnd } catch { $targetHwnd = 0 }
    if ($targetHwnd -ne 0 -and $targetHwnd -ne $frameOwner) {
      Fail 'FRAME_TARGET_MISMATCH' ('Frame ' + [string]$script:latestFrame.id + ' was captured for another window; re-capture the target window or pass space:"screen"') @{
        frame_id = [string]$script:latestFrame.id
        frameHwnd = (Format-Hwnd $frameOwner)
        targetHwnd = (Format-Hwnd $targetHwnd)
      }
    }
  }
  return $script:latestFrame
}

function Resolve-Point($argObj, [bool]$required) {
  # 返回 @{ x; y; mapped=$true/$false; frameId }
  $space = Get-StrArg $argObj 'space' 'raster'
  if ($space -ne 'screen' -and $space -ne 'raster') {
    Fail 'BAD_REQUEST' ('space must be "raster" or "screen", got ' + $space) @{ argument = 'space' }
  }
  $hasX = Has-Arg $argObj 'x'
  $hasY = Has-Arg $argObj 'y'
  if (-not $hasX -and -not $hasY) {
    if ($required) {
      Fail 'BAD_REQUEST' 'x and y are required' @{ arguments = @('x', 'y') }
    }
    return $null
  }
  if (-not $hasX -or -not $hasY) {
    Fail 'BAD_REQUEST' 'x and y must be provided together' @{ arguments = @('x', 'y') }
  }
  $x = Get-DoubleArg $argObj 'x' 0
  $y = Get-DoubleArg $argObj 'y' 0

  # 显式 frame_id 永远校验（协议 §3 表格）
  $explicit = Get-Arg $argObj 'frame_id' $null
  if ($null -ne $explicit) {
    $null = Resolve-Frame $argObj $false
  }
  if ($space -eq 'screen') {
    return @{ x = [int][math]::Round($x); y = [int][math]::Round($y); mapped = $false; frameId = $null }
  }
  $frame = Resolve-Frame $argObj $true
  if ($null -eq $frame) {
    Fail 'NO_FRAME' 'No screenshot has been taken yet; call screenshot or zoom first (or pass space:"screen")' @{}
  }
  $sx = [int][math]::Round($frame.source.x + $x / $frame.scale.x)
  $sy = [int][math]::Round($frame.source.y + $y / $frame.scale.y)
  return @{ x = $sx; y = $sy; mapped = $true; frameId = $frame.id }
}

# ---------------------------------------------------------------------------
# 输入注入
# ---------------------------------------------------------------------------
$script:vkMap = @{
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'esc' = 0x1B; 'escape' = 0x1B
  'space' = 0x20; 'spacebar' = 0x20; 'backspace' = 0x08; 'back' = 0x08
  'delete' = 0x2E; 'del' = 0x2E; 'insert' = 0x2D; 'ins' = 0x2D
  'home' = 0x24; 'end' = 0x23
  'pageup' = 0x21; 'pgup' = 0x21; 'prior' = 0x21
  'pagedown' = 0x22; 'pgdn' = 0x22; 'next' = 0x22
  'up' = 0x26; 'arrowup' = 0x26; 'down' = 0x28; 'arrowdown' = 0x28
  'left' = 0x25; 'arrowleft' = 0x25; 'right' = 0x27; 'arrowright' = 0x27
  'capslock' = 0x14; 'numlock' = 0x90; 'scrolllock' = 0x91
  'printscreen' = 0x2C; 'prtsc' = 0x2C; 'pause' = 0x13
  'apps' = 0x5D; 'menu' = 0x5D; 'contextmenu' = 0x5D
  'backtick' = 0xC0; 'grave' = 0xC0
  'minus' = 0xBD; 'equal' = 0xBB; 'plus' = 0xBB
  'comma' = 0xBC; 'period' = 0xBE; 'dot' = 0xBE
  'slash' = 0xBF; 'semicolon' = 0xBA; 'quote' = 0xDE
  'bracketleft' = 0xDB; 'backslash' = 0xDC; 'bracketright' = 0xDD
  'multiply' = 0x6A; 'add' = 0x6B; 'separator' = 0x6C
  'subtract' = 0x6D; 'decimal' = 0x6E; 'divide' = 0x6F
}
$script:modifierMap = @{
  'ctrl' = 0x11; 'control' = 0x11
  'shift' = 0x10
  'alt' = 0x12
  'win' = 0x5B; 'meta' = 0x5B; 'cmd' = 0x5B; 'command' = 0x5B
}
$script:modifierDisplay = @{
  0x11 = 'ctrl'; 0x10 = 'shift'; 0x12 = 'alt'; 0x5B = 'win'
}

function Get-NamedVk([string]$name) {
  $n = $name.ToLowerInvariant()
  if ($script:vkMap.ContainsKey($n)) { return [int]$script:vkMap[$n] }
  if ($n.Length -eq 1) {
    $c = $n[0]
    if ($c -ge 'a' -and $c -le 'z') { return [int][char]::ToUpperInvariant($c) }
    if ($c -ge '0' -and $c -le '9') { return [int][char]$c }
    if ($c -ge 'A' -and $c -le 'Z') { return [int]$c }
    # 标点等可打印单字符走 VkKeyScan
    $vk = -1
    try { $vk = [CuaNative]::VkForChar([char]$c) } catch { $vk = -1 }
    if ($vk -gt 0) { return $vk }
  }
  if ($n -match '^f([1-9]|1[0-9]|2[0-4])$') {
    $num = [int]$n.Substring(1)
    return 0x70 + ($num - 1)
  }
  if ($n -match '^numpad([0-9])$') {
    return 0x60 + [int]$Matches[1]
  }
  return -1
}

function Parse-KeySpec($argObj) {
  # 返回 @{ modifiers=@(vk); keys=@(vk); displayModifiers=@(string); displayKeys=@(string); unicode=$null }
  $res = @{ modifiers = @(); keys = @(); displayModifiers = @(); displayKeys = @(); unicode = $null }
  $keyArg = Get-Arg $argObj 'key' $null
  $textArg = Get-Arg $argObj 'text' $null
  if ($null -eq $keyArg -and $null -eq $textArg) {
    Fail 'BAD_REQUEST' 'Either "key" or "text" is required' @{ arguments = @('key', 'text') }
  }
  if ($null -ne $textArg -and $null -eq $keyArg) {
    $t = [string]$textArg
    if ($t.Length -eq 0) {
      Fail 'BAD_REQUEST' '"text" must not be empty' @{ argument = 'text' }
    }
    $res.unicode = $t
    $res.displayKeys = @($t)
    return $res
  }
  $spec = ([string]$keyArg).Trim()
  if ($spec.Length -eq 0) {
    Fail 'BAD_REQUEST' '"key" must not be empty' @{ argument = 'key' }
  }
  $keyName = ''
  $modParts = @()
  if ($spec.EndsWith('+')) {
    $keyName = '+'
    $spec = $spec.Substring(0, $spec.Length - 1)
  }
  $parts = @($spec.Split('+') | Where-Object { $_.Trim().Length -gt 0 })
  if ($keyName -eq '') {
    if ($parts.Count -eq 0) {
      Fail 'BAD_REQUEST' ('Cannot parse key spec "' + [string]$keyArg + '"') @{ argument = 'key' }
    }
    $keyName = $parts[$parts.Count - 1].Trim()
    if ($parts.Count -gt 1) { $modParts = @($parts[0..($parts.Count - 2)]) } else { $modParts = @() }
  } else {
    $modParts = $parts
  }
  if ($modParts.Count -eq 0 -and $keyName -eq '' ) {
    Fail 'BAD_REQUEST' ('Cannot parse key spec "' + [string]$keyArg + '"') @{ argument = 'key' }
  }
  $modVks = New-Object System.Collections.ArrayList
  $modNames = New-Object System.Collections.ArrayList
  foreach ($m in $modParts) {
    $mn = $m.Trim().ToLowerInvariant()
    if ($mn.Length -eq 0) { continue }
    if (-not $script:modifierMap.ContainsKey($mn)) {
      Fail 'BAD_REQUEST' ('Unknown modifier "' + $mn + '". Available modifiers: ctrl/control, alt, shift, win/meta/cmd/command') @{ argument = 'key'; modifier = $mn }
    }
    $vk = [int]$script:modifierMap[$mn]
    if (-not $modVks.Contains($vk)) {
      [void]$modVks.Add($vk)
      [void]$modNames.Add([string]$script:modifierDisplay[$vk])
    }
  }
  $keyVk = Get-NamedVk $keyName
  if ($keyVk -lt 0 -and $script:modifierMap.ContainsKey($keyName.ToLowerInvariant())) {
    $keyVk = [int]$script:modifierMap[$keyName.ToLowerInvariant()]
  }
  if ($keyVk -lt 0) {
    Fail 'BAD_REQUEST' ('Unknown key name "' + $keyName + '". Supported: a-z, 0-9, enter/return, tab, esc/escape, space, backspace, delete/del, insert/ins, home, end, pageup/pgup, pagedown/pgdn, up/down/left/right, f1-f24, numpad0-9, capslock, numlock, scrolllock, printscreen, pause, apps/menu, multiply/add/subtract/decimal/divide, punctuation names, or a single character; combine modifiers with "+" (e.g. "ctrl+s")') @{ argument = 'key'; key = $keyName }
  }
  $res.modifiers = $modVks.ToArray()
  $res.keys = @($keyVk)
  $res.displayModifiers = $modNames.ToArray()
  $res.displayKeys = @($keyName)
  return $res
}

function Get-KeyDisplayName([string]$raw) {
  $m = @{
    'ctrl' = 'Ctrl'; 'control' = 'Ctrl'; 'shift' = 'Shift'; 'alt' = 'Alt'
    'win' = 'Win'; 'meta' = 'Win'; 'cmd' = 'Win'; 'command' = 'Win'
    'enter' = 'Enter'; 'return' = 'Enter'; 'tab' = 'Tab'; 'esc' = 'Esc'; 'escape' = 'Esc'
    'space' = 'Space'; 'backspace' = 'Backspace'; 'delete' = 'Delete'; 'del' = 'Delete'
    'insert' = 'Insert'; 'ins' = 'Insert'; 'home' = 'Home'; 'end' = 'End'
    'pageup' = 'PageUp'; 'pgup' = 'PageUp'; 'pagedown' = 'PageDown'; 'pgdn' = 'PageDown'
    'up' = 'Up'; 'down' = 'Down'; 'left' = 'Left'; 'right' = 'Right'
  }
  $l = $raw.ToLowerInvariant()
  if ($m.ContainsKey($l)) { return [string]$m[$l] }
  if ($l -match '^f([0-9]+)$') { return 'F' + $Matches[1] }
  if ($raw.Length -eq 1) { return $raw.ToUpperInvariant() }
  return $raw
}

function Invoke-MouseMoveTo([int]$x, [int]$y, [int]$durationMs) {
  if ($durationMs -le 0) {
    $null = [CuaNative]::MouseTo($x, $y)
    $script:cursorX = $x
    $script:cursorY = $y
    return
  }
  $steps = [int][math]::Round($durationMs / 16.0)
  if ($steps -lt 2) { $steps = 2 }
  if ($steps -gt 120) { $steps = 120 }
  $sx = $script:cursorX
  $sy = $script:cursorY
  $i = 1
  while ($i -le $steps) {
    $t = [double]$i / [double]$steps
    $nx = [int][math]::Round($sx + ($x - $sx) * $t)
    $ny = [int][math]::Round($sy + ($y - $sy) * $t)
    $null = [CuaNative]::MouseTo($nx, $ny)
    $script:cursorX = $nx
    $script:cursorY = $ny
    [System.Threading.Thread]::Sleep(16)
    $i++
  }
  $null = [CuaNative]::MouseTo($x, $y)
  $script:cursorX = $x
  $script:cursorY = $y
}

function Get-ButtonFlags([string]$button) {
  if ($button -eq 'left') { return @{ down = [CuaNative]::MOUSEEVENTF_LEFTDOWN; up = [CuaNative]::MOUSEEVENTF_LEFTUP } }
  if ($button -eq 'right') { return @{ down = [CuaNative]::MOUSEEVENTF_RIGHTDOWN; up = [CuaNative]::MOUSEEVENTF_RIGHTUP } }
  if ($button -eq 'middle') { return @{ down = [CuaNative]::MOUSEEVENTF_MIDDLEDOWN; up = [CuaNative]::MOUSEEVENTF_MIDDLEUP } }
  Fail 'BAD_REQUEST' ('button must be "left", "right" or "middle", got ' + $button) @{ argument = 'button' }
  return $null
}

function Invoke-ReleaseHeldKeys {
  $released = New-Object System.Collections.ArrayList
  foreach ($hk in $script:heldKeys) {
    try {
      $null = [CuaNative]::KeyVk([int]$hk.vk, $true)
      [void]$released.Add([string]$hk.name)
    } catch { }
  }
  $script:heldKeys.Clear()
  return $released.ToArray()
}

function Invoke-EndDrag {
  if ($null -eq $script:dragButton) { return $false }
  try {
    $flags = Get-ButtonFlags $script:dragButton
    $null = [CuaNative]::MouseFlag($flags.up)
  } catch { }
  $script:dragButton = $null
  return $true
}

function Get-CharCount([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return 0 }
  $n = 0
  $i = 0
  while ($i -lt $text.Length) {
    $c = $text[$i]
    if ([char]::IsHighSurrogate($c) -and ($i + 1) -lt $text.Length -and [char]::IsLowSurrogate($text[$i + 1])) {
      $i = $i + 2
    } else {
      $i = $i + 1
    }
    $n++
  }
  return $n
}

function Invoke-TypeText([string]$text, [int]$intervalMs) {
  if ([string]::IsNullOrEmpty($text)) { return 0 }
  if ($intervalMs -le 0) {
    $sent = 0
    try { $sent = [CuaNative]::TypeUnicodeText($text) } catch { $sent = 0 }
    if ($sent -gt 0) { return (Get-CharCount $text) }
  }
  $i = 0
  while ($i -lt $text.Length) {
    $cu = [int]$text[$i]
    $null = [CuaNative]::KeyUnicodeCodeUnit($cu, $false)
    $null = [CuaNative]::KeyUnicodeCodeUnit($cu, $true)
    $i++
    if ($intervalMs -gt 0 -and $i -lt $text.Length) {
      [System.Threading.Thread]::Sleep($intervalMs)
    }
  }
  return (Get-CharCount $text)
}

# ---------------------------------------------------------------------------
# 剪贴板
# ---------------------------------------------------------------------------
function Invoke-ClipboardRetry($scriptBlock) {
  $lastError = $null
  $attempt = 0
  while ($attempt -lt 3) {
    $attempt++
    try {
      return & $scriptBlock
    } catch {
      $lastError = $_
      [System.Threading.Thread]::Sleep(50)
    }
  }
  Fail 'CLIPBOARD_FAILED' ('Clipboard operation failed after 3 attempts: ' + $lastError.Exception.Message) @{}
  return $null
}

# ---------------------------------------------------------------------------
# 方法实现
# ---------------------------------------------------------------------------
function Invoke-Cmd([string]$cmd, $argObj) {
  # 先校验键名（协议 §5）：未知键名必须显式失败，否则「实现没读」会被误判成「功能支持」。
  if ($script:argWhitelist.ContainsKey($cmd)) { Assert-Args $cmd $argObj }
  switch ($cmd) {
    'ping' {
      $span = (Get-Date) - $script:startedAt
      $up = [int64]$span.TotalMilliseconds
      $script:cmdResult = [ordered]@{ pong = $true; uptimeMs = $up }
      return
    }

    'screen_info' {
      $script:cmdResult = Get-ScreenPayload
      return
    }

    'screenshot' {
      $vs = Get-VirtualScreen
      $gridW = [int]$vs.width
      $gridH = [int]$vs.height
      $gridX = [int]$vs.x
      $gridY = [int]$vs.y
      $mode = 'full-screen'
      $monitorArg = Get-Arg $argObj 'monitor' $null
      if ($null -ne $monitorArg) {
        $mi = Get-IntArg $argObj 'monitor' 0
        $mons = @(Get-Monitors)
        if ($mi -lt 0 -or $mi -ge $mons.Count) {
          Fail 'BAD_REQUEST' ('monitor index ' + [string]$mi + ' is out of range (0..' + [string]($mons.Count - 1) + ')') @{ argument = 'monitor'; monitorCount = $mons.Count }
        }
        $mb = $mons[$mi].bounds
        $gridX = [int]$mb.x; $gridY = [int]$mb.y; $gridW = [int]$mb.width; $gridH = [int]$mb.height
        $mode = 'monitor'
      } else {
        $hasRegion = (Has-Arg $argObj 'left') -or (Has-Arg $argObj 'top') -or (Has-Arg $argObj 'width') -or (Has-Arg $argObj 'height')
        if ($hasRegion) {
          if (-not (Has-Arg $argObj 'width') -or -not (Has-Arg $argObj 'height')) {
            Fail 'BAD_REQUEST' 'width and height are required when a capture region is given' @{ arguments = @('width', 'height') }
          }
          $gridX = Get-IntArg $argObj 'left' 0
          $gridY = Get-IntArg $argObj 'top' 0
          $gridW = Get-IntArg $argObj 'width' 0
          $gridH = Get-IntArg $argObj 'height' 0
          if ($gridW -le 0 -or $gridH -le 0) {
            Fail 'BAD_REQUEST' 'width and height must be positive' @{ width = $gridW; height = $gridH }
          }
          $mode = 'region'
        }
      }
      $clamped = $false
      # clamp（默认 true）：区域越界时裁剪到屏幕内并回报 clamped。
      # clamp:false 表示调用方要的是"严格区域"——越界必须报错，不能悄悄换一块地方拍。
      # 与 zoom 同名同义（此前只有 zoom 支持，screenshot 传了会被键名白名单拒绝）。
      $clamp = Get-BoolArg $argObj 'clamp' $true
      $inter = Intersect-Rect $gridX $gridY $gridW $gridH
      if ($inter.width -le 0 -or $inter.height -le 0) {
        Fail 'SCREENSHOT_FAILED' 'Capture region is entirely outside the virtual screen' @{ left = $gridX; top = $gridY; width = $gridW; height = $gridH }
      }
      if ($inter.changed -and -not $clamp) {
        Fail 'OUT_OF_BOUNDS' ('capture region (' + [string]$gridX + ',' + [string]$gridY + ',' + [string]$gridW + ',' + [string]$gridH + ') is outside the virtual screen') @{ left = $gridX; top = $gridY; width = $gridW; height = $gridH }
      }
      if ($inter.changed) { $clamped = $true }
      $gridX = $inter.x; $gridY = $inter.y; $gridW = $inter.width; $gridH = $inter.height

      $format = (Get-StrArg $argObj 'format' 'png').ToLowerInvariant()
      if ($format -eq 'jpg') { $format = 'jpeg' }
      if ($format -ne 'png' -and $format -ne 'jpeg') {
        Fail 'BAD_REQUEST' ('format must be "png" or "jpeg", got ' + $format) @{ argument = 'format' }
      }
      $quality = Clamp-Int (Get-IntArg $argObj 'quality' 80) 1 100
      $maxWidth = Get-IntArg $argObj 'max_width' 0

      $bmp = $null
      $scaled = $null
      try {
        $bmp = New-CaptureBitmap $gridX $gridY $gridW $gridH
        $rasterW = $bmp.Width
        $rasterH = $bmp.Height
        if ($maxWidth -gt 0) {
          $longest = $rasterW
          if ($rasterH -gt $longest) { $longest = $rasterH }
          if ($longest -gt $maxWidth) {
            $factor = [double]$maxWidth / [double]$longest
            $rasterW = [int][math]::Max(1, [math]::Round($bmp.Width * $factor))
            $rasterH = [int][math]::Max(1, [math]::Round($bmp.Height * $factor))
            $scaled = Resize-Bitmap $bmp $rasterW $rasterH
          }
        }
        $src = $scaled
        if ($null -eq $src) { $src = $bmp }
        $mediaType = 'image/png'
        if ($format -eq 'jpeg') { $mediaType = 'image/jpeg' }
        $bytes = Encode-Bitmap $src $format $quality
        $frameId = Next-FrameId
        $sourceObj = @{ x = $gridX; y = $gridY; width = $gridW; height = $gridH }
        $payload = New-FramePayload -FrameId $frameId -Bytes $bytes -MediaType $mediaType -RasterWidth $rasterW -RasterHeight $rasterH -Source $sourceObj -Mode $mode -Clamped $clamped -Zoomed $false -SourceWidth $gridW -SourceHeight $gridH
        $targetHwnd = Get-Arg $argObj 'target_hwnd' $null
        Set-LatestFrame $frameId $sourceObj $rasterW $rasterH $targetHwnd
        $script:cmdResult = $payload
      } finally {
        if ($null -ne $scaled) { $scaled.Dispose() }
        if ($null -ne $bmp) { $bmp.Dispose() }
      }
      return
    }

    'zoom' {
      if (-not (Has-Arg $argObj 'width') -or -not (Has-Arg $argObj 'height') -or -not (Has-Arg $argObj 'left') -or -not (Has-Arg $argObj 'top')) {
        Fail 'BAD_REQUEST' 'zoom requires left, top, width and height' @{ arguments = @('left', 'top', 'width', 'height') }
      }
      $zx = Get-IntArg $argObj 'left' 0
      $zy = Get-IntArg $argObj 'top' 0
      $zw = Get-IntArg $argObj 'width' 0
      $zh = Get-IntArg $argObj 'height' 0
      if ($zw -le 0 -or $zh -le 0) {
        Fail 'BAD_REQUEST' 'width and height must be positive' @{ width = $zw; height = $zh }
      }
      $zscale = Get-DoubleArg $argObj 'scale' 2.0
      if ($zscale -lt 1.0 -or $zscale -gt 8.0) {
        Fail 'BAD_REQUEST' 'scale must be between 1 and 8' @{ argument = 'scale'; value = $zscale }
      }
      $clamp = Get-BoolArg $argObj 'clamp' $true
      $inter = Intersect-Rect $zx $zy $zw $zh
      $clamped = $false
      if ($inter.changed) {
        if (-not $clamp) {
          Fail 'OUT_OF_BOUNDS' ('zoom region (' + [string]$zx + ',' + [string]$zy + ',' + [string]$zw + ',' + [string]$zh + ') is outside the virtual screen') @{ left = $zx; top = $zy; width = $zw; height = $zh }
        }
        $clamped = $true
      }
      if ($inter.width -le 0 -or $inter.height -le 0) {
        Fail 'OUT_OF_BOUNDS' 'zoom region is entirely outside the virtual screen' @{ left = $zx; top = $zy; width = $zw; height = $zh }
      }
      $zx = $inter.x; $zy = $inter.y; $zw = $inter.width; $zh = $inter.height

      $format = (Get-StrArg $argObj 'format' 'png').ToLowerInvariant()
      if ($format -eq 'jpg') { $format = 'jpeg' }
      if ($format -ne 'png' -and $format -ne 'jpeg') {
        Fail 'BAD_REQUEST' ('format must be "png" or "jpeg", got ' + $format) @{ argument = 'format' }
      }
      $quality = Clamp-Int (Get-IntArg $argObj 'quality' 80) 1 100

      $rasterW = [int][math]::Max(1, [math]::Round($zw * $zscale))
      $rasterH = [int][math]::Max(1, [math]::Round($zh * $zscale))
      # max_width：限制长边（与 screenshot 同语义）。缺这段时 DSH 的截图预算降级
      # 对 zoom 是静默无效的——它以为已经压小，实际字节数一点没变。
      $maxWidth = Get-IntArg $argObj 'max_width' 0
      if ($maxWidth -gt 0) {
        $longest = $rasterW
        if ($rasterH -gt $longest) { $longest = $rasterH }
        if ($longest -gt $maxWidth) {
          $factor = [double]$maxWidth / [double]$longest
          $rasterW = [int][math]::Max(1, [math]::Round($rasterW * $factor))
          $rasterH = [int][math]::Max(1, [math]::Round($rasterH * $factor))
        }
      }
      $bmp = $null
      $scaled = $null
      try {
        $bmp = New-CaptureBitmap $zx $zy $zw $zh
        $scaled = Resize-Bitmap $bmp $rasterW $rasterH
        $mediaType = 'image/png'
        if ($format -eq 'jpeg') { $mediaType = 'image/jpeg' }
        $bytes = Encode-Bitmap $scaled $format $quality
        $frameId = Next-FrameId
        $sourceObj = @{ x = $zx; y = $zy; width = $zw; height = $zh }
        $payload = New-FramePayload -FrameId $frameId -Bytes $bytes -MediaType $mediaType -RasterWidth $rasterW -RasterHeight $rasterH -Source $sourceObj -Mode 'zoom' -Clamped $clamped -Zoomed $true -SourceWidth $zw -SourceHeight $zh
        $targetHwnd = Get-Arg $argObj 'target_hwnd' $null
        Set-LatestFrame $frameId $sourceObj $rasterW $rasterH $targetHwnd
        $script:cmdResult = $payload
      } finally {
        if ($null -ne $scaled) { $scaled.Dispose() }
        if ($null -ne $bmp) { $bmp.Dispose() }
      }
      return
    }

    'list_apps' {
      Reset-ProcessInfoCacheIfStale
      $includeMinimized = Get-BoolArg $argObj 'include_minimized' $false
      try { $fg = [int][CuaNative]::GetForegroundHwnd() } catch { $fg = 0 }
      $entries = Get-AppWindows $includeMinimized
      $order = New-Object System.Collections.ArrayList
      $groups = @{}
      foreach ($e in $entries) {
        $k = [string]$e.appKey
        if (-not $groups.ContainsKey($k)) {
          $groups[$k] = New-Object System.Collections.ArrayList
          [void]$order.Add($k)
        }
        [void]$groups[$k].Add($e)
      }
      $apps = New-Object System.Collections.ArrayList
      foreach ($k in $order) {
        $items = $groups[$k]
        $first = $items[0]
        $wins = New-Object System.Collections.ArrayList
        $isFg = $false
        $canonicalPid = [int]$first.pid
        foreach ($e in $items) {
          $w = New-WindowPayload $e $fg
          [void]$wins.Add($w)
          if ($w.foreground) { $isFg = $true }
        }
        [void]$apps.Add([ordered]@{
          appKey      = [string]$k
          displayName = [string]$first.displayName
          process     = [string]$first.process
          pid         = $canonicalPid
          exePath     = [string]$first.exePath
          foreground  = $isFg
          windowCount = $wins.Count
          windows     = $wins.ToArray()
        })
      }
      $script:cmdResult = [ordered]@{ count = $apps.Count; apps = $apps.ToArray() }
      return
    }

    'list_windows' {
      Reset-ProcessInfoCacheIfStale
      try { $fg = [int][CuaNative]::GetForegroundHwnd() } catch { $fg = 0 }
      $entries = Get-AppWindows $true
      $filtered = New-Object System.Collections.ArrayList
      $hasFilter = $false
      $hwndFilter = Get-Arg $argObj 'hwnd' $null
      $pidFilter = Get-Arg $argObj 'pid' $null
      $appKeyFilter = Get-Arg $argObj 'appKey' $null
      $wantHwnd = [int64]0
      if ($null -ne $hwndFilter) {
        $hasFilter = $true
        $s = ([string]$hwndFilter).Trim()
        if ($s.StartsWith('0x') -or $s.StartsWith('0X')) {
          try { $wantHwnd = [Convert]::ToInt64($s.Substring(2), 16) } catch { $wantHwnd = 0 }
        } else {
          try { $wantHwnd = [int64]$s } catch { $wantHwnd = 0 }
        }
        if ($wantHwnd -eq 0) { Fail 'BAD_REQUEST' ('Invalid hwnd: ' + [string]$hwndFilter) @{ argument = 'hwnd' } }
      }
      $wantPid = -1
      if ($null -ne $pidFilter) {
        $hasFilter = $true
        $wantPid = 0
        if (-not [int]::TryParse([string]$pidFilter, [ref]$wantPid)) {
          Fail 'BAD_REQUEST' ('Invalid pid: ' + [string]$pidFilter) @{ argument = 'pid' }
        }
      }
      $wantAppKey = ''
      if ($null -ne $appKeyFilter) {
        $hasFilter = $true
        $wantAppKey = ([string]$appKeyFilter).ToLowerInvariant()
      }
      $wantTitle = ''
      $titleFilter = Get-Arg $argObj 'title' $null
      if ($null -ne $titleFilter) {
        $hasFilter = $true
        $wantTitle = ([string]$titleFilter).ToLowerInvariant()
      }
      $wantIndex = -1
      $indexFilter = Get-Arg $argObj 'window_index' $null
      if ($null -ne $indexFilter) {
        $hasFilter = $true
        $wantIndex = 0
        if (-not [int]::TryParse([string]$indexFilter, [ref]$wantIndex)) {
          Fail 'BAD_REQUEST' ('Invalid window_index: ' + [string]$indexFilter) @{ argument = 'window_index' }
        }
      }
      $matchedIndex = -1
      foreach ($e in $entries) {
        if ($hasFilter) {
          $match = $false
          if ($wantHwnd -ne 0 -and [int64]$e.row.Hwnd -eq $wantHwnd) { $match = $true }
          if ($wantPid -ge 0 -and ([int]$e.row.Pid -eq $wantPid -or [int]$e.pid -eq $wantPid)) { $match = $true }
          if ($wantAppKey -ne '' -and $e.appKey.ToLowerInvariant() -eq $wantAppKey) { $match = $true }
          if ($wantTitle -ne '' -and (([string]$e.row.Title).ToLowerInvariant()).Contains($wantTitle)) { $match = $true }
          if (-not $match) { continue }
        }
        $matchedIndex++
        if ($wantIndex -ge 0 -and $matchedIndex -ne $wantIndex) { continue }
        [void]$filtered.Add((New-WindowPayload $e $fg))
      }
      $script:cmdResult = [ordered]@{ count = $filtered.Count; windows = $filtered.ToArray() }
      return
    }

    'get_app_state' {
      $script:cmdResult = Invoke-AppState $argObj $true
      return
    }

    'click' {
      $button = (Get-StrArg $argObj 'button' 'left').ToLowerInvariant()
      $flags = Get-ButtonFlags $button
      $clicks = Clamp-Int (Get-IntArg $argObj 'clicks' 1) 1 3
      $interval = Clamp-Int (Get-IntArg $argObj 'interval_ms' 60) 0 5000
      $target = $null
      $elementIndexOut = $null
      $stateIdOut = $null
      $note = ''

      if (Has-Arg $argObj 'element_index') {
        $stored = Get-StateElement $argObj
        $stateIdOut = [string]$script:currentState.id
        Ensure-TargetForeground $script:currentState
        $center = Resolve-ElementCenter $stored
        $target = @{ x = $center.x; y = $center.y }
        $elementIndexOut = [int]$stored.index
        if ($center.fallback) { $note = ' (' + $center.reason + ')' }
        if ($button -eq 'left' -and ($null -ne $center.el)) {
          # 双击/三击语义交给 SendInput 连击
        }
      } else {
        $pt = Resolve-Point $argObj $true
        $target = @{ x = $pt.x; y = $pt.y }
      }

      $null = [CuaNative]::MouseTo($target.x, $target.y)
      $script:cursorX = $target.x
      $script:cursorY = $target.y
      $c = 0
      while ($c -lt $clicks) {
        $null = [CuaNative]::MouseFlag($flags.down)
        $null = [CuaNative]::MouseFlag($flags.up)
        $c++
        if ($c -lt $clicks -and $interval -gt 0) { [System.Threading.Thread]::Sleep($interval) }
      }

      $who = 'at (' + [string]$target.x + ',' + [string]$target.y + ')'
      if ($null -ne $elementIndexOut) { $who = 'element #' + [string]$elementIndexOut }
      $verb = 'Clicked'
      if ($clicks -eq 2) { $verb = 'Double-clicked' }
      if ($clicks -eq 3) { $verb = 'Triple-clicked' }
      $btn = ''
      if ($button -ne 'left') { $btn = ' with ' + $button + ' button' }

      $payload = [ordered]@{
        action_sent = $true
        target = [ordered]@{ x = $target.x; y = $target.y }
        text = $verb + ' ' + $who + $btn + $note
      }
      if ($null -ne $elementIndexOut) { $payload['target']['elementIndex'] = $elementIndexOut }
      if ($null -ne $stateIdOut) { $payload['state_id'] = $stateIdOut }
      $script:cmdResult = $payload
      return
    }

    'mouse_move' {
      $pt = Resolve-Point $argObj $true
      $duration = Clamp-Int (Get-IntArg $argObj 'duration_ms' 0) 0 60000
      Invoke-MouseMoveTo $pt.x $pt.y $duration
      $script:cmdResult = [ordered]@{
        action_sent = $true
        target = [ordered]@{ x = $pt.x; y = $pt.y }
      }
      return
    }

    'drag' {
      $button = (Get-StrArg $argObj 'button' 'left').ToLowerInvariant()
      $flags = Get-ButtonFlags $button
      $duration = Clamp-Int (Get-IntArg $argObj 'duration_ms' 300) 0 60000
      $fromPt = $null
      $toPt = $null
      $stateIdOut = $null
      $fromDesc = ''
      $toDesc = ''

      $hasFromElement = Has-Arg $argObj 'from_element_index'
      $hasToElement = Has-Arg $argObj 'to_element_index'
      if ($hasFromElement -or $hasToElement) {
        if (-not $hasFromElement -or -not $hasToElement) {
          Fail 'BAD_REQUEST' 'from_element_index and to_element_index must be provided together' @{ arguments = @('from_element_index', 'to_element_index') }
        }
        $fromStored = Get-StateElement @{ element_index = (Get-Arg $argObj 'from_element_index' $null); state_id = (Get-Arg $argObj 'state_id' $null) }
        $toStored = Get-StateElement @{ element_index = (Get-Arg $argObj 'to_element_index' $null); state_id = (Get-Arg $argObj 'state_id' $null) }
        $stateIdOut = [string]$script:currentState.id
        Ensure-TargetForeground $script:currentState
        $fc = Resolve-ElementCenter $fromStored
        $tc = Resolve-ElementCenter $toStored
        $fromPt = @{ x = $fc.x; y = $fc.y }
        $toPt = @{ x = $tc.x; y = $tc.y }
        $fromDesc = 'element #' + [string]$fromStored.index
        $toDesc = 'element #' + [string]$toStored.index
      } else {
        $fromArg = Get-Arg $argObj 'from' $null
        $toArg = Get-Arg $argObj 'to' $null
        if ($null -eq $fromArg -or $null -eq $toArg) {
          Fail 'BAD_REQUEST' 'drag requires from/to (each with x and y) or from_element_index/to_element_index' @{ arguments = @('from', 'to') }
        }
        $fp = Resolve-Point $fromArg $true
        $tp = Resolve-Point $toArg $true
        $fromPt = @{ x = $fp.x; y = $fp.y }
        $toPt = @{ x = $tp.x; y = $tp.y }
        $fromDesc = '(' + [string]$fp.x + ',' + [string]$fp.y + ')'
        $toDesc = '(' + [string]$tp.x + ',' + [string]$tp.y + ')'
      }

      Invoke-MouseMoveTo $fromPt.x $fromPt.y 0
      $script:dragButton = $button
      $null = [CuaNative]::MouseFlag($flags.down)
      Invoke-MouseMoveTo $toPt.x $toPt.y $duration
      $null = [CuaNative]::MouseFlag($flags.up)
      $script:dragButton = $null

      $payload = [ordered]@{
        action_sent = $true
        target = [ordered]@{ x = $toPt.x; y = $toPt.y; from = [ordered]@{ x = $fromPt.x; y = $fromPt.y } }
        text = 'Dragged from ' + $fromDesc + ' to ' + $toDesc + ' in ' + [string]$duration + 'ms'
      }
      if ($null -ne $stateIdOut) { $payload['state_id'] = $stateIdOut }
      $script:cmdResult = $payload
      return
    }

    'scroll' {
      $direction = (Get-StrArg $argObj 'direction' 'down').ToLowerInvariant()
      if ($direction -ne 'up' -and $direction -ne 'down' -and $direction -ne 'left' -and $direction -ne 'right') {
        Fail 'BAD_REQUEST' ('direction must be "up", "down", "left" or "right", got ' + $direction) @{ argument = 'direction' }
      }
      $amount = Clamp-Int (Get-IntArg $argObj 'amount' 3) 1 100
      $stateIdOut = $null
      $atDesc = ''

      if (Has-Arg $argObj 'element_index') {
        $stored = Get-StateElement $argObj
        $stateIdOut = [string]$script:currentState.id
        Ensure-TargetForeground $script:currentState
        $center = Resolve-ElementCenter $stored
        $null = [CuaNative]::MouseTo($center.x, $center.y)
        $script:cursorX = $center.x
        $script:cursorY = $center.y
        $atDesc = ' over element #' + [string]$stored.index
      } else {
        $pt = Resolve-Point $argObj $false
        if ($null -ne $pt) {
          $null = [CuaNative]::MouseTo($pt.x, $pt.y)
          $script:cursorX = $pt.x
          $script:cursorY = $pt.y
          $atDesc = ' at (' + [string]$pt.x + ',' + [string]$pt.y + ')'
        }
      }

      $delta = 120 * $amount
      $horizontal = $false
      if ($direction -eq 'up') { $delta = $delta }
      elseif ($direction -eq 'down') { $delta = -$delta }
      elseif ($direction -eq 'right') { $horizontal = $true }
      elseif ($direction -eq 'left') { $horizontal = $true; $delta = -$delta }
      $null = [CuaNative]::MouseWheel($delta, $horizontal)

      $payload = [ordered]@{
        action_sent = $true
        text = 'Scrolled ' + $direction + ' ' + [string]$amount + $atDesc
      }
      if ($null -ne $stateIdOut) { $payload['state_id'] = $stateIdOut }
      $script:cmdResult = $payload
      return
    }

    'type' {
      if (-not (Has-Arg $argObj 'text')) {
        Fail 'BAD_REQUEST' '"text" is required' @{ argument = 'text' }
      }
      $text = [string](Get-Arg $argObj 'text' '')
      $interval = Clamp-Int (Get-IntArg $argObj 'interval_ms' 0) 0 5000
      $stateIdOut = $null
      if (Has-Arg $argObj 'element_index') {
        $stored = Get-StateElement $argObj
        $stateIdOut = [string]$script:currentState.id
        Ensure-TargetForeground $script:currentState
        $center = Resolve-ElementCenter $stored
        $flags = Get-ButtonFlags 'left'
        $null = [CuaNative]::MouseTo($center.x, $center.y)
        $script:cursorX = $center.x
        $script:cursorY = $center.y
        $null = [CuaNative]::MouseFlag($flags.down)
        $null = [CuaNative]::MouseFlag($flags.up)
        [System.Threading.Thread]::Sleep(60)
      }
      $count = Invoke-TypeText $text $interval
      $payload = [ordered]@{
        action_sent = $true
        text = 'Typed ' + [string]$count + ' character'
        characters = $count
      }
      if ($count -ne 1) { $payload['text'] = 'Typed ' + [string]$count + ' characters' }
      if ($null -ne $stateIdOut) { $payload['state_id'] = $stateIdOut }
      $script:cmdResult = $payload
      return
    }

    'key' {
      # 元素目标：与 type 同语义——先把焦点点到该元素上，再发按键。
      # 之前 DSH 传了 element_index/state_id，原生完全没读，等于「元素目标静默降级成全局按键」。
      if (Has-Arg $argObj 'element_index') {
        $storedForKey = Get-StateElement $argObj
        Ensure-TargetForeground $script:currentState
        $centerForKey = Resolve-ElementCenter $storedForKey
        $null = [CuaNative]::MouseTo($centerForKey.x, $centerForKey.y)
        $script:cursorX = $centerForKey.x
        $script:cursorY = $centerForKey.y
        $null = [CuaNative]::MouseFlag([CuaNative]::MOUSEEVENTF_LEFTDOWN)
        $null = [CuaNative]::MouseFlag([CuaNative]::MOUSEEVENTF_LEFTUP)
        [System.Threading.Thread]::Sleep(60)
      }
      $spec = Parse-KeySpec $argObj
      $keys = @($spec.keys)
      $mods = @($spec.modifiers)
      if ($null -ne $spec.unicode) {
        $c = Invoke-TypeText ([string]$spec.unicode) 0
        $script:cmdResult = [ordered]@{
          action_sent = $true
          text = 'Typed character "' + (Limit-Text ([string]$spec.unicode) 20) + '"'
          modifiers = @()
          keys = @([string]$spec.unicode)
        }
        return
      }
      foreach ($m in $mods) {
        $null = [CuaNative]::KeyVk([int]$m, $false)
      }
      foreach ($k in $keys) {
        $null = [CuaNative]::KeyVk([int]$k, $false)
        $null = [CuaNative]::KeyVk([int]$k, $true)
      }
      $i = $mods.Count - 1
      while ($i -ge 0) {
        $null = [CuaNative]::KeyVk([int]$mods[$i], $true)
        $i--
      }

      $displayParts = New-Object System.Collections.ArrayList
      foreach ($m in @($spec.displayModifiers)) { [void]$displayParts.Add((Get-KeyDisplayName ([string]$m))) }
      foreach ($k in @($spec.displayKeys)) { [void]$displayParts.Add((Get-KeyDisplayName ([string]$k))) }
      $modNames = New-Object System.Collections.ArrayList
      foreach ($m in @($spec.displayModifiers)) { [void]$modNames.Add(([string]$m).ToLowerInvariant()) }
      $keyNames = New-Object System.Collections.ArrayList
      foreach ($k in @($spec.displayKeys)) { [void]$keyNames.Add(([string]$k).ToLowerInvariant()) }

      $script:cmdResult = [ordered]@{
        action_sent = $true
        text = 'Pressed ' + ($displayParts -join '+')
        modifiers = $modNames.ToArray()
        keys = $keyNames.ToArray()
      }
      return
    }

    'hold_key' {
      $spec = Parse-KeySpec $argObj
      $duration = Clamp-Int (Get-IntArg $argObj 'duration_ms' 500) 1 10000
      $keys = @($spec.keys)
      $mods = @($spec.modifiers)
      $displayParts = New-Object System.Collections.ArrayList
      foreach ($m in @($spec.displayModifiers)) { [void]$displayParts.Add((Get-KeyDisplayName ([string]$m))) }
      foreach ($k in @($spec.displayKeys)) { [void]$displayParts.Add((Get-KeyDisplayName ([string]$k))) }
      $label = ($displayParts -join '+')

      foreach ($m in $mods) {
        $null = [CuaNative]::KeyVk([int]$m, $false)
        [void]$script:heldKeys.Add(@{ name = [string]$script:modifierDisplay[[int]$m]; vk = [int]$m })
      }
      foreach ($k in $keys) {
        $null = [CuaNative]::KeyVk([int]$k, $false)
        $nm = 'key'
        if ($null -ne $spec.displayKeys -and @($spec.displayKeys).Count -gt 0) { $nm = ([string](@($spec.displayKeys)[0])).ToLowerInvariant() }
        [void]$script:heldKeys.Add(@{ name = $nm; vk = [int]$k })
      }
      try {
        [System.Threading.Thread]::Sleep($duration)
      } finally {
        $null = Invoke-ReleaseHeldKeys
      }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        text = 'Held ' + $label + ' for ' + [string]$duration + 'ms'
        durationMs = $duration
      }
      return
    }

    'set_value' {
      if (-not (Has-Arg $argObj 'value')) {
        Fail 'BAD_REQUEST' '"value" is required' @{ argument = 'value' }
      }
      $value = [string](Get-Arg $argObj 'value' '')
      $stored = Get-StateElement $argObj
      $stateIdOut = [string]$script:currentState.id
      Ensure-TargetForeground $script:currentState
      $reloc = Test-ElementRelocation $stored
      if ($null -eq $reloc.el) {
        Fail 'ELEMENT_UNAVAILABLE' ('Element #' + [string]$stored.index + ' is gone; cannot set its value') @{ element_index = [int]$stored.index }
      }
      $vp = $null
      $ok = $false
      try { $ok = $reloc.el.TryGetCurrentPattern($script:PatternValue, [ref]$vp) } catch { $ok = $false }
      if (-not $ok -or $null -eq $vp) {
        Fail 'NOT_SETTABLE' ('Element #' + [string]$stored.index + ' does not support the Value pattern') @{ element_index = [int]$stored.index; role = [string]$stored.role }
      }
      $readOnly = $false
      try { $readOnly = [bool]$vp.Current.IsReadOnly } catch { $readOnly = $false }
      if ($readOnly) {
        Fail 'NOT_SETTABLE' ('Element #' + [string]$stored.index + ' is read-only') @{ element_index = [int]$stored.index }
      }
      try {
        $vp.SetValue($value)
      } catch {
        Fail 'NOT_SETTABLE' ('Setting the value failed: ' + $_.Exception.Message) @{ element_index = [int]$stored.index }
      }
      if (Get-BoolArg $argObj 'submit' $false) {
        [System.Threading.Thread]::Sleep(50)
        $null = [CuaNative]::KeyVk(0x0D, $false)
        $null = [CuaNative]::KeyVk(0x0D, $true)
      }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        state_id = $stateIdOut
        value = $value
        text = 'Set value of element #' + [string]$stored.index
      }
      return
    }

    'select_text' {
      $stored = Get-StateElement $argObj
      $stateIdOut = [string]$script:currentState.id
      Ensure-TargetForeground $script:currentState
      $reloc = Test-ElementRelocation $stored
      if ($null -eq $reloc.el) {
        Fail 'ELEMENT_UNAVAILABLE' ('Element #' + [string]$stored.index + ' is gone; cannot select text') @{ element_index = [int]$stored.index }
      }
      $tp = $null
      $ok = $false
      try { $ok = $reloc.el.TryGetCurrentPattern($script:PatternText, [ref]$tp) } catch { $ok = $false }
      if (-not $ok -or $null -eq $tp) {
        Fail 'NOT_SELECTABLE' ('Element #' + [string]$stored.index + ' does not support the Text pattern') @{ element_index = [int]$stored.index; role = [string]$stored.role }
      }
      $docLen = 0
      try { $docLen = ([string]$tp.DocumentRange.GetText(-1)).Length } catch { $docLen = 0 }
      $all = Get-BoolArg $argObj 'all' $false
      $start = Clamp-Int (Get-IntArg $argObj 'start' 0) 0 2147483647
      $length = -1
      if (Has-Arg $argObj 'length') { $length = Clamp-Int (Get-IntArg $argObj 'length' 0) 0 2147483647 }
      if ($all -or $length -lt 0) {
        if ($start -gt $docLen) { $start = $docLen }
        if ($all -and -not (Has-Arg $argObj 'start')) { $start = 0 }
        $length = $docLen - $start
        if ($length -lt 0) { $length = 0 }
      }
      $range = $null
      try {
        $range = $tp.DocumentRange.Clone()
        $endPoint = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End
        $startPoint = [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start
        $charUnit = [System.Windows.Automation.Text.TextUnit]::Character
        if ($start -gt 0) { $null = $range.MoveEndpointByUnit($startPoint, $charUnit, $start) }
        $null = $range.MoveEndpointByRange($endPoint, $range, $startPoint)
        if ($length -gt 0) { $null = $range.MoveEndpointByUnit($endPoint, $charUnit, $length) }
        $range.Select()
      } catch {
        Fail 'NOT_SELECTABLE' ('Selecting text failed: ' + $_.Exception.Message) @{ element_index = [int]$stored.index }
      } finally {
        if ($null -ne $range) { try { $range.Dispose() } catch { } }
      }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        state_id = $stateIdOut
        selected = [ordered]@{ start = $start; length = $length }
        text = 'Selected ' + [string]$length + ' characters from offset ' + [string]$start
      }
      return
    }

    'perform_action' {
      $action = (Get-StrArg $argObj 'action' '').ToLowerInvariant()
      $valid = @('invoke', 'expand', 'collapse', 'toggle', 'select', 'focus', 'scroll_into_view')
      if ($valid -notcontains $action) {
        Fail 'BAD_REQUEST' ('action must be one of ' + ($valid -join ', ') + ', got "' + $action + '"') @{ argument = 'action' }
      }
      $stored = Get-StateElement $argObj
      $stateIdOut = [string]$script:currentState.id
      Ensure-TargetForeground $script:currentState
      $reloc = Test-ElementRelocation $stored
      if ($null -eq $reloc.el) {
        Fail 'ELEMENT_UNAVAILABLE' ('Element #' + [string]$stored.index + ' is gone; cannot perform ' + $action) @{ element_index = [int]$stored.index }
      }
      $el = $reloc.el
      $done = $false
      if ($action -eq 'focus') {
        try { $el.SetFocus(); $done = $true } catch { $done = $false }
      } elseif ($action -eq 'scroll_into_view') {
        $p = $null
        try { if ($el.TryGetCurrentPattern($script:PatternScrollItem, [ref]$p)) { $p.ScrollIntoView(); $done = $true } } catch { $done = $false }
      } else {
        $pattern = $null
        if ($action -eq 'invoke') { $pattern = $script:PatternInvoke }
        elseif ($action -eq 'expand' -or $action -eq 'collapse') { $pattern = $script:PatternExpandCollapse }
        elseif ($action -eq 'toggle') { $pattern = $script:PatternToggle }
        elseif ($action -eq 'select') { $pattern = $script:PatternSelectionItem }
        $p = $null
        $ok = $false
        try { $ok = $el.TryGetCurrentPattern($pattern, [ref]$p) } catch { $ok = $false }
        if ($ok -and $null -ne $p) {
          try {
            if ($action -eq 'invoke') { $p.Invoke() }
            elseif ($action -eq 'expand') { $p.Expand() }
            elseif ($action -eq 'collapse') { $p.Collapse() }
            elseif ($action -eq 'toggle') { $p.Toggle() }
            elseif ($action -eq 'select') { $p.Select() }
            $done = $true
          } catch {
            $done = $false
          }
        }
      }
      if (-not $done) {
        Fail 'ACTION_UNAVAILABLE' ('Element #' + [string]$stored.index + ' does not support action "' + $action + '"') @{ element_index = [int]$stored.index; action = $action; role = [string]$stored.role }
      }
      $verb = 'Performed ' + $action + ' on'
      if ($action -eq 'invoke') { $verb = 'Invoked' }
      elseif ($action -eq 'expand') { $verb = 'Expanded' }
      elseif ($action -eq 'collapse') { $verb = 'Collapsed' }
      elseif ($action -eq 'toggle') { $verb = 'Toggled' }
      elseif ($action -eq 'select') { $verb = 'Selected' }
      elseif ($action -eq 'focus') { $verb = 'Focused' }
      elseif ($action -eq 'scroll_into_view') { $verb = 'Scrolled into view' }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        state_id = $stateIdOut
        action = $action
        text = $verb + ' element #' + [string]$stored.index
      }
      return
    }

    'open_application' {
      $nameArg = Get-Arg $argObj 'name' $null
      $pathArg = Get-Arg $argObj 'path' $null
      $urlArg = Get-Arg $argObj 'url' $null
      $given = 0
      if ($null -ne $nameArg) { $given++ }
      if ($null -ne $pathArg) { $given++ }
      if ($null -ne $urlArg) { $given++ }
      if ($given -eq 0) {
        Fail 'BAD_REQUEST' 'One of name, path or url is required' @{ arguments = @('name', 'path', 'url') }
      }
      if ($given -gt 1) {
        Fail 'BAD_REQUEST' 'Only one of name, path or url may be given' @{ arguments = @('name', 'path', 'url') }
      }
      $waitMs = Clamp-Int (Get-IntArg $argObj 'wait_ms' 800) 0 30000
      $extraArgs = @()
      if (Has-Arg $argObj 'args') {
        $rawArgs = Get-Arg $argObj 'args' $null
        if ($rawArgs -is [System.Array]) {
          foreach ($a in $rawArgs) { $extraArgs += [string]$a }
        } else {
          $extraArgs += [string]$rawArgs
        }
      }

      $kind = ''
      $target = ''
      if ($null -ne $urlArg) { $kind = 'url'; $target = [string]$urlArg }
      elseif ($null -ne $pathArg) { $kind = 'path'; $target = [string]$pathArg }
      else { $kind = 'name'; $target = [string]$nameArg }
      if ([string]::IsNullOrWhiteSpace($target)) {
        Fail 'BAD_REQUEST' ('The ' + $kind + ' argument must not be empty') @{ argument = $kind }
      }

      $before = @{}
      $beforeHwnds = @{}
      try {
        foreach ($p in Get-Process) { $before[[string]$p.Id] = $true }
      } catch { }
      try {
        foreach ($r in [CuaNative]::ListWindows()) { $beforeHwnds[[string]$r.Hwnd] = $true }
      } catch { }

      $proc = $null
      try {
        $spArgs = @{
          FilePath = $target
          PassThru = $true
          ErrorAction = 'Stop'
        }
        if ($extraArgs.Count -gt 0) { $spArgs['ArgumentList'] = $extraArgs }
        $proc = Start-Process @spArgs
      } catch {
        $msg = $_.Exception.Message
        try {
          if ($null -ne $_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
        } catch { }
        Fail 'LAUNCH_FAILED' ('Could not launch "' + $target + '": ' + $msg) @{ kind = $kind; target = $target }
      }

      $launchedPid = 0
      if ($null -ne $proc) { $launchedPid = [int]$proc.Id }

      # 启动器经常立刻退出（例：Store 版记事本 notepad.exe → Notepad.exe），
      # 所以既找新进程也找新窗口，优先匹配被启动进程的窗口。
      $hwndFound = [int64]0
      $deadline = (Get-Date).AddMilliseconds($waitMs)
      $poll = 0
      $didProcessScan = $false
      while ($true) {
        if ($null -ne $proc -and $launchedPid -gt 0) {
          try { if ($proc.HasExited) { $launchedPid = 0 } } catch { }
        }
        $rows = $null
        try { $rows = [CuaNative]::ListWindows() } catch { $rows = $null }
        if ($null -ne $rows) {
          $fallbackHwnd = [int64]0
          $fallbackPid = 0
          foreach ($row in $rows) {
            if (-not $row.Visible) { continue }
            if ($row.Cloaked) { continue }
            if ([int]$row.Pid -eq [int]$script:processId) { continue }
            if ($beforeHwnds.ContainsKey([string]$row.Hwnd)) { continue }
            if ($launchedPid -gt 0 -and [int]$row.Pid -eq $launchedPid) {
              $hwndFound = [int64]$row.Hwnd
              break
            }
            if ($fallbackHwnd -eq 0) {
              $fallbackHwnd = [int64]$row.Hwnd
              $fallbackPid = [int]$row.Pid
            }
          }
          if ($hwndFound -eq 0 -and $fallbackHwnd -ne 0) {
            $hwndFound = $fallbackHwnd
            if ($launchedPid -le 0) { $launchedPid = $fallbackPid }
          }
        }
        if ($hwndFound -ne 0) { break }
        if (-not $didProcessScan) {
          $didProcessScan = $true
          if ($launchedPid -le 0) {
            try {
              foreach ($p in Get-Process) {
                if ($before.ContainsKey([string]$p.Id)) { continue }
                if ([string]::IsNullOrEmpty($p.MainWindowTitle)) { continue }
                $launchedPid = [int]$p.Id
                break
              }
            } catch { }
          }
        }
        if ((Get-Date) -ge $deadline) { break }
        $poll++
        if ($poll -gt 200) { break }
        [System.Threading.Thread]::Sleep(50)
      }

      $launched = [ordered]@{ kind = $kind; target = $target }
      if ($launchedPid -gt 0) { $launched['pid'] = $launchedPid }
      if ($hwndFound -ne 0) { $launched['hwnd'] = Format-Hwnd $hwndFound }
      $displayTarget = $target
      if ($kind -eq 'name') { $displayTarget = $target }
      if ($kind -eq 'path') {
        try { $displayTarget = [System.IO.Path]::GetFileNameWithoutExtension($target) } catch { }
      }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        launched = $launched
        text = 'Opened ' + $displayTarget
      }
      return
    }

    'focus_window' {
      $target = Resolve-Target $argObj
      $hwnd = [int64]$target.row.Hwnd
      $ok = $false
      try { $ok = [CuaNative]::ForceForeground($hwnd) } catch { $ok = $false }
      $attempt = 0
      while (-not $ok -and $attempt -lt 3) {
        $attempt++
        [System.Threading.Thread]::Sleep(70)
        try { $ok = [CuaNative]::ForceForeground($hwnd) } catch { $ok = $false }
      }
      if (-not $ok) {
        Fail 'FOREGROUND_REQUIRED' ('Window ' + [string](Format-Hwnd $hwnd) + ' ("' + (Limit-Text ([string]$target.row.Title) 60) + '") refused to come to the foreground') @{ hwnd = Format-Hwnd $hwnd; pid = [int]$target.row.Pid }
      }
      $title = [string]$target.row.Title
      $script:cmdResult = [ordered]@{
        action_sent = $true
        hwnd = Format-Hwnd $hwnd
        title = $title
        text = 'Focused "' + (Limit-Text $title 60) + '" (' + [string](Format-Hwnd $hwnd) + ')'
      }
      return
    }

    'clipboard_read' {
      $hasText = $false
      $text = ''
      $empty = $true
      try {
        $hasText = Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::ContainsText() }
      } catch {
        $hasText = $false
      }
      if ($hasText) {
        $text = [string](Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::GetText() })
        $empty = $false
      }
      if ($empty) {
        try {
          $dobj = Invoke-ClipboardRetry { [System.Windows.Forms.Clipboard]::GetDataObject() }
          if ($null -ne $dobj) { $empty = $false }
        } catch { }
      }
      $script:cmdResult = [ordered]@{
        text = $text
        hasText = [bool]$hasText
        empty = [bool]$empty
      }
      return
    }

    'clipboard_write' {
      if (-not (Has-Arg $argObj 'text')) {
        Fail 'BAD_REQUEST' '"text" is required' @{ argument = 'text' }
      }
      $text = [string](Get-Arg $argObj 'text' '')
      $null = Invoke-ClipboardRetry {
        if ([string]::IsNullOrEmpty($text)) {
          [System.Windows.Forms.Clipboard]::Clear()
        } else {
          [System.Windows.Forms.Clipboard]::SetText($text)
        }
        return $true
      }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        characters = (Get-CharCount $text)
      }
      return
    }

    'wait' {
      $duration = Clamp-Int (Get-IntArg $argObj 'duration_ms' 1000) 0 30000
      [System.Threading.Thread]::Sleep($duration)
      $seconds = [double]$duration / 1000.0
      $waitedText = 'Waited ' + $seconds.ToString('0.00') + 's'
      $payload = [ordered]@{ waitedMs = $duration; text = $waitedText }
      if ((Has-Arg $argObj 'appKey') -or (Has-Arg $argObj 'hwnd') -or (Has-Arg $argObj 'pid')) {
        $state = Invoke-AppState $argObj $false
        $payload['state_id'] = $state.state_id
        $payload['app'] = $state.app
        $payload['window'] = $state.window
        $payload['elementCount'] = $state.elementCount
        $payload['truncated'] = $state.truncated
        $payload['elements'] = $state.elements
        $payload['state_text'] = $state.text
      }
      $script:cmdResult = $payload
      return
    }

    'stop' {
      $releaseKeys = Get-BoolArg $argObj 'release_keys' $true
      $released = @()
      $endedDrag = $false
      if ($releaseKeys) {
        try { $released = Invoke-ReleaseHeldKeys } catch { $released = @() }
      }
      try { $endedDrag = Invoke-EndDrag } catch { $endedDrag = $false }
      $text = 'Released held keys'
      if (@($released).Count -eq 0) { $text = 'Nothing was held' }
      if ($endedDrag) { $text = $text + ' and finished the active drag' }
      $script:cmdResult = [ordered]@{
        action_sent = $true
        stopped = $true
        releasedKeys = @($released)
        text = $text
      }
      return
    }

    'shutdown' {
      try { $null = Invoke-ReleaseHeldKeys } catch { }
      try { $null = Invoke-EndDrag } catch { }
      $script:cmdResult = [ordered]@{ stopped = $true }
      return
    }

    default {
      Fail 'UNKNOWN_METHOD' ('Unknown cmd "' + $cmd + '"') @{ cmd = $cmd }
    }
  }
}

# ---------------------------------------------------------------------------
# 启动预热
#
# 第一次 get_app_state 慢（实测 400/16 首次 932ms，第二次 135ms），差额全是
# 一次性成本：枚举窗口 + 建进程表（~460ms）、跨进程 UIA 连接（~110ms）、
# C# walker 的 JIT（~150ms）。这些成本与「看哪个窗口」无关，可以在就绪前先付掉。
# 插件本身是 warmup=true 异步拉起后端的，所以这段时间用户感知不到；
# 换来的收益是「第一次让我看看屏幕」不再等一秒。
# 任何失败都只写诊断，绝不影响启动。
# ---------------------------------------------------------------------------
function Initialize-BackendCaches {
  try { $null = Get-ProcessTable } catch { Write-Diag ('warm process table failed: ' + $_.Exception.Message) }
  try { $null = [CuaNative]::ListWindows() } catch { Write-Diag ('warm window list failed: ' + $_.Exception.Message) }
  if (-not $script:uiaOk) { return }
  $hwnd = 0
  try { $hwnd = [int][CuaNative]::GetForegroundHwnd() } catch { $hwnd = 0 }
  if ($hwnd -eq 0) { return }
  try {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $script:rootCacheHwnd = [int64]$hwnd
    $script:rootCacheEl = $el
    # 真正跑一次小规模的树遍历：C# 侧的方法/JIT/属性缓存都在这里变热。
    $null = Build-ElementTree $el 8 2 1500
  } catch { Write-Diag ('warm uia tree failed: ' + $_.Exception.Message) }
}

# ---------------------------------------------------------------------------
# 就绪横幅 + 主循环
# ---------------------------------------------------------------------------
$readyScreen = $null
try {
  $readyScreen = Get-ScreenPayload
} catch {
  Write-Diag ('screen payload failed: ' + $_.Exception.Message)
  $readyScreen = [ordered]@{ dpiAware = $false; virtual = $null; monitors = @() }
}
$ready = [ordered]@{
  id = $null
  ok = $true
  event = 'ready'
  data = [ordered]@{
    protocol = 'dsh-cua/1'
    psVersion = $script:psVersion
    dpiAware = [bool][CuaNative]::IsProcessDPIAware()
    screen = $readyScreen
  }
}
Send-Object $ready

# 预热放在就绪横幅**之后**：先把 ready 发出去（宿主立刻可用），
# 再付一次性成本。这段时间宿主正在装技能/打日志、模型正在思考，
# 预热与它们并行，用户看不到；而就绪时间不被拖长。
Initialize-BackendCaches

$script:shouldExit = $false
while ($true) {
  $line = $null
  try {
    $line = [Console]::In.ReadLine()
  } catch {
    break
  }
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

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
    continue
  }

  if ([string]::IsNullOrEmpty($cmd)) {
    Respond-Err $reqId 'BAD_REQUEST' 'Request is missing the "cmd" field' @{}
    continue
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
      if ($null -ne $ex.Data -and $ex.Data.Contains('cuaCode')) {
        $failCode = [string]$ex.Data['cuaCode']
      }
    } catch { }
    try {
      if ($null -ne $ex.Data -and $ex.Data.Contains('cuaDetails')) {
        $failDetails = $ex.Data['cuaDetails']
      }
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
    break
  }
}

try { $null = Invoke-ReleaseHeldKeys } catch { }
try { $null = Invoke-EndDrag } catch { }
exit 0
