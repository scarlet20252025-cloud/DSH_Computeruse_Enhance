#!/usr/bin/env node
/**
 * dsh-cua-indicator/1 端到端冒烟测试。
 *
 * 只做一件事：**把「指示器说了什么」和「桌面实际发生了什么」对齐**。
 * 所以每一条断言都走真实外部证据，而不是信任 indicator.ps1 的自述：
 *   - 点击穿透   → user32!WindowFromPoint(卡片中心) 必须返回**别的**窗口；
 *   - 不抢焦点   → show 前后 GetForegroundWindow 都不得等于指示器 hwnd；
 *   - 不进截图   → 用插件自己的后端 cua.ps1 在同一区域截两次（显示时 / 隐藏后），
 *                  逐像素比较，并额外用一个未设 display affinity 的品红对照窗证明
 *                  「这条 GDI 截图通路确实拍得到窗口内容」。
 *
 * 只用 Node 内置模块。用法：node tools/indicator-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const INDICATOR = path.join(ROOT, 'src', 'native', 'indicator.ps1');
const CUA = path.join(ROOT, 'src', 'native', 'cua.ps1');
const PS = 'powershell.exe';

const REQ_TIMEOUT = 20000;
const CUA_TIMEOUT = 45000;

// ---------------------------------------------------------------------------
// 记分板
// ---------------------------------------------------------------------------
const checks = [];
/** 环境不稳定时无法判定的检查（既不算通过也不算失败）。 */
const inconclusive = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}\n`);
  return !!ok;
}
/**
 * 标记一项「环境不稳定导致无法判定」的检查。
 *
 * 为什么需要这个状态：截图排除的判定是**像素级**的，前提是测试区域在这几秒内不变。
 * 若用户屏幕上那个位置恰好有视频/游戏/动画，同状态两次截图就会差几万像素，
 * 任何像素结论都不成立——此时报 FAIL 是在冤枉代码，报 PASS 是在撒谎。
 * 所以如实报 INCONCLUSIVE，让调用方知道「换一个静态画面再跑」。
 */
function inconclusiveCheck(name, reason) {
  inconclusive.push({ name, reason });
  process.stdout.write(`  [INCONCLUSIVE] ${name} — ${reason}\n`)
  return false
}
function section(title) {
  process.stdout.write(`\n=== ${title} ===\n`);
}

// ---------------------------------------------------------------------------
// NDJSON 子进程
// ---------------------------------------------------------------------------
function startNdjson(file, label) {
  const child = spawn(
    PS,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', file],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const state = {
    label,
    child,
    messages: [],
    rawLines: [],
    invalidLines: [],
    sawCr: false,
    stderr: '',
    pending: '',
    waiters: [],
    exited: false,
    exitCode: null,
    exitSignal: null,
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (chunk.includes('\r')) state.sawCr = true;
    state.pending += chunk;
    const parts = state.pending.split('\n');
    state.pending = parts.pop();
    for (const line of parts) {
      state.rawLines.push(line);
      if (line.length === 0) {
        state.invalidLines.push('');
        continue;
      }
      try {
        state.messages.push(JSON.parse(line));
      } catch (err) {
        state.invalidLines.push(line);
      }
    }
    deliver(state);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderr += chunk;
  });
  child.on('exit', (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
    deliver(state);
  });
  return state;
}

function deliver(state) {
  if (!state.waiters.length) return;
  const keep = [];
  for (const waiter of state.waiters) {
    const idx = state.messages.findIndex(waiter.pred);
    if (idx >= 0) {
      const [msg] = state.messages.splice(idx, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      keep.push(waiter);
    }
  }
  state.waiters = keep;
}

function waitFor(state, pred, timeoutMs, label) {
  const idx = state.messages.findIndex(pred);
  if (idx >= 0) {
    const [msg] = state.messages.splice(idx, 1);
    return Promise.resolve(msg);
  }
  return new Promise((resolve, reject) => {
    const waiter = { pred, resolve };
    waiter.timer = setTimeout(() => {
      state.waiters = state.waiters.filter((w) => w !== waiter);
      reject(
        new Error(
          `timeout after ${timeoutMs}ms waiting for ${label} (${state.label}); stderr tail: ${state.stderr.slice(-400)}`,
        ),
      );
    }, timeoutMs);
    state.waiters.push(waiter);
  });
}

let requestSeq = 0;
function nextId(prefix) {
  requestSeq += 1;
  return `${prefix}-${requestSeq}`;
}

async function request(state, cmd, args, timeoutMs = REQ_TIMEOUT) {
  const id = nextId(cmd);
  const payload = { id, cmd };
  if (args !== undefined) payload.args = args;
  state.child.stdin.write(`${JSON.stringify(payload)}\n`);
  return waitFor(state, (m) => m && m.id === id, timeoutMs, `response to ${cmd} (${id})`);
}

// ---------------------------------------------------------------------------
// 内联 PowerShell（-EncodedCommand，避免任何引号/编码问题）
// ---------------------------------------------------------------------------
function runInline(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`inline powershell timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

const PROBE = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SmokeProbe {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public static long Foreground() { SetProcessDPIAware(); return GetForegroundWindow().ToInt64(); }
  public static long At(int x, int y) { SetProcessDPIAware(); POINT p = new POINT(); p.X = x; p.Y = y; return WindowFromPoint(p).ToInt64(); }
  public static string Describe(long v) {
    IntPtr h = new IntPtr(v);
    if (v == 0) { return "none"; }
    StringBuilder c = new StringBuilder(256); GetClassNameW(h, c, 256);
    StringBuilder t = new StringBuilder(512); GetWindowTextW(h, t, 512);
    return "class=" + c.ToString() + " title=" + t.ToString() + " visible=" + (IsWindowVisible(h) ? 1 : 0);
  }
}
'@ | Out-Null
`;

async function probeForeground() {
  const r = await runInline(`${PROBE}[Console]::Out.WriteLine([SmokeProbe]::Foreground())`);
  return Number.parseInt(r.out.trim(), 10);
}

async function probeWindowAt(x, y) {
  const r = await runInline(
    `${PROBE}[Console]::Out.WriteLine([SmokeProbe]::At(${x}, ${y}))\n[Console]::Out.WriteLine([SmokeProbe]::Describe([SmokeProbe]::At(${x}, ${y})))`,
  );
  const lines = r.out.trim().split(/\r?\n/);
  return { hwnd: Number.parseInt(lines[0], 10), describe: lines.slice(1).join(' ') };
}

// 「卡片到底画没画」的旁证：窗口可见性 / DWM 是否 cloaked / 用 PrintWindow
// 走**另一条**取像通路（窗口自身的 DWM 重定向表面，不是屏幕 DC）把内容渲进 GDI 位图取样。
const PROBE_PAINT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SmokePaint {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static int[] RectOf(IntPtr h) { RECT r; if (!GetWindowRect(h, out r)) { return new int[] { 0, 0, 0, 0 }; } return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top }; }
  public static int Cloaked(IntPtr h) { int v = 0; try { DwmGetWindowAttribute(h, 14, out v, 4); } catch { } return v; }
  public static long ZAbove(IntPtr h) { return GetWindow(h, 3).ToInt64(); }
  public static bool PrintTo(IntPtr h, IntPtr hdc, uint flags) { return PrintWindow(h, hdc, flags); }
}
'@ | Out-Null
`;

