# dsh-computer-use 原生桥协议（dsh-cua/1）

本文件是 **JS 插件层** 与 **Windows 原生后端** 之间的冻结接口。两侧独立实现、独立测试，
任何一侧改动都必须先改本文件。

## 1. 宿主进程

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <plugin>/src/native/cua.ps1
```

* 必须是 **Windows PowerShell 5.1**（`System.Drawing`、`System.Windows.Forms`、
  `UIAutomationClient`、`UIAutomationTypes` 在该宿主下开箱可用）。
* 脚本文件必须带 **UTF-8 BOM**：5.1 会把无 BOM 的 UTF-8 当 ANSI 读，中文注释会破坏语法解析。
* 脚本开头必须调用 `user32!SetProcessDPIAware()`，否则进程被 DPI 虚拟化：
  实测 150% 缩放下裸截图得到 1707x1067，而 UIA/窗口坐标是 2560x1600，两个坐标空间不一致。
  开启后截图、`VirtualScreen`、窗口矩形、UIA `BoundingRectangle` 全部落在同一物理像素空间。
* 脚本必须禁用任何会污染 stdout 的输出（禁止 `Write-Host`/`Write-Output`/`-Verbose` 到 stdout）。
  诊断一律进 stderr。

## 2. 分帧

stdin / stdout 均为 **NDJSON**：一行一个 JSON 对象，紧凑无缩进，`\n` 结尾。

请求：

```json
{"id":"<string>","cmd":"<method>","args":{ }}
```

成功响应：

```json
{"id":"<string>","ok":true,"data":{ }}
```

失败响应：

```json
{"id":"<string>","ok":false,"error":{"code":"<CODE>","message":"<human>","details":{ }}}
```

就绪横幅（进程启动后 stdout 第一行，`id` 为 null）：

```json
{"id":null,"ok":true,"event":"ready","data":{"protocol":"dsh-cua/1","psVersion":"5.1.x","dpiAware":true,"screen":{ }}}
```

约定：

* 一个请求恰好一行、恰好一个响应；处理必须串行。
* 未识别的 `cmd` → `UNKNOWN_METHOD`，进程不得退出。
* 任何内部异常都必须转成失败响应；**绝不能因为一条坏请求而退出进程**。
* `id` 由调用方生成并原样回显。

## 2.1 预热（warm-up）

进程发完就绪横幅后，会**立即**执行一次预热（`Initialize-BackendCaches`），与宿主的首条请求并行：

1. 建全量进程表（`[Diagnostics.Process]::GetProcesses()`）；
2. 枚举一次窗口（`CuaNative.ListWindows`）；
3. 对当前前台窗口 `AutomationElement.FromHandle` 建一次 UIA 连接，并跑一次 8 元素 / 深度 2 的小树遍历
   （把 C# walker 的方法/JIT/属性缓存变热）。

实测（Firefox，400 元素预算）：

| 场景 | 第一次 get_app_state |
|---|---|
| 不预热 | 932 ms |
| 预热 | 396 ms |

预热自身约 480 ms，发生在就绪横幅**之后**，因此不拖长启动；失败只写 stderr 诊断，不影响任何请求。

## 3. 坐标与坐标系（核心约定）

* 所有原生坐标都是 **物理像素**，原点为虚拟屏左上角（多屏时可负）。
* `screenshot` / `zoom` 返回 `frame_id`，并把它设为「当前坐标系」（`latest frame`）。
* 桥会记住**最近一次** `screenshot`/`zoom` 的几何。输入类方法（`click`/`mouse_move`/
  `drag`/`scroll`）接受：

| 参数 | 语义 |
|---|---|
| `x`,`y` | **栅格像素**（返回图片内部的像素），相对于该次 `screenshot`/`zoom` 的成像区域 |
| `frame_id` | 可选。省略时用最近一次 frame；显式传入必须与最近一次一致，否则 `ELEMENT_STALE` |
| `space` | `"raster"`（默认）或 `"screen"`（直接用物理像素，此时忽略 frame 映射） |
| `target_hwnd` | 仅 `screenshot`/`zoom`。声明这帧是给哪个窗口拍的；带归属的帧被拿去操作另一个窗口时返回 `FRAME_TARGET_MISMATCH`（缺省 0 = 整屏/不校验） |

  映射：`screen_x = source.x + raster_x / scale.x`（`scale.x = raster.width / source.width`）。
* 若从未截过图而调用输入方法且 `space != "screen"`，返回 `NO_FRAME`。
* 应用/窗口/UIA 元素的 `bounds` 一律是物理像素；模型不应该拿它当栅格坐标用
  （与 ZCode 的 `screenshot_display.bounds` 警告同源）。

## 4. 方法

### 4.1 `ping`
→ `{ "pong": true, "uptimeMs": 1234 }`

### 4.2 `screen_info`
→

```json
{ "dpiAware": true,
  "virtual": { "x":0, "y":0, "width":2560, "height":1600 },
  "monitors": [ { "index":0, "device":"\\\\.\\DISPLAY1", "primary":true, "dpi":144,
                  "bounds":{"x":0,"y":0,"width":2560,"height":1600},
                  "working":{"x":0,"y":0,"width":2560,"height":1520} } ] }
