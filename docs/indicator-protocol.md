# 操作指示器协议（dsh-cua-indicator/1）

配套实现：[`src/native/indicator.ps1`](../src/native/indicator.ps1)（持有浮窗的 WPF 进程）
与 [`src/indicator.js`](../src/indicator.js)（Node 侧控制器）。
本文件是**冻结接口**：两侧独立实现、独立测试，任何一侧改动都先改这里。

## 1. 它是什么

Computer Use 动作进行时，屏幕顶部居中的一张小卡片：「DSH 正在操作电脑 · 正在点击」。
根因是**可见性保证**：模型在真实操作用户的桌面，用户有权知道此刻是谁在动他的鼠标。

对齐上游 ZCode 的 `windowsCuaOperationIndicator`（Electron 版）。三条不可妥协的性质：

| 性质 | 手段 | 不满足的后果 |
|---|---|---|
| **不抢焦点** | `WS_EX_NOACTIVATE` + `ShowActivated=$false` | 键盘注入打进浮层，Computer Use 直接失效 |
| **点击穿透** | `WS_EX_TRANSPARENT` | 用户点浮层所在位置时事件被吞掉 |
| **不进截图** | `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE=0x11)` | 模型每张截图都被自己的浮层污染 |

再加上 `WS_EX_TOOLWINDOW`（不进任务栏/Alt-Tab）与 `Topmost`。

## 2. 宿主进程

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File <plugin>/src/native/indicator.ps1
```

* 必须 **`-STA`**（WPF 要求）与 **Windows PowerShell 5.1**。
* 脚本文件必须带 **UTF-8 BOM**（5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文注释会破坏语法解析）。
* stdout **只允许**出现协议行（NDJSON，`\n` 结尾）；诊断一律进 stderr。
  任何未接住的返回值（`Add-Type`、`Show()`、`SetWindowPos`…）都会污染 stdout，必须吞掉。
* 插件加载时**预热**（`warmUp()`）：WPF 冷启动 1-2 秒，不预热则第一次动作亮得太迟。

## 3. 分帧

与 `cua.ps1` 同构，因此 Node 侧直接复用同一个 `NativeBridge` 客户端。

请求：`{"id":"<string>","cmd":"<method>","args":{ }}`
成功：`{"id":"<string>","ok":true,"data":{ }}`
失败：`{"id":"<string>","ok":false,"error":{"code":"<CODE>","message":"<human>"}}`
就绪横幅（stdout 第一行）：

```json
{"id":null,"ok":true,"event":"ready","data":{"protocol":"dsh-cua-indicator/1","psVersion":"5.1.x","monitors":1}}
```

约定：一次一条请求、一个响应；未知 `cmd` → `UNKNOWN_METHOD`；坏 JSON → `BAD_REQUEST`；
**任何单条请求出错都不能让进程退出**。

## 4. 方法

| cmd | args | 说明 |
|---|---|---|
| `show` | `{text?}` | 显示（已显示则等价 `update`）。`text` 省略用默认文案「DSH 正在操作电脑」。**每次 show 都重新定位并重新声明 Topmost**——隐藏过的透明窗可能被系统清掉 `WS_EX_TOPMOST` |
| `update` | `{text?}` | 只改文案并重新自适应宽度/定位。**不要 hide→show**（会闪） |
| `hide` | `{}` | 离场动画（120ms）后隐藏。不销毁窗口（除非隐藏失败） |
| `ping` | `{}` | `{pong:true, visible:<bool>}` |
| `shutdown` | `{}` | 关窗、退出进程（退出码 0） |

`data` 必须回报**可核验的事实**（测试靠它而不是靠信任）：

```json
{ "visible": true, "text": "DSH 正在操作电脑 · 点击",
  "width": 201, "height": 38, "x": 1180, "y": 6,
  "topmost": true, "clickThrough": true, "noActivate": true,
  "excludedFromCapture": true, "affinity": 17, "hwnd": "0x00120abc" }