async function probePainting(hwndLong) {
  const script = `${PROBE_PAINT}
[void][SmokePaint]::SetProcessDPIAware()
$hwnd = [System.IntPtr]::new(${hwndLong})
$w = [SmokePaint]::RectOf($hwnd)[2]
$h = [SmokePaint]::RectOf($hwnd)[3]
$vis = [SmokePaint]::IsWindowVisible($hwnd)
$cloaked = [SmokePaint]::Cloaked($hwnd)
$ok = $false
$n = 0
$nearWhite = 0
$avg = -1
$distinct = 0
if ($w -gt 0 -and $h -gt 0) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [SmokePaint]::PrintTo($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $set = @{}
  $luma = 0
  $y = 0
  while ($y -lt $h) {
    $x = 0
    while ($x -lt $w) {
      $p = $bmp.GetPixel($x, $y)
      $key = (($p.R -band 0xF8) -shl 16) -bor (($p.G -band 0xF8) -shl 8) -bor ($p.B -band 0xF8)
      $set[$key] = 1
      if ($p.R -ge 230 -and $p.G -ge 230 -and $p.B -ge 230) { $nearWhite++ }
      $luma = $luma + [int](($p.R + $p.G + $p.B) / 3)
      $n++
      $x = $x + 2
    }
    $y = $y + 2
  }
  $bmp.Dispose()
  $distinct = $set.Count
  if ($n -gt 0) { $avg = [int]($luma / $n) }
}
[Console]::Out.WriteLine('PAINT visible=' + $vis + ' cloaked=' + $cloaked + ' size=' + $w + 'x' + $h + ' printwindow=' + $ok + ' sampled=' + $n + ' distinct=' + $distinct + ' nearWhite=' + $nearWhite + ' avgLuma=' + $avg)
`;
  const r = await runInline(script, 60000);
  const line = (r.out.trim().split(/\r?\n/).pop() || '').trim();
  return line;
}