```

### 4.3 `screenshot`
args：

| 名字 | 类型 | 说明 |
|---|---|---|
| `left`,`top`,`width`,`height` | int | 可选。截取区域（物理像素）。缺省为整个虚拟屏 |
| `max_width` | int | 可选。超过则等比缩小，保证长边不超过该值 |
| `format` | `"png"`\|`"jpeg"` | 默认 `png` |
| `quality` | int | jpeg 质量 1–100，默认 80 |
| `monitor` | int | 可选。按 `screen_info` 的 monitor index 截单屏，覆盖 left/top/width/height |
| `clamp` | bool | 默认 `true`：区域越界时裁剪并回报 `clamped:true`。`false` 时部分越界报 `OUT_OF_BOUNDS`（与 `zoom` 同名同义） |
| `target_hwnd` | string | 可选。声明这块几何属于哪个窗口，用于跨窗口旧帧校验（见 §5 `FRAME_TARGET_MISMATCH`） |

→

```json
{ "frame_id": "f3",
  "image": { "base64":"iVBORw0...", "mediaType":"image/png", "width":1280, "height":800, "bytes":123456 },
  "source": { "x":0, "y":0, "width":2560, "height":1600 },
  "scale": { "x":0.5, "y":0.5 },
  "screenshot_display": { "mode":"full-screen", "bounds":{"x":0,"y":0,"width":1280,"height":800},
                          "raster":{"width":1280,"height":800}, "screen":{"width":2560,"height":1600} } }
```

失败：`SCREENSHOT_FAILED`。

### 4.4 `zoom`
args：`left`,`top`,`width`,`height`（**必填**，物理像素）、`scale`（默认 2，1–8）、
`format`、`quality`、`clamp`（默认 true，越界时裁剪到屏幕内并回报 `clamped:true`）。
返回同 `screenshot`，另加 `"zoomed": true, "clamped": false`。
越界且 `clamp:false` → `OUT_OF_BOUNDS`。

### 4.5 `list_apps`
args：`include_minimized`（默认 false）。
→

```json
{ "count": 9,
  "apps": [ { "appKey":"notepad", "displayName":"Notepad", "process":"notepad",
              "pid":1234, "exePath":"C:\\Windows\\System32\\notepad.exe",
              "foreground": true, "windowCount": 1,
              "windows": [ { "hwnd":"0x00120abc", "title":"Untitled - Notepad",
                             "className":"Notepad", "minimized": false,
                             "bounds":{"x":100,"y":100,"width":800,"height":600} } ] } ] }
```

* 只列**有可见顶层窗口**的进程。
* `appKey` 稳定且可再次用于定位：优先 `processName` 小写；UWP 宿主进程（`ApplicationFrameHost`、
  `WWAHost`）用其真实应用名，拿不到时回退 `ApplicationFrameHost:<pid>`。
* `displayName` 取可执行文件 `FileDescription`，失败回退 `processName`。

### 4.6 `list_windows`
args：`appKey?`、`pid?`、`hwnd?`（三者任一；都不给 = 全部可见窗口）。
→ `{ "count":2, "windows":[ { "hwnd":"0x..", "title":"..", "className":"..",
     "pid":1234, "appKey":"notepad", "displayName":"Notepad", "foreground":true,
     "minimized":false, "bounds":{ "x":0,"y":0,"width":800,"height":600 } } ] }`

### 4.7 `get_app_state`
args：`appKey?`、`hwnd?`、`pid?`、`max_elements?`（默认 120，上限 400）、`max_depth?`（默认 8，上限 16）、`timeout_ms?`（默认 4000）。
目标解析：`hwnd` > `pid` > `appKey`（多窗口时取前台/最靠前的窗口）。

→

```json
{ "state_id": "s7",
  "app": { "appKey":"notepad", "displayName":"Notepad", "pid":1234 },
  "window": { "hwnd":"0x..", "title":"Untitled - Notepad", "className":"Notepad",
              "bounds":{"x":..,"y":..,"width":..,"height":..}, "foreground": true, "minimized": false },
  "focused": { "elementIndex": 3, "name":"Text editor", "role":"Document" },
  "elementCount": 42, "truncated": false,
  "elements": [ { "index":0, "role":"MenuBar", "name":"Application", "value":null,
                  "automationId":"", "className":"", "enabled":true, "focused":false,
                  "offscreen":false, "bounds":{"x":..,"y":..,"width":..,"height":..},
                  "actions":["invoke"] } ],
  "text": "<app name=\"Notepad\" pid=\"1234\">\n[0] MenuBar \"Application\" @(0,0,800,24)\n...</app>" }