```

* `clickThrough` / `noActivate` **从实际 ex-style 位读回**，不写死。
* `excludedFromCapture` = `SetWindowDisplayAffinity` 是否成功；`affinity` = 实际生效的值
  （`0x11` 或回退的 `0x01`）。
* `hide` 之后 `visible` 必须是 `false`。

## 5. 视觉规格（照上游，别自己发挥）

| 项 | 值 |
|---|---|
| 卡片 | 高 38px、圆角 12、`padding 0 18`、字号 13、字重 SemiBold、字体 "Segoe UI Variable" / "Segoe UI"、单行不换行 |
| 浅色 | 卡片底 `rgba(255,255,255,0.96)`、文字 `#202124`、边框 1px `rgba(15,23,42,0.14)` |
| 深色 | 卡片底 `rgba(35,38,43,0.96)`、文字 `#F8FAFC`、边框 1px `rgba(255,255,255,0.14)` |
| 主题判定 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize\AppsUseLightTheme`（DWORD，0=深色），**每次 show 重新判定** |
| 阴影 | `DropShadowEffect`（BlurRadius≈12、ShadowDepth=1、Opacity≈0.18、Color=#0F172A）；外层留 6/8/12/8 透明边 |
| 圆点 | 三个 4px、间距 3、脉冲周期 1.2s、第 2/3 个各延迟 120ms |
| 动画 | 进场 140ms 透明度 0→1 且上移 6px；离场 120ms 反向 |
| 位置 | **鼠标所在显示器**工作区顶部居中：`Left = workArea.Left + (workArea.Width - width)/2`，`Top = workArea.Top + 12 - 6` |

窗口尺寸 = 卡片尺寸 + 左右 8、上 6、下 12（对应上游 `INDICATOR_SHADOW_INSET`）。

## 6. Node 侧控制器（`src/indicator.js`）

* `note(toolName, {terminal})`：**同步 fire-and-forget**——指示器是装饰性的，不能让工具多等一次往返；
  `terminal: true`（即 `stop_computer_control`）表示「控制权已交还」，立即 `hide`。
* 首次活动 `show`，后续活动 `update`；每次活动刷新自动隐藏计时器。
* **`autoHideMs`（默认 30s）兜底隐藏**：显式终态信号全部失约时也不能让浮层无限期停留。
* 任何失败只记一条 warn（`desktop control is unaffected`），绝不冒泡；
  `dispose()` 关闭指示器进程（插件卸载后还挂在最前端就是在撒谎）。

## 7. 验证

* 单元：`test/indicator.test.mjs`（文案、show/update 语义、刷新计时、终态隐藏、兜底隐藏、失败不冒泡、禁用、幂等 dispose）。
* 真机：`npm run indicator:smoke` —— 分两类判据：
  1. **与背景无关的首选判据**：`PrintWindow` 让窗口把自己画进抓图 DC。
     指示器必须**拒绝渲染（整张全黑）**，而同构造、无 affinity 的孪生窗必须正常画出卡片。
     这条在用户桌面一直在动（游戏/视频）时依然成立，是排除性的确定证据。
  2. **逐像素旁证**：用 `cua.ps1` 在显示/隐藏两种状态下截同一区域，要求逐像素一致、PNG 字节相同；
     并用「目击区」（指示器旁边一块不相关区域，捕获前后各拍一次）区分「环境变了」与「浮层被拍到了」。
     这条要求该区域在捕获期间静止；不满足时工具报 **INCONCLUSIVE**（退出码 2），不报 FAIL——
     冤枉代码和撒谎一样糟。
  另外核验：点击穿透（`WindowFromPoint(卡片中心)` 不是指示器自己）、
  不抢焦点（`GetForegroundWindow` 从不等于指示器）、30s 兜底自动隐藏（`--auto-hide`）。
* 端到端：`npm run e2e` 断言指示器随工具执行出现（visible/topmost/点击穿透/不抢焦点/文案）、
  交还控制权后收起、dispose 后进程退出。
* 预览图：`node tools/indicator-preview.mjs [--dark]` —— 用 `DSH_CUA_INDICATOR_CAPTURABLE=1`
  让这份代码本身可被 `PrintWindow` 抓取（生产路径永远不设该变量），产出
  `docs/indicator-preview{,-dark}.png`。
