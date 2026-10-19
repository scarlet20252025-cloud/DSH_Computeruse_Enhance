---
name: computer-use
description: "Use when a task needs a GUI desktop application operated directly — reading an app's interface, clicking buttons and menu items, typing into fields, sending keyboard shortcuts, taking screenshots, dragging, scrolling, or moving text through the clipboard. This includes requests like 「打开记事本写一段」「帮我在某个软件里点几下」「看看屏幕上现在是什么」 when they cannot be satisfied through files, shell commands, or HTTP. Tools are named after the upstream Computer Use surface (request_access, list_apps, get_app_state, left_click, type, key, screenshot, zoom, …)."
whenToUse: "The user wants something done inside a desktop application's UI, or wants to know what is currently on screen. Do not use it for file editing, shell work, or web pages that have their own automation path."
metadata:
  upstream: "ZCode Computer Use（packages/zcode-cua 契约 + computer-use 官方插件）"
  backend: "Windows PowerShell 5.1 + System.Drawing + UI Automation（长驻进程，见 docs/native-protocol.md）"
  platform: "win32"
---

# Computer Use

本技能让你**像人一样操作这台 Windows 电脑**：看应用界面、点按、输入、按快捷键、截图放大、拖拽滚轮、走剪贴板。

核心纪律只有一条：**先观察，再用观察得到的标识去操作，操作后再观察确认**。
凭猜测拼坐标、凭记忆复用旧界面状态，是这套工具最常见的失败方式。

## 0. 什么时候该用 / 不该用

| 用 | 不用 |
|---|---|
| 任务只有 GUI 入口（某软件里点几下、读某个窗口里的数字） | 改文件、跑命令、搜代码 —— 用 fs / bash / pwsh 工具 |
| 需要「现在屏幕上是什么」 | 网页自动化 —— 优先浏览器/CDP 类能力 |
| 需要把 App A 的内容搬到 App B | 只用 HTTP API 就能拿到的数据 |
| 用户明确让你操作某个桌面软件 | 需要长时间无人值守的破坏性操作（先跟用户确认） |

## 1. 标准回合

```
1) request_access          # 后端可用吗？屏幕多大？DPI 一致吗？（只读，便宜，先跑）
2) list_apps               # 有哪些带可见窗口的应用（拿到 appKey / 显示名 / pid）
3) get_app_state {app}     # 读该应用界面元素树 → 拿到 state_id 与 elements[*].index
4) 操作：left_click / type / key / set_value / perform_action ...
       ├─ 元素目标：element_index + state_id（首选，抗布局变化）
       └─ 坐标目标：screenshot 之后的 x/y（栅格像素）
5) get_app_state {app}     # 复查：元素值/结构变了吗？任务真的完成了吗？
```

第 4 步到第 5 步之间**不要**复用旧的 `state_id`：界面变了就是 stale，重新读一次即可。

## 2. 坐标纪律（最容易错的地方）

* `screenshot` / `zoom` 返回的是一个**图片**，同时给出 `frame_id`。
* `left_click` / `mouse_move` / `left_click_drag` / `scroll` 的 `x`/`y` 默认是**这张图片内部的像素**
  （`space="raster"`）。
* `get_app_state` 里元素的 `bounds`、`list_windows` 的窗口 `bounds` 都是**物理屏幕像素**。
  **不要**把它们当栅格坐标传给点击 —— 二者只有在 `scale=1` 且截图区域是整个屏幕时才恰好相等。
* 需要直接用物理屏幕像素时显式传 `space="screen"`。
* 传 `frame_id` 可以断言「我量的是这一帧」；对不上会报 `ELEMENT_STALE`，这时重新截图即可。
* 多显示器时物理坐标可以是负数（副屏在主屏左侧），`space="screen"` 下这是合法的。
* 先截图再点击是唯一可靠的坐标来源：**截图 → 看图定位 → 点击**。

## 3. 元素目标 vs 坐标目标

首选元素目标，因为它不依赖你目测像素：

```
const state = get_app_state({ app: "Notepad" })     # 记下 state.state_id
left_click({ element_index: 4, state_id: state.state_id })
```