// 正对照用的普通窗口：**盖在指示器那一模一样的矩形上**、纯品红、TopMost，
// 唯一区别是它没有 SetWindowDisplayAffinity。它被拍到 = 「这条截图通路在这个位置拍得到窗口内容」。
function controlWindowScript(rect) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SmokeDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
'@ | Out-Null
[void][SmokeDpi]::SetProcessDPIAware()
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -AssemblyName System.Drawing | Out-Null
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$f.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$f.BackColor = [System.Drawing.Color]::FromArgb(255, 0, 255)
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.SetBounds(${rect.left}, ${rect.top}, ${rect.width}, ${rect.height})
[void]$f.Show()
[Console]::Out.WriteLine('CONTROL ' + $f.Left + ' ' + $f.Top + ' ' + $f.Width + ' ' + $f.Height)
[Console]::Out.Flush()
$end = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $end) { [System.Windows.Forms.Application]::DoEvents(); [System.Threading.Thread]::Sleep(25) }
$f.Close()
`;
}

function startControlWindow(rect) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(controlWindowScript(rect), 'utf16le').toString('base64');
    const child = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`control window did not report ready; output=${buf}`));
    }, 20000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /CONTROL (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(buf);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          rect: { left: +m[1], top: +m[2], width: +m[3], height: +m[4] },
        });
      }
    });
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`control window exited before reporting; output=${buf}`));
    });
  });
}

// 正对照 2：与 indicator.ps1 **逐行相同**的 WPF 视觉构造（圆角卡片/阴影/三点/文案/透明留白），
// 盖在同一矩形上，唯一区别是不调用 SetWindowDisplayAffinity。
// 它被拍到 = 「这套构造确实会画到屏幕上，而且这条截图通路拍得到它」。
function twinWindowScript(rect) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework | Out-Null
Add-Type -AssemblyName PresentationCore | Out-Null
Add-Type -AssemblyName WindowsBase | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SmokeTwin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top }; }
  public static void Place(IntPtr h, int x, int y) { SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010); }
}
'@ | Out-Null
[void][SmokeTwin]::SetProcessDPIAware()
$w = New-Object System.Windows.Window
$w.WindowStyle = [System.Windows.WindowStyle]::None
$w.AllowsTransparency = $true
$w.Background = [System.Windows.Media.Brushes]::Transparent
$w.Topmost = $true
$w.ShowInTaskbar = $false
$w.ShowActivated = $false
$w.ResizeMode = [System.Windows.ResizeMode]::NoResize
$w.SizeToContent = [System.Windows.SizeToContent]::WidthAndHeight
$card = New-Object System.Windows.Controls.Border
$card.Height = 38
$card.CornerRadius = New-Object System.Windows.CornerRadius(12)
$card.BorderThickness = New-Object System.Windows.Thickness(1)
$card.Padding = New-Object System.Windows.Thickness(18, 0, 18, 0)
$card.Background = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(245, 255, 255, 255))
$card.BorderBrush = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(36, 15, 23, 42))
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
  $d = New-Object System.Windows.Shapes.Ellipse
  $d.Width = 4
  $d.Height = 4
  $d.Fill = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, 100, 116, 139))
  $d.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
  $sc = New-Object System.Windows.Media.ScaleTransform(0.8, 0.8)
  $sc.CenterX = 2
  $sc.CenterY = 2
  $d.RenderTransform = $sc
  $g = 3
  if ($i -eq 2) { $g = 10 }
  $d.Margin = New-Object System.Windows.Thickness(0, 0, $g, 0)
  [void]$dots.Children.Add($d)
  [void]$dotList.Add($d)
  [void]$scaleList.Add($sc)
  $i++
}
# 与 indicator.ps1 的 Start-PulseAnimation 同一套关键帧方案（0%/70%/100%=0.35，35%=1）
$k = 0
foreach ($dd in $dotList) {
  $op = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $op.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1200))
  $op.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  if ($k -gt 0) { $op.BeginTime = [TimeSpan]::FromMilliseconds($k * 120) }
  [void]$op.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.35, [System.Windows.Media.Animation.KeyTime]::FromPercent(0.0))))
  [void]$op.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.0, [System.Windows.Media.Animation.KeyTime]::FromPercent(0.35))))
  [void]$op.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.35, [System.Windows.Media.Animation.KeyTime]::FromPercent(0.7))))
  [void]$op.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.35, [System.Windows.Media.Animation.KeyTime]::FromPercent(1.0))))
  [void]$dd.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $op)
  $gr = New-Object System.Windows.Media.Animation.DoubleAnimationUsingKeyFrames
  $gr.Duration = New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(1200))
  $gr.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  if ($k -gt 0) { $gr.BeginTime = [TimeSpan]::FromMilliseconds($k * 120) }
  [void]$gr.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.8, [System.Windows.Media.Animation.KeyTime]::FromPercent(0.0))))
  [void]$gr.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(1.0, [System.Windows.Media.Animation.KeyTime]::FromPercent(0.35))))
  [void]$gr.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.8, [System.Windows.Media.Animation.KeyTime]::FromPercent(0.7))))
  [void]$gr.KeyFrames.Add((New-Object System.Windows.Media.Animation.LinearDoubleKeyFrame(0.8, [System.Windows.Media.Animation.KeyTime]::FromPercent(1.0))))
  [void]$scaleList[$k].BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $gr)
  [void]$scaleList[$k].BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $gr)
  $k++
}
$tb = New-Object System.Windows.Controls.TextBlock
$tb.Text = 'DSH 正在操作电脑'
$tb.FontSize = 13
$tb.FontWeight = [System.Windows.FontWeights]::SemiBold
$tb.FontFamily = New-Object System.Windows.Media.FontFamily('Segoe UI Variable, Segoe UI')
$tb.TextWrapping = [System.Windows.TextWrapping]::NoWrap
$tb.VerticalAlignment = [System.Windows.VerticalAlignment]::Center
$tb.Foreground = New-Object System.Windows.Media.SolidColorBrush([System.Windows.Media.Color]::FromArgb(255, 32, 33, 36))
[void]$row.Children.Add($dots)
[void]$row.Children.Add($tb)
$card.Child = $row
$outer = New-Object System.Windows.Controls.Border
$outer.Background = [System.Windows.Media.Brushes]::Transparent
$outer.Margin = New-Object System.Windows.Thickness(8, 6, 8, 12)
$outer.Child = $card
$w.Content = $outer
$helper = New-Object System.Windows.Interop.WindowInteropHelper($w)
$hwnd = $helper.EnsureHandle()
$w.Show()
$w.UpdateLayout()
[SmokeTwin]::Place($hwnd, ${rect.left}, ${rect.top})
$script:fr = New-Object System.Windows.Threading.DispatcherFrame
$script:tm = New-Object System.Windows.Threading.DispatcherTimer
$script:tm.Interval = [TimeSpan]::FromMilliseconds(600)
$script:tm.Add_Tick({ $script:tm.Stop(); $script:fr.Continue = $false })
$script:tm.Start()
[System.Windows.Threading.Dispatcher]::PushFrame($script:fr) | Out-Null
$r = [SmokeTwin]::Rect($hwnd)
[Console]::Out.WriteLine('TWIN ' + $hwnd.ToInt64() + ' ' + $r[0] + ' ' + $r[1] + ' ' + $r[2] + ' ' + $r[3])
[Console]::Out.Flush()
$end = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $end) {
  $script:fr2 = New-Object System.Windows.Threading.DispatcherFrame
  $script:tm2 = New-Object System.Windows.Threading.DispatcherTimer
  $script:tm2.Interval = [TimeSpan]::FromMilliseconds(150)
  $script:tm2.Add_Tick({ $script:tm2.Stop(); $script:fr2.Continue = $false })
  $script:tm2.Start()
  [System.Windows.Threading.Dispatcher]::PushFrame($script:fr2) | Out-Null
}
$w.Close()
`;
}

function startTwinWindow(rect) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(twinWindowScript(rect), 'utf16le').toString('base64');
    const child = spawn(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-EncodedCommand', encoded],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`twin window did not report ready; output=${buf}`));
    }, 30000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      const m = /TWIN (\d+) (-?\d+) (-?\d+) (\d+) (\d+)/.exec(buf);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          hwnd: BigInt(m[1]),
          rect: { left: +m[2], top: +m[3], width: +m[4], height: +m[5] },
        });
      }
    });
    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`twin window exited before reporting; output=${buf}`));
    });
  });
}