```

* `index` 只在同一个 `state_id` 内有效；把它传给动作方法时必须原样回传 `state_id`。
* `actions` 依据控件支持的 UIA Pattern 计算，取值：`invoke`、`expand`、`collapse`、`toggle`、
  `select`、`set_value`、`select_text`、`focus`、`scroll`。
* 遍历用 UIA `CacheRequest` 批量取属性，逐元素 try/catch；触碰 `timeout_ms` 预算即停止并置
  `truncated:true`（绝不抛错）。
* 目标有窗口但 UIA 树为空 → 返回 `elementCount:0` 与 `text` 说明，不报错。
* 找不到 `appKey` → `APP_NOT_FOUND`；找不到窗口 → `WINDOW_NOT_FOUND`。
* `text` 里不得包含 `state_id` 之外的机器可解析字段（模型必须读结构化字段，不要正则 `text`）。

### 4.8 `click`
args：`x`,`y`（栅格像素，或 `space:"screen"` 时为物理像素）**或** `element_index`；
`state_id?`（配 `element_index` 时必填）、`button`（`"left"`|`"right"`|`"middle"`，默认 `left`）、
`clicks`（1|2|3，默认 1）、`frame_id?`、`interval_ms?`（连击间隔，默认 60）。
→ `{ "action_sent": true, "state_id":"s7"?, "target": { "x":.., "y":.., "elementIndex":3? },
     "text": "Clicked element #3 ..." }`

* `element_index` 优先于 `x`/`y`；元素几何取**该元素中心**。
* 元素属于非前台窗口 → 先尝试切前台；失败则 `FOREGROUND_REQUIRED`（带 `details.hwnd`）。
* `state_id` 与当前不一致 → `ELEMENT_STALE`。
* 元素越界/不可见 → `ELEMENT_UNAVAILABLE`。

### 4.9 `mouse_move`
args：`x`,`y`,`frame_id?`,`space?`、`duration_ms?`（默认 0 = 瞬移）。
→ `{ "action_sent": true, "target": { "x":.., "y":.. } }`

### 4.10 `drag`
args：`from`/`to`（各含 `x`,`y`，栅格像素）或 `from_element_index`+`to_element_index`
（配 `state_id`）；`button?`、`duration_ms?`（默认 300）、`frame_id?`。
→ `{ "action_sent": true, "text": "Dragged ..." }`

### 4.11 `scroll`
args：`direction`（`"up"`|`"down"`|`"left"`|`"right"`，默认 `down`）、`amount`（默认 3，
单位 = 滚轮格数，1 格 = `WHEEL_DELTA` 120）、`x`,`y`（栅格像素，可选：先移动指针）、
`element_index`+`state_id`（可选：对元素中心滚动）、`frame_id?`。
→ `{ "action_sent": true, "text": "Scrolled down 3" }`

### 4.12 `type`
args：`text`（必填，支持任意 Unicode）、`element_index`+`state_id`（可选：先点击该元素聚焦）、
`interval_ms?`（默认 0）。用 `SendInput` 的 `KEYEVENTF_UNICODE` 逐字符注入，代理对正确成对。
→ `{ "action_sent": true, "text": "Typed 12 characters", "characters": 12 }`

### 4.13 `key`
args：`key`（如 `"ctrl+s"`、`"enter"`、`"alt+tab"`、`"f5"`、`"cmd+shift+p"` 里的 `cmd`→`Win`）**或**
`text`（单个字符）。modifier 名：`ctrl`/`control`/`alt`/`shift`/`win`/`meta`/`cmd`/`command`。
→ `{ "action_sent": true, "text": "Pressed Ctrl+S", "modifiers":["ctrl"], "keys":["s"] }`

* 未知键名 → `BAD_REQUEST`（消息里列出可用键名类别）。

### 4.14 `hold_key`
args：`key` 或 `text`、`duration_ms`（默认 500，1–10000）。
→ `{ "action_sent": true, "text": "Held Shift for 500ms", "durationMs": 500 }`

### 4.15 `set_value`
args：`element_index`、`state_id`、`value`（string）、`submit?`（bool，默认 false：设值后回车）。
→ `{ "action_sent": true, "state_id":"s7", "value":"...", "text":"Set value of element #2" }`
不支持 ValuePattern → `NOT_SETTABLE`。

### 4.16 `select_text`
args：`element_index`、`state_id`、`start?`（默认 0）、`length?`（默认全选）、`all?`（bool）。
→ `{ "action_sent": true, "state_id":"s7", "selected": {"start":0,"length":12}, "text":"Selected 12 characters" }`
不支持 TextPattern → `NOT_SELECTABLE`。

### 4.17 `perform_action`
args：`element_index`、`state_id`、`action`
（`"invoke"`|`"expand"`|`"collapse"`|`"toggle"`|`"select"`|`"focus"`|`"scroll_into_view"`）。
→ `{ "action_sent": true, "state_id":"s7", "action":"invoke", "text":"Invoked element #4" }`
Pattern 不支持 → `ACTION_UNAVAILABLE`。

### 4.18 `open_application`
args：`name?`（显示名或 exe 名，走 `Start-Process`/ShellExecute）、`path?`（exe 全路径）、
`url?`（`http(s)`/`file` 等，走 ShellExecute）、`args?`（数组）、`wait_ms?`（默认 800）。
→ `{ "action_sent": true, "launched": { "kind":"path|name|url", "target":"..", "pid":1234?, "hwnd":"0x.."? },
     "text": "Opened Notepad" }`
失败 → `LAUNCH_FAILED`（消息包含被拒绝的目标名）。

### 4.19 `focus_window`
args：`hwnd?` 或 `appKey?`。
→ `{ "action_sent": true, "hwnd":"0x..", "title":"..", "text":"Focused ..." }`
被前台锁定策略拒绝 → `FOREGROUND_REQUIRED`。

### 4.20 `clipboard_read` / `clipboard_write`
`clipboard_read` → `{ "text":"...", "hasText": true, "empty": false }`
`clipboard_write { "text":"..." }` → `{ "action_sent": true, "characters": 12 }`
无文本或非文本内容 → `hasText:false`（不是错误）。STA 线程要求：脚本必须在 STA 模式
（`powershell.exe -STA` 或默认 STA）下操作剪贴板，失败 → `CLIPBOARD_FAILED`。

### 4.21 `wait`
args：`duration_ms?`（默认 1000，上限 30000）、`appKey?`/`hwnd?`（可选：等待后重新取该目标状态）。
→ `{ "waitedMs": 1000, "state_id":"s8"?, "elements":[..]?, "text":"Waited 1.00s" }`

### 4.22 `stop`
args：`release_keys?`（默认 true）。
释放所有 `hold_key` 期间按下的 modifier、结束进行中的拖拽（补一个 `LEFTUP`），
→ `{ "action_sent": true, "stopped": true, "releasedKeys":["shift"], "text":"Released held keys" }`

### 4.23 `shutdown`
→ `{ "stopped": true }`，随后 exit 0。

## 5. 错误码

| code | 触发 |
|---|---|
| `BAD_REQUEST` | 参数缺失/类型错/键名未知（**实现上真的会拒绝**，`details.unknown` 列出被拒的键，`details.accepted` 列出该 cmd 接受的键） |
| `UNKNOWN_METHOD` | `cmd` 不认识 |
| `NO_FRAME` | 输入方法需要坐标系但从未截图 |
| `ELEMENT_STALE` | 传入的 `state_id` 与当前不符 |
| `FRAME_TARGET_MISMATCH` | 帧是给另一个窗口拍的，拒绝复用它的几何（用 `space:"screen"` 或重拍） |
| `ELEMENT_NOT_FOUND` | `element_index` 超出该 state |
| `ELEMENT_UNAVAILABLE` | 元素不可见/无几何/已消失 |
| `ACTION_UNAVAILABLE` | UIA Pattern 不支持该动作 |
| `NOT_SELECTABLE` / `NOT_SETTABLE` | 分别对应 TextPattern / ValuePattern 缺失 |
| `FOREGROUND_REQUIRED` | 目标窗口不在前台且无法切前台 |
| `APP_NOT_FOUND` / `WINDOW_NOT_FOUND` | 目标解析失败 |
| `UIA_UNAVAILABLE` | UIA 程序集或 COM 不可用 |
| `OUT_OF_BOUNDS` | `zoom` 越界且 `clamp:false` |
| `SCREENSHOT_FAILED` | 截屏/编码失败 |
| `CLIPBOARD_FAILED` | 剪贴板操作失败 |
| `LAUNCH_FAILED` | 启动应用失败 |
| `TIMEOUT` | 带超时的操作超时 |
| `INTERNAL` | 兜底 |

## 6. 安全与副作用约定

* `click`/`type`/`key`/`drag`/`scroll`/`set_value`/`select_text`/`perform_action`/
  `clipboard_write`/`open_application`/`focus_window` **都会真实操作用户桌面**，
  成功响应必须带 `action_sent: true`。
* 纯读取（`ping`/`screen_info`/`screenshot`/`zoom`/`list_apps`/`list_windows`/
  `get_app_state`/`clipboard_read`）**不得**带 `action_sent`。
* `stop` 必须幂等且永不失败。