* `index` 只在产生它的那一次 `state_id` 内有效。
* `elements[*].actions` 告诉你这个元素支持哪些动作（`invoke` / `expand` / `toggle` / `set_value` /
  `select_text` / `focus` …）。有 `invoke` 就优先 `perform_action`，比点坐标可靠。
* 填表优先 `set_value`（直接写值），它不支持时退回 `left_click` + `type`。
* 只有坐标可用时（自绘 UI、游戏、地图、画布）才用 `screenshot` + `x/y`。

## 4. 输入类工具的选择

| 想做的事 | 用 |
|---|---|
| 往焦点处输入一段文字 | `type`（含中文/emoji，Unicode 直通） |
| 按快捷键 | `key { key: "ctrl+s" }`（修饰键：ctrl / alt / shift / win，别名 control / meta / cmd / command） |
| 按住某键再操作 | `hold_key`，结束务必 `stop_computer_control` 释放 |
| 大段文本搬运 | `write_clipboard` + `key { key: "ctrl+v" }`，比逐字符快得多 |
| 复制出来给我看 | `key { key: "ctrl+c" }` 然后 `read_clipboard` |
| 拖拽 / 拉滑块 / 选文字 | `left_click_drag`（两端都优先用元素目标） |
| 滚轮翻页 / 横向滚动 | `scroll`，`amount` 是「格数」不是像素 |
| 等界面加载 | `wait`（传 `app` 会在等待后直接回新的界面树，省一次调用） |

## 5. 截图与 token 成本

* 截图是**图片**，会真实消耗上下文与费用：不要放进循环里连续截。
* 只看细节（小字、图标、状态灯）时用 `zoom`（给区域 + `scale`），比整屏截图再让模型放大便宜得多。
* `max_width` 可以按需缩小（默认配置已经限制长边）。
* 图看不了（当前路由不支持图像输入）时，信封里的 `saved_to` 是落盘路径，可用 `read_image` 打开。

## 6. 错误语义与恢复

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `ELEMENT_STALE` | 界面变了 / frame 对不上 | 重新 `get_app_state` 或 `screenshot`，用新的 `state_id` |
| `ELEMENT_NOT_FOUND` | index 不在当前 state | 同上 |
| `ELEMENT_UNAVAILABLE` | 元素消失/隐藏/无几何 | 重读状态；改走坐标点击 |
| `ACTION_UNAVAILABLE` | 该元素不支持这个 UIA 动作 | 改 `left_click` 元素中心，或走键盘导航 |
| `NOT_SETTABLE` / `NOT_SELECTABLE` | 不支持直接写值/选文本 | `left_click` 后用 `type` / `key ctrl+a` |
| `FOREGROUND_REQUIRED` | 目标窗口没法切到前台 | 用 `open_application` 重新拉起（会抬到前台），或对该窗口某个元素做一次 `left_click`（会尝试切前台），或请用户先点一下它 |
| `APP_NOT_FOUND` / `WINDOW_NOT_FOUND` | 目标名字不对 | 重新 `list_apps`，用返回的 `appKey` |
| `NO_FRAME` | 还没截过图就用栅格坐标 | 先 `screenshot`，或显式 `space="screen"` |
| `TIMEOUT` | 后端没在预算内回答（已被重启） | 重试一次；反复出现说明目标应用卡死 |

失败时**不要**原样重试三次同一个调用：先观察（截图或重读状态），再换目标或换手段。

## 7. Windows 上的已知限制（别浪费时间在这上面）

* **权限完整性隔离（UIPI）**：如果 DSH 以普通权限运行，注入的鼠标/键盘**到不了提权窗口**
  （任务管理器、以管理员身份运行的安装程序等）。症状是「调用成功但界面毫无反应」。
  缓解：改用 UI Automation 动作（`perform_action` / `set_value`），或让用户以管理员身份启动 DSH。
* **UWP / 应用商店应用**：窗口属主进程常常是 `ApplicationFrameHost`，`appKey` 可能带 pid 后缀；
  内容元素挂在子进程里，`get_app_state` 仍能读到，但 `list_apps` 的名字可能不直观。