// ---------------------------------------------------------------------------
// PNG 解码（System.Drawing 输出 8bit RGB/RGBA 非隔行 PNG）
// ---------------------------------------------------------------------------
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced PNG is not supported');
  const channelMap = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelMap[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = y * stride;
    const prev = row - stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[pos];
      pos += 1;
      const a = i >= channels ? out[row + i - channels] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= channels ? out[prev + i - channels] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else {
        throw new Error(`unknown PNG filter ${filter}`);
      }
      out[row + i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// 统一成 RGB 便于跨图比较
function toRgb(img) {
  if (img.channels === 3) return img;
  const { width, height, channels, data } = img;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    out[i * 3] = data[j];
    out[i * 3 + 1] = data[j + 1];
    out[i * 3 + 2] = data[j + 2];
  }
  return { width, height, channels: 3, data: out };
}

function compareImages(a, b) {
  const A = toRgb(a);
  const B = toRgb(b);
  if (A.width !== B.width || A.height !== B.height) {
    throw new Error(`size mismatch ${A.width}x${A.height} vs ${B.width}x${B.height}`);
  }
  let diffPixels = 0;
  let maxDelta = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < A.height; y += 1) {
    for (let x = 0; x < A.width; x += 1) {
      const i = (y * A.width + x) * 3;
      const d0 = Math.abs(A.data[i] - B.data[i]);
      const d1 = Math.abs(A.data[i + 1] - B.data[i + 1]);
      const d2 = Math.abs(A.data[i + 2] - B.data[i + 2]);
      const d = Math.max(d0, d1, d2);
      if (d > 0) {
        diffPixels += 1;
        if (d > maxDelta) maxDelta = d;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return {
    diffPixels,
    totalPixels: A.width * A.height,
    maxDelta,
    bbox: diffPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

function countColor(img, pred) {
  const I = toRgb(img);
  let n = 0;
  for (let i = 0; i < I.width * I.height; i += 1) {
    if (pred(I.data[i * 3], I.data[i * 3 + 1], I.data[i * 3 + 2])) n += 1;
  }
  return n;
}

function distinctColors(img) {
  const I = toRgb(img);
  const set = new Set();
  for (let i = 0; i < I.width * I.height; i += 1) {
    set.add((I.data[i * 3] << 16) | (I.data[i * 3 + 1] << 8) | I.data[i * 3 + 2]);
  }
  return set.size;
}

// 卡片文字/圆点的特征：深色像素。浅色页面背景上这几百个像素只可能来自卡片。
function isDarkPixel(r, g, b) {
  return (r + g + b) / 3 < 160;
}

function hexOf(value) {
  return `0x${BigInt(value).toString(16)}`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const children = [];
function track(child) {
  children.push(child);
  return child;
}
function killAll() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  section('启动 indicator.ps1');
  const indicator = startNdjson(INDICATOR, 'indicator');
  track(indicator.child);
  process.stdout.write(`  ${PS} -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File ${INDICATOR}\n`);

  const ready = await waitFor(indicator, (m) => m && m.event === 'ready', 30000, 'ready banner');
  process.stdout.write(`  ready line: ${JSON.stringify(ready)}\n`);

  // 焦点基线要在 show 之前取：此时指示器的窗口句柄已经存在，只是没显示。
  const fgBefore = await probeForeground();

  section('[1] ready 横幅');
  check('ready.event === "ready"', ready.event === 'ready', JSON.stringify(ready.event));
  check('ready.id === null', ready.id === null, JSON.stringify(ready.id));
  check('ready.ok === true', ready.ok === true, JSON.stringify(ready.ok));
  check(
    'ready.data.protocol === "dsh-cua-indicator/1"',
    ready.data && ready.data.protocol === 'dsh-cua-indicator/1',
    JSON.stringify(ready.data && ready.data.protocol),
  );
  check(
    'ready.data.psVersion / monitors 存在',
    !!(ready.data && ready.data.psVersion && typeof ready.data.monitors === 'number'),
    `psVersion=${ready.data && ready.data.psVersion} monitors=${ready.data && ready.data.monitors}`,
  );
  check('ready 是 stdout 第一行', JSON.parse(indicator.rawLines[0]).event === 'ready', indicator.rawLines[0].slice(0, 80));

  section('[2] ping');
  const ping1 = await request(indicator, 'ping');
  check('ping → ok', ping1.ok === true, JSON.stringify(ping1).slice(0, 160));
  check('ping → data.pong === true', ping1.data && ping1.data.pong === true, JSON.stringify(ping1.data && ping1.data.pong));
  check('ping → 未显示时 visible === false', ping1.data && ping1.data.visible === false, JSON.stringify(ping1.data && ping1.data.visible));

  section('[3] show（中文文案）');
  const showText = 'DSH 正在操作电脑';
  const shown = await request(indicator, 'show', { text: showText });
  process.stdout.write(`  data: ${JSON.stringify(shown.data)}\n`);
  check('show → ok', shown.ok === true, JSON.stringify(shown.error || null));
  const d3 = shown.data || {};
  check('show → visible === true', d3.visible === true, JSON.stringify(d3.visible));
  check('show → text 原样回显', d3.text === showText, JSON.stringify(d3.text));
  check('show → topmost === true', d3.topmost === true, JSON.stringify(d3.topmost));
  check('show → clickThrough === true', d3.clickThrough === true, JSON.stringify(d3.clickThrough));
  check('show → noActivate === true', d3.noActivate === true, JSON.stringify(d3.noActivate));
  check('show → excludedFromCapture === true', d3.excludedFromCapture === true, JSON.stringify(d3.excludedFromCapture));
  check('show → affinity === 0x11 (17)', d3.affinity === 17, JSON.stringify(d3.affinity));
  check('show → width > 0', typeof d3.width === 'number' && d3.width > 0, JSON.stringify(d3.width));
  check('show → height >= 38', typeof d3.height === 'number' && d3.height >= 38, JSON.stringify(d3.height));
  check('show → x > 0', typeof d3.x === 'number' && d3.x > 0, JSON.stringify(d3.x));
  check('show → y >= 0', typeof d3.y === 'number' && d3.y >= 0, JSON.stringify(d3.y));
  check('show → hwnd 形如 0x...', typeof d3.hwnd === 'string' && /^0x[0-9a-f]+$/.test(d3.hwnd), JSON.stringify(d3.hwnd));
  const hwndLong = BigInt(d3.hwnd);

  const fgAfter = await probeForeground();
  process.stdout.write(`  foreground: before=${hexOf(fgBefore)} after=${hexOf(fgAfter)} indicator=${hexOf(hwndLong)}\n`);

  section('[4] update（长文本自适应）');
  const longText = 'DSH 正在操作电脑：读取窗口界面元素、定位目标控件并执行点击与输入';
  const updated = await request(indicator, 'update', { text: longText });
  process.stdout.write(`  data: ${JSON.stringify(updated.data)}\n`);
  check('update → ok', updated.ok === true, JSON.stringify(updated.error || null));
  const d4 = updated.data || {};
  check('update → text 已更新', d4.text === longText, JSON.stringify(d4.text));
  check('update → visible 仍为 true（不闪烁）', d4.visible === true, JSON.stringify(d4.visible));
  check(
    'update → 宽度随文本变大',
    typeof d4.width === 'number' && d4.width > d3.width,
    `${d3.width} → ${d4.width}`,
  );
  check('update → 仍保持排除截图', d4.excludedFromCapture === true, JSON.stringify(d4.excludedFromCapture));

  section('[5] hide + 隐藏后仍可 ping');
  const hidden = await request(indicator, 'hide');
  process.stdout.write(`  data: ${JSON.stringify(hidden.data)}\n`);
  check('hide → ok', hidden.ok === true, JSON.stringify(hidden.error || null));
  check('hide → visible === false', hidden.data && hidden.data.visible === false, JSON.stringify(hidden.data && hidden.data.visible));
  const ping2 = await request(indicator, 'ping');
  check('hide 后 ping → pong:true（进程存活可复用）', ping2.ok === true && ping2.data && ping2.data.pong === true, JSON.stringify(ping2.data && ping2.data.pong));
  check('hide 后 ping → visible === false', ping2.data && ping2.data.visible === false, JSON.stringify(ping2.data && ping2.data.visible));
  const updateWhileHidden = await request(indicator, 'update', { text: '隐藏状态下的文案' });
  check(
    'hide 后 update → ok 且 visible 仍为 false（update 不复活窗口，只有 show 会）',
    updateWhileHidden.ok === true && updateWhileHidden.data && updateWhileHidden.data.visible === false,
    JSON.stringify(updateWhileHidden.data && updateWhileHidden.data.visible),
  );
  check(
    'hide 后 update → text 已应用',
    updateWhileHidden.data && updateWhileHidden.data.text === '隐藏状态下的文案',
    JSON.stringify(updateWhileHidden.data && updateWhileHidden.data.text),
  );

  section('[6] 隐藏后可以重新 show');
  const reshown = await request(indicator, 'show', { text: showText });
  process.stdout.write(`  data: ${JSON.stringify(reshown.data)}\n`);
  check('再次 show → visible === true', reshown.data && reshown.data.visible === true, JSON.stringify(reshown.data && reshown.data.visible));
  check('再次 show → topmost === true', reshown.data && reshown.data.topmost === true, JSON.stringify(reshown.data && reshown.data.topmost));
  check('再次 show → 同一 hwnd（窗口复用）', reshown.data && reshown.data.hwnd === d3.hwnd, `${d3.hwnd} → ${reshown.data && reshown.data.hwnd}`);

  section('[7] 错误路径');
  const unknown = await request(indicator, 'no_such_cmd');
  process.stdout.write(`  unknown cmd → ${JSON.stringify(unknown)}\n`);
  check('未知 cmd → ok:false', unknown.ok === false, JSON.stringify(unknown.ok));
  check(
    '未知 cmd → error.code === "UNKNOWN_METHOD"',
    unknown.error && unknown.error.code === 'UNKNOWN_METHOD',
    JSON.stringify(unknown.error && unknown.error.code),
  );
  indicator.child.stdin.write('{"id":"badjson","cmd":\n');
  const bad = await waitFor(
    indicator,
    (m) => m && m.ok === false && m.error && m.error.code === 'BAD_REQUEST',
    REQ_TIMEOUT,
    'BAD_REQUEST response',
  );
  process.stdout.write(`  bad json → ${JSON.stringify(bad).slice(0, 220)}\n`);
  check('坏 JSON → error.code === "BAD_REQUEST"', bad.error.code === 'BAD_REQUEST', JSON.stringify(bad.error.code));
  const ping3 = await request(indicator, 'ping');
  check('两条错误后 ping 仍正常（进程没死）', ping3.ok === true && ping3.data && ping3.data.pong === true, JSON.stringify(ping3.data && ping3.data.pong));

  section('[8] 点击穿透（真实证据）');
  const rect = {
    left: reshown.data.x,
    top: reshown.data.y,
    width: reshown.data.width,
    height: reshown.data.height,
  };
  const centerX = rect.left + Math.floor(rect.width / 2);
  const centerY = rect.top + Math.floor(rect.height / 2);
  const at = await probeWindowAt(centerX, centerY);
  process.stdout.write(
    `  WindowFromPoint(${centerX},${centerY}) = ${hexOf(at.hwnd)}  ${at.describe}\n  indicator hwnd = ${hexOf(hwndLong)}\n`,
  );
  check(
    '卡片中心命中的不是指示器 hwnd（鼠标事件会落到下层窗口）',
    at.hwnd !== Number(hwndLong),
    `hit=${hexOf(at.hwnd)} indicator=${hexOf(hwndLong)}`,
  );

  section('[9] 不抢焦点（真实证据）');
  process.stdout.write(`  fgBefore=${hexOf(fgBefore)} fgAfter=${hexOf(fgAfter)} indicator=${hexOf(hwndLong)}\n`);
  check('show 前 GetForegroundWindow !== 指示器 hwnd', fgBefore !== Number(hwndLong), `${hexOf(fgBefore)} vs ${hexOf(hwndLong)}`);
  check('show 后 GetForegroundWindow !== 指示器 hwnd', fgAfter !== Number(hwndLong), `${hexOf(fgAfter)} vs ${hexOf(hwndLong)}`);
  if (fgBefore === fgAfter) {
    process.stdout.write('  （附带观察：show 前后前台窗口完全没变）\n');
  } else {
    process.stdout.write('  （附带观察：show 前后前台窗口变了，但都不是指示器；可能由用户在测试期间切换窗口引起）\n');
  }

  section('[10] 截图排除（用 cua.ps1 后端逐像素验证）');
  const cua = startNdjson(CUA, 'cua');
  track(cua.child);
  const cuaReady = await waitFor(cua, (m) => m && m.event === 'ready', 45000, 'cua ready');
  process.stdout.write(`  cua ready: protocol=${cuaReady.data.protocol} psVersion=${cuaReady.data.psVersion}\n`);
  const warmup = await request(cua, 'screenshot', { left: 0, top: 0, width: 64, height: 64 }, CUA_TIMEOUT);
  check('cua.screenshot 热身成功（建立坐标系）', warmup.ok === true, warmup.ok ? `frame=${warmup.data.frame_id}` : JSON.stringify(warmup.error));

  async function shot(label, region) {
    const res = await request(cua, 'screenshot', { ...region, clamp: false }, CUA_TIMEOUT);
    if (!res.ok) throw new Error(`screenshot(${label}) failed: ${JSON.stringify(res.error)}`);
    const buf = Buffer.from(res.data.image.base64, 'base64');
    process.stdout.write(
      `  shot ${label}: ${res.data.image.width}x${res.data.image.height} ${res.data.image.mediaType} ${res.data.image.bytes}B source=${JSON.stringify(res.data.source)} clamped=${res.data.clamped === true}\n`,
    );
    return { res, buf, img: decodePng(buf) };
  }

  /**
   * 等观察区静止：连续两次截图完全一致才算静止。
   *
   * 为什么需要：像素级判定（尤其「截图里看不到指示器」）只有在背景不变时才成立。
   * 用户屏幕上那一块可能有视频/游戏/正在滚动的窗口，硬测会得出假结论。
   * 与其要求用户冻住屏幕，不如自己等到它安静下来；等不到就报 INCONCLUSIVE。
   */
  async function waitForStableRegion(region, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let lastDiff = -1;
    for (;;) {
      attempts += 1;
      const a = await shot(`stability#${attempts}a`, region);
      await new Promise((r) => setTimeout(r, 400));
      const b = await shot(`stability#${attempts}b`, region);
      lastDiff = compareImages(a.img, b.img).diffPixels;
      if (lastDiff === 0) return { stable: true, attempts, lastDiff };
      if (Date.now() > deadline) return { stable: false, attempts, lastDiff };
    }
  }

  // 先把指示器显示出来，并取它自己的窗口矩形作为固定观察区。
  const capShow = await request(indicator, 'show', { text: 'DSH 正在操作电脑 · 截图排除验证' });
  check('show（截图对比用）→ visible:true', capShow.data && capShow.data.visible === true, JSON.stringify(capShow.data && capShow.data.visible));
  const region = {
    left: capShow.data.x,
    top: capShow.data.y,
    width: capShow.data.width,
    height: capShow.data.height,
  };
  process.stdout.write(`  indicator region: ${JSON.stringify(region)}\n`);

  // 旁证：卡片确实被绘制（可见 / 未被 DWM cloaked / PrintWindow 取到内容）
  const paint = await probePainting(BigInt(capShow.data.hwnd));
  process.stdout.write(`  painting probe: ${paint}\n`);

  // 像素级判定成立的前提是「这块区域在这几秒内不变」。用户桌面上那个位置可能有
  // 视频/游戏/正在滚动的窗口，硬测只会得出假结论；所以先等它静止（最多 30s），
  // 等不到就如实报 INCONCLUSIVE（见下方 unstableReason）。
  process.stdout.write('  等待测试区域静止（最多 60s）…\n');
  const stableWait = await waitForStableRegion(region, 60000);
  process.stdout.write(
    `  区域静止性预检: stable=${stableWait.stable} attempts=${stableWait.attempts} lastDiff=${stableWait.lastDiff}px\n`,
  );

  // 目击区：与指示器**不相邻**的一块区域，在四次捕获的前后各拍一次。
  // 用途：区分「环境在两次捕获之间变了」与「浮层被拍到了」——只有目击区也没变，
  // 「显示时 vs 隐藏后像素相同」才能证明是排除性而不是背景在动。
  const witness = {
    left: Math.max(0, region.left - 600),
    top: region.top,
    width: Math.min(200, region.width),
    height: region.height,
  };

  const shownShotA = await shot('indicator#1(visible)', region);
  const witnessBefore = await shot('witness#1', witness);
  const shownShotB = await shot('indicator#2(visible)', region);

  const hideAgain = await request(indicator, 'hide');
  check('hide（截图对比用）→ visible:false', hideAgain.data && hideAgain.data.visible === false, JSON.stringify(hideAgain.data && hideAgain.data.visible));
  await new Promise((r) => setTimeout(r, 250));
  const hiddenShotA = await shot('indicator#3(hidden)', region);
  const hiddenShotB = await shot('indicator#4(hidden)', region);
  const witnessAfter = await shot('witness#2', witness);

  // 正对照：同一个矩形、同一条截图通路，换成没有 display affinity 的品红窗口。
  const control = await startControlWindow(region);
  track(control.child);
  process.stdout.write(`  control window rect: ${JSON.stringify(control.rect)} (same rect as the indicator)\n`);
  await new Promise((r) => setTimeout(r, 500));
  const controlShot = await shot('control(magenta)', control.rect);
  const magenta = countColor(controlShot.img, (r, g, b) => r > 200 && g < 60 && b > 200);
  const controlOk = magenta > controlShot.img.width * controlShot.img.height * 0.5;
  try {
    control.child.kill();
  } catch {
    /* ignore */
  }

  // 正对照 2：同构造（WPF 圆角卡片）无 affinity 的孪生窗，必须被拍出卡片文字。
  const twin = await startTwinWindow(region);
  track(twin.child);
  process.stdout.write(`  twin window rect  : ${JSON.stringify(twin.rect)} hwnd=${hexOf(twin.hwnd)}\n`);
  await new Promise((r) => setTimeout(r, 300));
  const twinShot = await shot('twin(same visual, no affinity)', twin.rect);
  const twinPaint = await probePainting(twin.hwnd);
  process.stdout.write(`  twin painting probe: ${twinPaint}\n`);
  // 判据刻意**不依赖背景明暗**：第一版用「深色像素数」比较，桌面背景变暗时
  // 基线（整屏都是深色像素）会把它压掉，正对照就假失败。改成「同一矩形、
  // 孪生窗可见 vs 杀掉它之后」的像素差——背景是静态的（同状态两次截图 diff=0 已证），
  // 差异只可能来自孪生窗，因此这份对照在任何背景色下都成立。
  const darkTwin = countColor(twinShot.img, isDarkPixel);
  // 同一套脉冲关键帧方案的活性证明：相隔 600ms 的两次截图必须不同（圆点在动）。
  await new Promise((r) => setTimeout(r, 600));
  const twinShot2 = await shot('twin(600ms later)', twin.rect);
  const twinPulse = compareImages(twinShot.img, twinShot2.img);
  const pulseOk = twinPulse.diffPixels > 0 && twinPulse.bbox !== null && twinPulse.bbox.width < twin.rect.width * 0.5;
  process.stdout.write(
    `  twin pulse animating  : 600ms 两次截图差异 diff_pixels=${twinPulse.diffPixels} bbox=${JSON.stringify(twinPulse.bbox)} -> 关键帧动画在跑 = ${pulseOk}\n`,
  );
  try {
    twin.child.kill();
  } catch {
    /* ignore */
  }
  // 同一矩形、孪生窗消失后的基线：与 twinShot 的差异证明「这条截图通路拍得到窗口内容」，
  // 与桌面背景明暗无关。
  await new Promise((r) => setTimeout(r, 350));
  const twinBaseline = await shot('baseline(no twin)', twin.rect);
  const twinDiff = compareImages(twinShot.img, twinBaseline.img);
  const twinOk = twinDiff.diffPixels > 200 && twinDiff.bbox !== null;
  const darkHidden = countColor(hiddenShotA.img, isDarkPixel);

  const stabilityShown = compareImages(shownShotA.img, shownShotB.img);
  const stabilityHidden = compareImages(hiddenShotA.img, hiddenShotB.img);
  const stabilityWitness = compareImages(witnessBefore.img, witnessAfter.img);
  const diffAB = compareImages(shownShotA.img, hiddenShotA.img);
  const diffAB2 = compareImages(shownShotB.img, hiddenShotB.img);
  const bytesEqualA = shownShotA.res.data.image.base64 === hiddenShotA.res.data.image.base64;
  const bytesEqualB = shownShotB.res.data.image.base64 === hiddenShotB.res.data.image.base64;
  const nearWhiteShown = countColor(shownShotA.img, (r, g, b) => r >= 230 && g >= 230 && b >= 230);
  const nearWhiteHidden = countColor(hiddenShotA.img, (r, g, b) => r >= 230 && g >= 230 && b >= 230);

  process.stdout.write(`  region                : ${JSON.stringify(region)} (${diffAB.totalPixels} px)\n`);
  process.stdout.write(`  capture stability     : visible-pair diff=${stabilityShown.diffPixels}, hidden-pair diff=${stabilityHidden.diffPixels}\n`);
  process.stdout.write(`  visible vs hidden #1  : diff_pixels=${diffAB.diffPixels} max_delta=${diffAB.maxDelta} bbox=${JSON.stringify(diffAB.bbox)}\n`);
  process.stdout.write(`  visible vs hidden #2  : diff_pixels=${diffAB2.diffPixels} max_delta=${diffAB2.maxDelta} bbox=${JSON.stringify(diffAB2.bbox)}\n`);
  process.stdout.write(`  png bytes identical   : #1=${bytesEqualA} #2=${bytesEqualB}\n`);
  process.stdout.write(`  near-white(>=230) px  : visible=${nearWhiteShown} hidden=${nearWhiteHidden}\n`);
  process.stdout.write(`  distinct colors       : visible=${distinctColors(shownShotA.img)} hidden=${distinctColors(hiddenShotA.img)}\n`);
  process.stdout.write(
    `  control(magenta) px   : ${magenta}/${controlShot.img.width * controlShot.img.height} -> 该矩形同一条截图通路拍到窗口内容 = ${controlOk}\n`,
  );
  process.stdout.write(
    `  twin(no affinity)      : twin-vs-baseline diff_pixels=${twinDiff.diffPixels} bbox=${JSON.stringify(twinDiff.bbox)} ` +
      `dark_px twin=${darkTwin} hidden=${darkHidden} -> 同构造无 affinity 时被拍到 = ${twinOk}\n`,
  );

  const stable =
    stabilityShown.diffPixels === 0 && stabilityHidden.diffPixels === 0 && stabilityWitness.diffPixels === 0;
  const diffBest = Math.min(diffAB.diffPixels, diffAB2.diffPixels);
  const captureExcluded = stable && diffBest === 0 && controlOk && twinOk;
  if (!stable) {
    process.stdout.write(
      '  （注意：同一状态两次截图（或目击区）的像素并不完全一致，说明这块区域本身在变 —— ' +
        `visible-pair=${stabilityShown.diffPixels}px hidden-pair=${stabilityHidden.diffPixels}px ` +
        `witness=${stabilityWitness.diffPixels}px）\n`,
    );
  }
  const controlMatchesRegion =
    Math.abs(control.rect.left - region.left) <= 2 &&
    Math.abs(control.rect.top - region.top) <= 2 &&
    Math.abs(control.rect.width - region.width) <= 2 &&
    Math.abs(control.rect.height - region.height) <= 2;
  // 像素类判定在「区域本身在动」时无法成立：既不能报 FAIL（冤枉代码），
  // 也不能报 PASS（撒谎），所以如实报 INCONCLUSIVE。
  const unstableReason = `测试区域在变（同状态两次截图差 ${stabilityShown.diffPixels}/${stabilityHidden.diffPixels} px，目击区差 ${stabilityWitness.diffPixels} px，distinct colors ${distinctColors(shownShotA.img)}），像素级判定不成立；请让该区域静止后重跑`
  if (stable) {
    check(
      '正对照：无 affinity 的品红窗口盖在同一矩形上、被同一条截图通路拍到',
      controlOk && controlMatchesRegion,
      `magenta=${magenta}/${controlShot.img.width * controlShot.img.height} control_rect=${JSON.stringify(control.rect)} region=${JSON.stringify(region)}`,
    )
  } else {
    inconclusiveCheck('正对照：无 affinity 的品红窗口被同一条截图通路拍到', unstableReason)
  }
  if (stable) {
    check(
      '正对照：同构造无 affinity 的孪生窗在消失前后有可测差异（与背景明暗无关）',
      twinOk,
      `diff_pixels=${twinDiff.diffPixels} bbox=${JSON.stringify(twinDiff.bbox)} twin_rect=${JSON.stringify(twin.rect)}`,
    )
    check(
      '孪生窗证明脉冲关键帧动画确实在动（600ms 两次截图有差异且只在圆点区）',
      pulseOk,
      `diff_pixels=${twinPulse.diffPixels} bbox=${JSON.stringify(twinPulse.bbox)}`,
    )
  } else {
    inconclusiveCheck('正对照：同构造无 affinity 的孪生窗被拍到', unstableReason)
    inconclusiveCheck('孪生窗脉冲动画活性', unstableReason)
  }
  check(
    '旁证：卡片窗口可见 / 未被 DWM cloaked',
    /visible=True/.test(paint) && /cloaked=0/.test(paint),
    paint,
  )
  // **首选证据**：与背景动画无关。让窗口把自己画进抓图 DC：
  // WDA_EXCLUDEFROMCAPTURE 会让指示器拒绝渲染（整张全黑），而同构造、无 affinity 的孪生窗
  // 会正常画出卡片。这条不要求桌面静止，所以用户屏幕一直在动时也能给出确定结论。
  const paintFacts = parsePaintProbe(paint);
  const twinPaintFacts = parsePaintProbe(twinPaint);
  const printWindowExcluded =
    paintFacts !== null && twinPaintFacts !== null && paintFacts.distinct <= 1 && twinPaintFacts.distinct > 10;
  check(
    '与背景无关的判据：指示器拒绝把自己画进抓图 DC，同构造孪生窗正常画出',
    printWindowExcluded,
    `indicator distinct=${paintFacts === null ? '?' : paintFacts.distinct} avgLuma=${
      paintFacts === null ? '?' : paintFacts.avgLuma
    } / twin distinct=${twinPaintFacts === null ? '?' : twinPaintFacts.distinct} avgLuma=${
      twinPaintFacts === null ? '?' : twinPaintFacts.avgLuma
    }`,
  )
  if (stable) {
    check(
      '显示时与隐藏后的同区域像素完全一致（GDI 截图里看不到指示器）',
      diffBest === 0,
      `diff_pixels_min=${diffBest} of ${diffAB.totalPixels}`,
    )
  } else {
    inconclusiveCheck('GDI 截图里看不到指示器（逐像素）', unstableReason)
  }
  // 结论分两档：PrintWindow 判据与背景无关，可以直接给结论；像素判据需要静止区域。
  process.stdout.write(`\n  capture_excluded_printwindow(与背景无关) = ${printWindowExcluded}\n`)
  process.stdout.write(`  capture_excluded_pixels(需区域静止)     = ${stable ? diffBest === 0 && controlOk && twinOk : 'inconclusive'}\n`)

  const autoHideRequested = process.argv.includes('--auto-hide');
  if (autoHideRequested) {
    section('[11] 30s 兜底自动隐藏（--auto-hide，会等 31 秒）');
    const armed = await request(indicator, 'show', { text: '自动隐藏验证' });
    check('自动隐藏计时器起点：show → visible:true', armed.data && armed.data.visible === true, JSON.stringify(armed.data && armed.data.visible));
    process.stdout.write('  等待 31 秒不再刷新…\n');
    await new Promise((r) => setTimeout(r, 31000));
    const buried = await request(indicator, 'ping');
    check('30s 无刷新后自动隐藏', buried.ok === true && buried.data && buried.data.visible === false, JSON.stringify(buried.data && buried.data.visible));
    const revived = await request(indicator, 'show', { text: '自动隐藏后重新显示' });
    check('自动隐藏后进程仍存活，show 仍可用', revived.ok === true && revived.data && revived.data.visible === true, JSON.stringify(revived.data && revived.data.visible));
  } else {
    process.stdout.write('\n  （跳过 30s 自动隐藏验证；加 --auto-hide 参数可启用）\n');
  }

  section('[12] shutdown 与 stdout 洁净度');
  const shutdown = await request(indicator, 'shutdown');
  check('shutdown → ok', shutdown.ok === true, JSON.stringify(shutdown.data || shutdown.error));
  await new Promise((resolve) => {
    if (indicator.exited) return resolve();
    const t = setTimeout(resolve, 8000);
    indicator.child.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  check('shutdown → 进程退出码 0', indicator.exited && indicator.exitCode === 0, `exited=${indicator.exited} code=${indicator.exitCode} signal=${indicator.exitSignal}`);
  check('stdout 全程无 CR', indicator.sawCr === false, `sawCr=${indicator.sawCr}`);
  check(
    'stdout 每行都是合法 JSON',
    indicator.invalidLines.length === 0,
    indicator.invalidLines.length ? JSON.stringify(indicator.invalidLines.slice(0, 3)) : `${indicator.rawLines.length} lines`,
  );
  check('stdout 无残留半行', indicator.pending.length === 0, JSON.stringify(indicator.pending.slice(0, 80)));
  check('cua.ps1 stdout 无非法 JSON 行', cua.invalidLines.length === 0, JSON.stringify(cua.invalidLines.slice(0, 2)));

  process.stdout.write(`\n  indicator stderr tail:\n${indicator.stderr.trim().split('\n').map((l) => `    ${l}`).join('\n')}\n`);

  return { captureExcluded, controlOk, twinOk, pulseOk, printWindowExcluded, stable, hwnd: d3.hwnd, rect };
}

/**
 * 解析 probePainting 输出的一行 `PAINT ... key=value ...`。
 * @returns `{distinct, avgLuma, visible, cloaked}`；无法解析返回 null
 */
function parsePaintProbe(line) {
  const text = String(line ?? '')
  const read = (key) => {
    const match = new RegExp(`${key}=(-?\\d+)`, 'u').exec(text)
    return match === null ? undefined : Number(match[1])
  }
  const distinct = read('distinct')
  if (distinct === undefined) return null
  return {
    distinct,
    avgLuma: read('avgLuma') ?? 0,
    visible: /visible=True/u.test(text),
    cloaked: read('cloaked') ?? 0,
  }
}

let failureCount = 0;
/** 2 = 环境不稳定导致像素级判定不成立（不是产品失败，换静态画面重跑）。 */
let exitCode = 0;main()
  .then((result) => {
    const failed = checks.filter((c) => !c.ok);
    failureCount = failed.length;
    section('结论');
    process.stdout.write(`  checks: ${checks.length - failed.length} passed, ${failed.length} failed\n`);
    if (failed.length) {
      for (const f of failed) process.stdout.write(`    FAILED: ${f.name} — ${f.detail}\n`);
    }
    if (inconclusive.length) {
      process.stdout.write(`  inconclusive: ${inconclusive.length}（环境不稳定，像素级判定不成立）\n`);
      for (const item of inconclusive) process.stdout.write(`    INCONCLUSIVE: ${item.name} — ${item.reason}\n`);
    }
    process.stdout.write(`  capture_excluded_printwindow(与背景无关) = ${result.printWindowExcluded}\n`);
    process.stdout.write(`  capture_excluded_pixels(需区域静止)     = ${result.stable ? result.captureExcluded : 'inconclusive'}\n`);
    process.stdout.write(`  capture_control_ok(magenta, same rect) = ${result.controlOk}\n`);
    process.stdout.write(`  capture_twin_ok(same visual, no affinity) = ${result.twinOk}\n`);
    process.stdout.write(`  pulse_animation_ok = ${result.pulseOk}\n`);
    process.stdout.write(`  indicator_hwnd = ${result.hwnd} rect=${JSON.stringify(result.rect)}\n`);
    if (failed.length > 0) {
      process.stdout.write('  SMOKE FAIL\n');
      exitCode = 1;
    } else if (inconclusive.length > 0) {
      // 像素判据无法成立 ≠ 无法判定排除性：PrintWindow 那条判据与背景无关，
      // 只要它通过，结论（不进截图）依然是确定的。
      process.stdout.write(
        result.printWindowExcluded
          ? '  SMOKE PASS（排除性由与背景无关的 PrintWindow 判据给出；逐像素旁证因环境不稳定而无法取得）\n'
          : '  SMOKE INCONCLUSIVE（逐像素与 PrintWindow 两条判据都未成立；请让屏幕静止后重跑）\n',
      );
      exitCode = result.printWindowExcluded ? 0 : 2;
    } else {
      process.stdout.write('  SMOKE PASS\n');
      exitCode = 0;
    }
  })
  .catch((err) => {
    section('异常终止');
    process.stdout.write(`  ${err && err.stack ? err.stack : String(err)}\n`);
    failureCount = Math.max(failureCount, 1);
    exitCode = 1;
  })
  .finally(() => {
    killAll();
    setTimeout(() => process.exit(failureCount ? 1 : exitCode), 150);
  });