* **最小化窗口**没有几何信息，元素 `bounds` 可能为空 —— 用 `open_application` 重新拉起该应用（或请用户还原窗口）再操作。
* **自绘界面**（Electron/游戏/远程桌面）暴露的元素极少甚至为零，此时只能截图 + 坐标。
* 后端依赖 **Windows PowerShell 5.1**（`powershell.exe`）。被组策略禁止执行脚本时后端起不来，
  `request_access` 会明确报告原因。

## 8. 安全与礼貌

* 你的每次动作都会让用户看到屏幕顶部出现一个小浮层：「DSH 正在操作电脑 · 正在点击」。
  它点击穿透、不抢焦点、不会出现在截图里。**用户看得到你在做什么**，所以动作要名实相符。
* 任务完成或交给用户之前，调用 **`stop_computer_control`**：释放可能按住的键、结束进行中的拖拽，
  同时浮层会立刻收起（它表达的是「控制权已交还」）。
  忘记释放 `hold_key` 会让用户之后的输入一直带着修饰键。
* 不要往你不认识的窗口里输入凭据、密码、支付信息。
* 会被误触的破坏性操作（删除、发送、提交订单、覆盖文件）在执行前必须让用户确认：
  先把要点说清楚，再动手。
* 操作期间用户的鼠标会被真实接管 —— 动作要短、要连贯，做完立刻交还控制权。
* 每次动作都在真机上生效，**没有撤销**：不确定时先截图确认当前状态。

## 9. 与上游 ZCode 的差异

| 上游 ZCode | 本插件 |
|---|---|
| 原生 Helper（`ZCode Computer Use.app` / Windows dev helper），Unix socket + native addon | 长驻 `powershell.exe` 进程，NDJSON 协议（`docs/native-protocol.md`） |
| macOS 需要辅助功能 + 屏幕录制授权，`request_access` 返回授权状态机 | Windows 无这套授权模型；`request_access` 返回平台/屏幕/DPI/后端自述 |
| 工具经 `node_repl` 的 `js` 工具调用（每次 cell 必须完整 bootstrap SDK） | 工具直接注册进 DSH 工具池，正常函数调用即可，无需 bootstrap |
| 25 个 `mcp__computer_use__*` 动作 | 同名 25 个原生工具；配置 `tools: "single"` 可合并成一个 `computer_use`（带 `action` 参数） |
| PiP 会话、操作胶囊、内联截图渲染 | 不做 UI；截图以原生图像块随结果附带，落盘在 DSH home 的 `plugins/dsh-computer-use/frames/` |

## 10. 一页速查

```
request_access                      # 环境自述（只读）
list_apps    { include_minimized? } # 有哪些应用
list_windows { app? }               # 有哪些窗口（物理像素 bounds）
get_app_state{ app?, window?, max_elements?, max_depth? }   # 界面元素树 + state_id
screenshot   { app?, window?, monitor?, max_width?, format? } # 截图（图片 + frame_id）
zoom         { region|left/top/width/height, scale? }        # 放大区域

open_application { app: "notepad" | {path|url|name, args} }
left_click / double_click / triple_click / right_click / middle_click
             { element_index+state_id | x,y,frame_id?,space? , button?,clicks? }
mouse_move   { x, y, frame_id?, space?, duration_ms? }
left_click_drag { element_index+to_element_index+state_id | from_x,from_y,to_x,to_y , frame_id? }
scroll       { direction: up|down|left|right, amount?, x?, y? | element_index+state_id }
type         { text, element_index?, state_id?, interval_ms? }
key          { key: "ctrl+s" } | { text: "a" }
hold_key     { key|text, duration|duration_ms }
set_value    { element_index, state_id, value, submit? }
select_text  { element_index, state_id, start?, length?, all? }
perform_action { element_index, state_id, action: invoke|expand|collapse|toggle|select|focus|scroll_into_view }
wait         { duration|duration_ms, app?, window? }
read_clipboard / write_clipboard { text }
stop_computer_control                # 收尾必调
```
