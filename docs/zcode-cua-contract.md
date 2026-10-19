# ZCode Computer Use 契约逆向取证报告

> 证据源：ZCode 开源仓库的本地克隆（该仓库 git 仅 3 个提交，真实 CUA runtime 从未进仓库）。
> 全文所有事实均以 `路径:行号` 标注（路径相对于 ZCode 仓库根，正斜杠）。
> 凡仓库内找不到依据的，明确写「仓库中无证据」，不做推测性填空。
> 证据强度标记：**[实证]** = 仓库代码显式读写该字段/常量；**[推断]** = 由文案、命名或相邻契约可推出但无直接读写点；**[无证据]** = 查无实据。
>
> **许可与归属**：本文档含对 ZCode 开源仓库（Apache-2.0）的路径/行号引用与少量逐字摘录
> （如 `JS_TOOL_DESCRIPTION`、i18n 文案），用于接口重建取证；摘录著作权归其原作者，
> 本仓库不含上游任何源代码、二进制或资产。详见 [NOTICE.md](../NOTICE.md) §2。

---

## 0. 结论摘要

**开源版到底缺了什么。**
ZCode 仓库里 `packages/zcode-cua/` 是一个 **API 兼容占位包**（`packages/zcode-cua/package.json:4` 自述 "API-compatible placeholder package … every runtime surface reports unavailable and fails closed"）。它的 JS 实现全部是 fail-closed 桩：

* `createComputerUseRuntime()` 的 `execute()` 恒返回 `{ content:[{type:"text",text:"Computer Use is not available in this build."}], isError:true }`（`packages/zcode-cua/index.js:1-13`）。
* broker RPC（`callBrokerMethod`/`probeHelperHealth`）直接抛错或返回空健康值（`packages/zcode-cua/broker.js:34-42`）。
* Helper 安装/校验/启动、native addon 加载、AX 只读方法、`ROLE_TO_KIND` 全部是不可用桩（`packages/zcode-cua/broker-server.js:29-70`）。
* PiP 会话客户端 `enabled` 恒为 `false`（`packages/zcode-cua/pip-session-node.js:1-8`）。
* 官方帧断言谓词恒 `false`（`packages/zcode-cua/frame-contract.js:9-31`）。
* `request_access` 状态 schema 的 `safeParse` 恒失败（`packages/zcode-cua/request-access-contract.js:3-10`）。

同时**三个必需 seed 资产在开源仓库里根本不存在**：`docs/computer-use.md`、`scripts/computer-use-client.mjs`、`skills/computer-use/SKILL.md`（声明见 `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:74-78`；全仓 grep 这三个字符串只命中声明处、`dist` 构建产物、mock-CDN 里的压缩 bundle 与 README 提及，没有任何真实源文件——见 §5）。

**我们能重建到什么程度。**

| 层次 | 可否重建 | 依据 |
|---|---|---|
| 工具面（25 个动作的名字与大部分参数/返回语义） | **可以，高保真** | UI renderer、i18n 文案、错误解析器逐字段读取（§1） |
| 模型可见的 SDK 引导契约 | **可以，逐字** | `JS_TOOL_DESCRIPTION` / `NODE_REPL_SERVER_INSTRUCTIONS` 原文即可抄（§4） |
| broker/传输协议骨架 | **可以** | socket 路径、JSON 行分帧、token、32MiB/1MiB 上限、`_meta` 键全部在仓库（§3） |
| 权限模型与平台矩阵 | **可以（macOS 侧最完整）** | `request_access` 状态机、TCC 引导、Windows 两阶段 transport 均有代码（§6、§8） |
| 子代理禁用策略、项目级授权语义 | **可以** | 三处 fail-closed 门 + `official_cua` 能力组（§7） |
| 真实 SDK 方法签名、Helper 原生接口、CDN 资产内容 | **不能** | 见 §10「未解之谜」 |

一句话：**契约层几乎完整可复原，runtime 层完全不可复原**。本报告的价值在于把「契约」从 UI 与守卫代码里反推出来，作为我们自己实现的接口基线。

---

## 1. 完整工具面

### 1.0 工具名清单与「名字从哪来」

唯一权威清单：`packages/ui/src/ToolCallBlocks/renderers/cuaSummaryMessages.ts:1-27`（25 项）。

工具名归一化规则有**两套且细节不同**，实现时必须同时兼容：

* UI 侧（`packages/ui/src/ToolCallBlocks/renderers/cua.tsx:48-63`）：`toLowerCase()` + `-`→`_`；要求串里包含 `computer_use`；取**最后一个 `__`** 之后的段；且必须匹配 `/^[a-z0-9_]+$/`。
* 核心侧（`apps/zcode-cli/packages/core/src/tool/executor/result-display.ts:237-247`）：`trim().toLowerCase().replaceAll("-","_")`；包含 `computer_use`；同样取最后一个 `__` 之后；**不额外做字符集校验**。
* UI 工具名判定（另有第三条，宽得多）：`packages/ui/src/lib/cuaPermissionAction.ts:3-16`，`toLowerCase()` + `_`→`-`，只要 `normalized === "computer-use" || normalized.includes("computer-use")` 即算 CUA。这是为兼容 plugin namespace 前缀（注释明说 `mcp__plugin_zcode-cua_computer-use__*` 归一化后是单连字符 `cua-computer-use`）。

**架构上的关键事实（决定了工具面怎么用）**：在当前版本里，模型**不是**直接调用这 25 个 MCP 工具，而是调用 `js`（`node_repl`），在 cell 内 bootstrap CUA SDK。证据：

* `apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts:22-27`：`ComputerUseRuntimeBridge.call()` 的注释写明「私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl」。
* `apps/zcode-cli/packages/node-repl-host/src/cua-broker.ts:90-97`：把 `payload.method` 直接当作 `runtime.execute({ toolName })` 传入。
* `apps/zcode-cli/packages/node-repl-host/src/server.ts:76-83`：`tools/list` 只暴露一个 `js` 工具。

所以下面表格的「工具名」在两种解读下都成立：**（a）SDK/broker 的 capability 方法名；（b）早期/其他形态下模型可见的 MCP 工具短名**。UI 与 result-display 同时识别 `mcp__computer-use__<action>` 与 `mcp__plugin_zcode-cua_computer-use__<action>` 两种长名（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cua-app-snapshot.ts:3-11`、`packages/ui/src/v4/conversationCuaGroups.ts:24-27`）。

### 1.1 工具面总表

「必填」列以 **UI/核心代码实际读取** 为准；仓库中不存在 producer 侧的 input JSON Schema（见 §10）。`title` 的行为模型契约级必填，但 runtime 会剥离（见 §1.3）。

| 工具名 | 参数（类型；必填性） | 返回字段 | 备注 |
|---|---|---|---|
| `request_access` | `title`(string) **[实证]**；无其他参数被读取 | `accessibility`、`screen_recording`、`permission_request.{accessibility,screen_recording,permission_guide}`、`permission_guide.all_required_granted`(bool)、`authorization_subject.display_name`、`platform`、`backend`；`_meta["zcode.cua/request-access-status-v1"]` | 权限探针；app-associations 声明 `none` |
| `list_apps` | `title` **[实证]**；其余 **[无证据]** | 结构化结果本身就是数组，元素 `{name, bundle_id, active, pid}`；文本为 JSON 数组 + `\n\nStructured content:` 段 | app-associations 用 `items` 模式（按下标关联） |
| `list_windows` | `title` **[实证]**；`app`/`app_ref`（见 §1.3 通用参数）**[推断]** | 数组，元素 `{title, bounds:[x,y,w,h], main(bool), focused(bool)}` | UI 只取 `bounds[2]/bounds[3]` 作宽高 |
| `get_app_state` | `title`(string, 1–120, **模型契约必填**)、`app`/`app_ref` **[实证]**；`detail`（值含 `compact`）**[推断]** | `state_id`、`window.title`、`focused_element`(number)、`changes.{added_count,removed_count}`、`app.{bundle_id,name}`；SDK 面另有 `state.text`、`state.elements[*].index` | 显式观察动作，见 §4 引导约束 |
| `screenshot` | `title`；`region`(number[4]) **[实证]** | image content block（`mimeType`+`data`）+ 文本 `Full-screen screenshot {w}x{h}px` / `[Attached image/<mime>: …` | 只读；成功文案 "Screen captured" |
| `zoom` | `title`；`region`(number[4]，语义上必填) **[实证]**；`scale` **[无证据]** | 同 `screenshot`，文本含 `Zoom image {w}x{h}px`；被裁剪时含 `Region clamped` | 成功文案 "Screen region zoomed" |
| `open_application` | `title`；`app.url`(string) **[实证]** | **[无证据]**（UI 只回显 url 叶子） | url 可为文件夹（文案 "Open “{target}” folder"） |
| `left_click` | `title`；`target`(见 §1.3) **[实证]**；`app`/`app_ref` **[推断]** | 界面状态文本，元素行形如 `[<index>] <role> <name> = <value> (…)` | 摘要标签 "Click" |
| `double_click` | 同上 **[推断]** | 同上 **[推断]** | 文案 "Double-click" |
| `triple_click` | 同上 **[推断]** | 同上 **[推断]** | 文案 "Triple-click" |
| `right_click` | `title`；`target` **[实证]**（`readCuaActionTargetName` 显式对 `right_click` 生效） | 同 `left_click` | 文案 "Right-click" |
| `middle_click` | 同上 **[推断]** | 同上 **[推断]** | 文案 "Middle-click" |
| `scroll` | **[无证据]**（UI 不读任何字段） | **[无证据]** | 文案 "Scroll" |
| `left_click_drag` | **[无证据]** | **[无证据]** | 文案 "Drag"；名字暗示 from/to 两点 |
| `mouse_move` | **[无证据]** | **[无证据]** | 文案 "Move pointer" |
| `type` | `title`；`text`(string，必填) **[实证]**；`target` **[实证]** | **[无证据]**（字符数由 UI 自己从 input 算） | 成功文案 "Typed {count} characters" |
| `set_value` | **[无证据]**（名字暗示 `target`+`value`） | **[无证据]** | 文案 "Fill value" |
| `select_text` | **[无证据]** | **[无证据]** | 文案 "Select text" |
| `key` | `key`(string，形如 `cmd+shift+p`) **或** `text`(单字符) **[实证]** | **[无证据]** | 成功文案 "Shortcut sent" |
| `hold_key` | `key` **或** `text` **[实证]** | **[无证据]** | 文案 "Hold key" |
| `perform_action` | **[无证据]** | **[无证据]** | 文案 "Perform interface action" |
| `wait` | `duration`(number，**秒**) **[实证]** | **[无证据]** | 成功文案 "Waited {duration} seconds" |
| `read_clipboard` | **[无证据]** | **[无证据]** | 文案 "Read clipboard" |
| `write_clipboard` | **[无证据]** | **[无证据]** | 文案 "Write clipboard" |
| `stop_computer_control` | **[无证据]** | **[无证据]** | app-associations 声明 `none` |

### 1.2 逐工具实证细节

**`request_access`**（证据最完整的工具）
* UI 解析路径：`packages/ui/src/ToolCallBlocks/renderers/cuaAccessDetails.ts:56-119`。
* 权限状态字段可位于 **顶层**（runtime 形态：`result.accessibility`）或 **`permission_request` 下**（legacy 形态），实现必须两者都读：`cuaAccessDetails.ts:43-54, 62-74`。
* `status_after` 的取值映射：`granted` / `not_required` → 已满足；`denied` / `not_granted` / `blocked` → 未满足（`cuaAccessDetails.ts:37-41`）。
* `ready` 判定优先用 `permission_guide.all_required_granted`，否则回落 `accessibility && screenRecording`（`cuaAccessDetails.ts:75-78`）。
* 面向用户的权限行**只有两项**（Accessibility、Screen Recording）。原文注释明确说 legacy runtime 的「自动化」「输入控制」兼容字段不得进入用户可见列表（`cuaAccessDetails.ts:87-101`）；i18n 里仍保留 `chat.toolCall.cua.details.automation`（`packages/ui/src/i18n/locales/en-US.ts:6711`）与 `…inputPermission`（`en-US.ts:6712`），但**全仓无消费者**。
* `_meta` 侧结构化状态：`apps/zcode-cli/packages/core/src/tool/executor/result-display.ts:308-311` 读取 `CUA_REQUEST_ACCESS_STATUS_META_KEY`，键名 `"zcode.cua/request-access-status-v1"`（`packages/zcode-cua/request-access-contract.js:1`），schema 为 `{schemaVersion:1, platform:"darwin", grantOwner:string, accessibility:"granted"|"stale"|"denied", screenRecording:"unknown"|"granted"|"denied"}`（`packages/zcode-cua/request-access-contract.d.ts:5-11`，同构于 `packages/shared/src/zcode-protocol-v4/cuaPermission.ts:5-14`）。
* `platform` 字段在 schema 里被硬编码为字面量 `"darwin"`（同上），**Windows 的 `request_access` 返回形态在仓库中无证据**。

**`list_apps`**
* 结构化结果是数组本身；文本形态是「主 JSON（数组） + `\n\nStructured content:` + 结构化副本」，解析器先按 `\n\nStructured content:` 切分再 `JSON.parse`（`packages/ui/src/ToolCallBlocks/renderers/cuaResultState.ts:94-105`、`cuaListDetails.tsx:37-61`）。
* 元素字段 `name` / `bundle_id` / `active`（`cuaListDetails.tsx:83-97`），另有 `pid`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cua-app-snapshot.ts:88-100`，`pid` 必须是正整数才收）。
* app-associations 使用 `items` 模式（按结果下标关联），因此**不覆盖**同一 cell 里前面动作已确立的 App 身份（`apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts:84-91`）。

**`list_windows`**
* 元素 `{title, bounds:[x,y,w,h], main, focused}`（`cuaListDetails.tsx:99-114`）。`bounds` 是**数组**而非对象，宽度取下标 2、高度取下标 3。
* 「N windows」摘要计数来自结果数组长度（`packages/ui/src/ToolCallBlocks/renderers/cua.tsx:393` → `readCuaResultListCount`，`cuaResultState.ts:107-117`）。

**`get_app_state`**
* UI 读取：`state_id`（`cua.tsx:226`）、`result.window.title`（`cua.tsx:227`）、`result.focused_element`(number)（`cua.tsx:228, 247`）、`result.changes.added_count/removed_count`（`cua.tsx:229, 255-262`）。
* App 身份读取顺序：`result.app.name` → `result.app.display_name` → `input.app.name` → 否则用 `bundle_id`，且 `com.apple.finder` 特判显示为 `Finder`（`cuaResultState.ts:203-218`）。
* 结果可能是**纯文本状态**而非 JSON，此时稳定头部形如 `app: <bundleId> pid=<pid> "<name>"`，由正则解析（`cuaResultState.ts:27-32`）。
* `element_stale` 有专属 UX：失败原因文案 + 建议动作「重新读取应用界面，然后从新状态中选择目标元素」（`cua.tsx:319-327`；i18n `en-US.ts:6719-6725`）。
* `state.text` / `state.elements[*].index` 的**唯一直接证据**在 SDK 引导文案里（§4）：`apps/zcode-cli/packages/node-repl-host/src/tool-contract.ts:42-45`。

**点击族（`left_click`/`double_click`/`triple_click`/`right_click`/`middle_click`）**
* 目标元素命名解析是通用逻辑：从结果文本里找 `[<index>] …` 行，剥掉尾部 `(…)`，按 ` = ` 切分决定可读名称；`textarea` 特殊处理（取等号左侧），纯数值/布尔右侧也回落左侧；按钮名称被拆成紧随其后的**连续 text 节点**时拼接子节点名（`cuaResultState.ts:128-187`）。
* 该解析只对 `left_click` / `right_click` / `type` 用于摘要标签（`cua.tsx:378-381`），但底层结果形态对点击族一致。
* 元素名是纯数字时，UI 会本地化成「Element #{index}」而不再裸露数字（`cua.tsx:382-387`）。

**`screenshot`**
* 参数 `region` 必须是长度 4 且全为 number 的数组才会被采用（`packages/ui/src/ToolCallBlocks/renderers/cuaScreenshotDetails.ts:71-76`）。
* 图片块识别：递归深度 ≤5 找 `data:image/…;base64,`，或 `{mimeType, data}`（`cuaScreenshotDetails.ts:20-49`）。
* 尺寸/范围从**文本**正则提取：`/(?:(?:Full-screen\s+)?screenshot|Zoom image)\s+(\d+)x(\d+)px/i`（`cuaScreenshotDetails.ts:65`），全屏判定 `/Full-screen screenshot\s+\d+x\d+px/i`（`:82`），附件形态 `/\[Attached\s+(image\/[a-z0-9.+-]+):/i`（`:66`）。
* 失败时不渲染截图占位（`cua.tsx:272-273` 注释：失败截图会渲染无效占位，失败原因区已足够）。

**`zoom`**
* 与 `screenshot` 共用解析器；`zoom` 标记靠文本 `/Zoom image/i`（`cuaScreenshotDetails.ts:83`），裁剪标记 `/Region clamped/i`（`:85`）。
* i18n 有完整字段：`zoomPreview`「放大预览」、`region`「原始区域」、`bounds`「边界处理」、`clamped`「已裁剪到屏幕范围」（`en-US.ts:6736-6741`）。
* **`scale` 参数名与取值范围在仓库中无证据**（我们的 `native-protocol.md` 自定义了 `scale` 1–8）。

**`open_application`**
* 唯一被读取的参数是 `app.url`（`packages/ui/src/ToolCallBlocks/renderers/cuaActionDetail.ts:12-22`）；UI 仅把它当 URL 解析并取 pathname 末段作为展示目标，解析失败即返回 null。
* i18n 同时存在 `openApplication`「Open application」与 `openTarget`「Open “{target}” folder」（`en-US.ts:6652, 6656`），说明 url 可以是 `file://` 文件夹。
* **`name` / `path` / `args` 等参数在仓库中无证据**（我们 `native-protocol.md` 的 `name`/`path`/`url`/`args`/`wait_ms` 是自研）。

**`type`**
* `text` 必填且被 UI 用于算字符数（`packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx:57`）。
* 成功文案 "Typed {count} characters"（`en-US.ts:6691`）。
* `target` 也被读取（见点击族）。

**`key` / `hold_key`**
* 参数：`key` 优先，否则 `text`（`cuaActionDetail.ts:44-51`）。
* 展示侧做 macOS 符号化：`cmd/command/meta → ⌘`、`shift → ⇧`、`alt/option → ⌥`、`ctrl/control → ⌃`，其余转大写（`cuaActionDetail.ts:24-42`）。
* **注意**：这是**展示层**，不代表真实语义。我们的 `native-protocol.md` 把 `cmd` 映射为 Win 键是自研决策，ZCode 仓库无 Windows 键盘映射证据。
* `hold_key` 的按住时长参数在仓库中**无证据**（我们的 `duration_ms` 默认 500 是自研）。

**`wait`**
* 参数名是 `duration`（**不是** `duration_ms`），单位是**秒**：`cua.tsx:186` 读 `input.duration`，结果文案 `"chat.toolCall.cua.seconds": "{duration} seconds"`（`en-US.ts:6751`）、`waited: "Waited {duration} seconds"`（`en-US.ts:6727`）。

### 1.3 通用参数

| 名字 | 形态 | 证据 |
|---|---|---|
| `title` | string，模型契约 1–120，`get_app_state` 上**必填** | 定义 `apps/zcode-cli/packages/core/src/mcp/index.ts:39-45`；注入 required `:336-343`；dispatch 前剥离 `:458-468`；UI 读取 `packages/ui/src/ToolCallBlocks/renderers/cua.tsx:74-83` |
| `target` | `{type:"element", index:int}` 或 `{type:"coordinate", x:number, y:number}` | `cua.tsx:137-158`（两种形态分别渲染）、`cuaResultState.ts:151-158`（element 分支要求 `Number.isInteger(index)`） |
| `app` / `app_ref` | 对象或 JSON 字符串，字段 `bundle_id`/`bundleId`/`pid`/`name`；也可出现在 `target.app_ref` | `cua.tsx:91-98`、`cuaResultState.ts:89-92`（支持字符串 JSON）、`cua-app-snapshot.ts:24-42` |
| `region` | number[4] | `cuaScreenshotDetails.ts:71-76` |
| `duration` | number（秒） | `cua.tsx:186` |

`title` 的语义是给用户看的意图摘要，**不属于上游 zcode-cua 参数**：模型 contract 上叠加必填、runtime dispatch 再剥离（`mcp/index.ts:334-343` 注释原文）。

### 1.4 返回字段总汇（跨工具）

| 字段 | 含义 | 证据 |
|---|---|---|
| `state_id` | 界面状态 ID，元素 `index` 只在该状态内有效 | `cua.tsx:226`；语义见 `tool-contract.ts:42-45` |
| `window.title` | 目标窗口标题 | `cua.tsx:227` |
| `focused_element` | 焦点元素下标（number） | `cua.tsx:228, 247` |
| `changes.added_count` / `changes.removed_count` | 界面变化计数 | `cua.tsx:229, 255-262` |
| `app.{name,display_name,bundle_id,bundleId}` / `owner.*` | 目标应用身份 | `cuaResultState.ts:85, 203-218` |
| `permission_request.*` / `permission_guide.all_required_granted` / `authorization_subject.display_name` / `platform` / `backend` | 权限与环境 | `cuaAccessDetails.ts:56-119` |
| `text`（结果文本） | 优先 `display.text`，回落 `toolCall.output`，再回落 `raw.rawOutput` | `cuaResultState.ts:119-126` |
| 元素行 `[<index>] <role> <name> = <value> (…)` | 界面状态的可读文本形态 | `cuaResultState.ts:148-187` |
| `action_sent` | 动作是否真的发出 | **只出现在模型引导文案**：`tool-contract.ts:46-47`「…may not return `action_sent`; a missing field is not a failure」 |
| 错误对象 | `{error:<code>, state_id?, index?, target_app?:{name,bundle_id?}}`，包在 `"Error executing tool"` 之后的 JSON 里 | `packages/ui/src/ToolCallBlocks/renderers/cuaErrorDetails.ts:32-47` |

### 1.5 错误码

* **确定出现的**：`element_stale`（`cua.tsx:282, 321-327`；`cuaErrorDetails.ts` 通用解析）。
* **broker 错误码工厂**（`packages/zcode-cua/broker.js:27-32`，类型见 `packages/zcode-cua/broker.d.ts:19-24`）：
  `not_authorized`、`not_selectable`、`not_settable`、`element_unavailable`、`action_unavailable`、`foreground_required`。
  这四个（not_selectable / not_settable / element_unavailable / action_unavailable / foreground_required）**与 UIA/AX 的 Pattern 能力缺失一一对应**，是我们错误码设计的直接依据。
* `BrokerError.code` 缺省为 `"unavailable"`，`CuaHelperError.code` 缺省为 `"helper_unavailable"`（`packages/zcode-cua/broker.js:8-18`）。
* 完整错误码枚举在仓库中**无证据**（producer 侧 runtime 缺席）。

### 1.6 结果投影与配额（实现时必须照抄的边界）

| 常量 | 值 | 证据 |
|---|---|---|
| `MAX_CUA_DISPLAY_FIELD_BYTES` | 32 KiB | `apps/zcode-cli/packages/core/src/tool/executor/result-display.ts:233` |
| `MAX_CUA_INLINE_MEDIA_BYTES` | 256 KiB（单张解码后字节） | `result-display.ts:234` |
| `MAX_CUA_INLINE_MEDIA_TOTAL_BYTES` | 512 KiB（合计） | `result-display.ts:235` |
| 内联图片张数上限 | 4 | `result-display.ts:288-291` |
| display media `data` base64 长度上限 | 349 528 | `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts:137` |
| 官方 CUA MCP resultBudget | `maxInlineBytes` / `maxModelBytes` 各 256 KiB，`strategy:"truncate"`，`preview.direction:"head"` | `apps/zcode-cli/packages/core/src/mcp/index.ts:125-134` |
| node_repl `js` resultBudget | inline 1 000 000 / model 64 KiB，`strategy:"artifact"`，tail 预览，artifact retention session | `mcp/index.ts:135-142` |
| 普通 MCP resultBudget | inline 100 000 / model 50 000 | `mcp/index.ts:143-148` |
| `MCP_IMAGE_INLINE_BASE64_BYTES` | 200 KiB；raw = ×3/4 | `apps/zcode-cli/packages/core/src/mcp/image-normalization.ts:21-22` |
| `HOST_NODE_REPL_IMAGE_MAX_DIMENSION` | 2048（模型侧 2000） | `image-normalization.ts:23, 25` |
| `OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES` | 200 KiB | `packages/zcode-cua/frame-contract.js:5` |
| `CUA_APP_ASSOCIATIONS_MAX_META_BYTES` | 16 KiB | `packages/zcode-cua/host-display-contract.js:3` |
| 模型可见文本截断标记 | `[Official CUA text truncated by resultBudget. Re-observe with detail=compact or a narrower window before relying on omitted state.]` | `apps/zcode-cli/packages/core/src/tool/executor/result-content-projection.ts:14-15` |

**帧契约（官方 CUA 专有，最严格的一条）**：`image` 与紧随其后的 `image_ref` 构成原子对，**必须是结果的前两块**（下标 0 和 1），否则抛 `OfficialCuaFrameContractError`，错误码 `official_cua_frame_pair_not_leading`（`result-content-projection.ts:17-40`）。通用 resultBudget / hook 一律不得截断、丢弃或重排这对块（`mcp/index.ts:161-165`）。只保留最后一个帧对（`apps/zcode-cli/packages/node-repl-host/src/result.ts:63-73`）。当栅格无法投递时，必须整条结果错误化，**不允许留下 actionable 的引用**（`apps/zcode-cli/packages/adapters/src/model/tool-result-media-projection.ts:200-227`）。

### 1.7 元数据键（`_meta`）总表

| 键 | 值 | 证据 |
|---|---|---|
| `zcode.cua/app-associations-v1` | `{primary?:{appKey,displayName}, items?:[…]}` | `packages/zcode-cua/host-display-contract.js:1`；读取 `cua-bridge.ts:92-109` |
| `zcode.cua/request-access-status-v1` | `CuaRequestAccessStatus` | `packages/zcode-cua/request-access-contract.js:1` |
| `zcode.cua/target-app-display-v1` | `{schemaVersion:1, displayName?, iconLocators[]}` | `apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts:23, 38-44` |
| `zcode.cua/official-frame-integrity-v1` | 帧完整性（值语义无证据） | `packages/zcode-cua/frame-contract.js:1` |
| `zcode/nodeReplCuaApp` | `{appKey, displayName?}`，宿主写入、模型不可伪造 | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts:149`；写入 `result.ts:96-98`；读取 `result-display.ts:349-355` |
| `official_cua_frame_v1` | `modelContentProtection` 标记 | `packages/zcode-cua/frame-contract.js:3`；使用 `mcp/index.ts:164` |

`appKey` 的 producer 形态：`darwin:<bundleId>` / `windows-aumid:<aumid>` / `windows-exe:<path>` / `linux-exe:<path>`；UI 按前缀派生 `ApplicationIconLocator` 再交给平台服务解析，**协议不承载图标字节**（`tool-result-metadata.ts:148-158`）。`ApplicationIconLocator.kind` 闭集为 `darwin-bundle-id` / `windows-executable-path` / `windows-aumid`（`tool-result-metadata.ts:25-36`）。

App 身份的信任链要点：`zcode.cua/app-associations-v1` 与 `zcode/nodeReplCuaApp` 都会被宿主在 `toMcpRunResult` 里**无条件删除**，只接受 CUA bridge 从 broker 响应直接记录的 `run.cuaApp`（`result.ts:89-98`）；identity 的取值发生在 broker 响应这一跳，因为那是「模型看不见也改不了」的唯一位置（`cua-bridge.ts:72-77`）。`request_access` / `stop_computer_control` 声明 `none`、`list_apps` 声明 `items`，都不覆盖已确立的身份（`cua-bridge.ts:84-91`）。

---

## 2. MCP 与工具命名

### 2.1 身份常量

| 常量 | 值 | 证据 |
|---|---|---|
| `ZCODE_CUA_OFFICIAL_PLUGIN_ID` | `computer-use@zcode-plugins-official` | `packages/shared/src/mcp.ts:10` |
| `CANONICAL_CUA_PLUGIN_ID` | 同上（adapters 侧同值副本） | `apps/zcode-cli/packages/adapters/src/config/schema.ts:175` |
| `LEGACY_CUA_PLUGIN_ID` | `zcode-cua@zcode-plugins-official`（旧 id，迁移时 canonical 化；`enabledPlugins`/`options` 双键都会搬运并删除旧键） | `schema.ts:174, 178, 182-183, 431-452` |
| `ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME` | `plugin:computer-use:computer-use` | `packages/shared/src/mcp.ts:13` |
| `ZCODE_PLUGIN_ID_ENV_KEY` | `ZCODE_PLUGIN_ID`（resolver 权威写入，manifest/user env 不可覆盖） | `packages/shared/src/mcp.ts:14-16` |

命名空间规则：server key = 模型可见工具前缀段（**刻意不带 `zcode-`**），namespace name = `plugin:<pluginId>:<serverKey>`（`mcp.ts:11-13` 注释原文）。

### 2.2 两种拼写与 plugin namespace

* **规范名（canonical，模型可见）**：`mcp__computer-use__<action>` — `ZCODE_CUA_CANONICAL_MODEL_PREFIX`，`apps/zcode-cli/packages/core/src/mcp/index.ts:46`。
* **provider 拼写别名**：`mcp__computer_use__<action>` — `ZCODE_CUA_PROVIDER_SPELLING_ALIAS_PREFIX`，`mcp/index.ts:47`；别名是**单向**的、只在「不可伪造的官方 authority 门成立且内部 serverName 仍是官方 namespaced 名」时挂载（`mcp/index.ts:154, 260-276`）。
* **plugin 命名空间形式（adapter 产出的 descriptor.name）**：`mcp__plugin_zcode-cua_computer-use__*`（`mcp/index.ts:94-96` 注释原文）。归一化后 server 段是 `cua-computer-use`（单连字符），这正是 UI 判定必须用 `includes("computer-use")` 的原因（`packages/ui/src/lib/cuaPermissionAction.ts:9-15` 注释原文）。
* 前缀闭集出现在三处，必须一致：
  * `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cua-app-snapshot.ts:3-6`
  * `packages/ui/src/v4/conversationCuaGroups.ts:24-27`
  * `packages/ui/src/ToolCallBlocks/renderers/cua.tsx:56-59`（注释里列了两种）

### 2.3 名称投影与信任门

* `registerMcpTools` 只在 `officialCuaServerNames.has(descriptor.serverName)` 且 serverName 等于官方命名空间名时，才把工具投影为 `mcp__computer-use__<toolName>`；否则沿用 `toMcpToolName(descriptor)`（`mcp/index.ts:86-100`）。
* 信任来源是**不可序列化的内存证据**，不是名字：`resolveTrustedOfficialCuaServerNames` 要求「同一 config 对象引用相等 + `type==="stdio"` + `env.ZCODE_PLUGIN_ID === computer-use@zcode-plugins-official`」三条同时成立（`apps/zcode-cli/packages/bootstrap/src/mcp-config.ts:41-56`）。名称本身不构成信任（`mcp/index.ts:52-57` 注释）。
* allow/deny 规则按**新旧两名任一命中**判定，避免升级前保存的 namespaced denylist 静默失效（`mcp/index.ts:75-78`）。
* `node_repl` 需要 broker 注入但它**不是** CUA MCP server；把它放进 `trustedOfficialCuaServerNames` 会让通用 node_repl 结果误入 exact-raster gate（`apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts:102-108` 注释原文）。

### 2.4 服务端身份识别（`isZCodeCuaStdioServer`）

四条判定（`mcp-config.ts:168-186`）：`name === "computer-use"`；或 `env.ZCODE_PLUGIN_ID === 官方 id`；或 command 命中 zcode-cua 包规格；或 args 中有 zcode-cua 包规格。包规格判定覆盖 `zcode-cua`、`zcode-cua[macos]`、`zcode-cua@1.2.3`、`zcode-cua==1.2.3`、`zcode_cua`、`.git`/`.git@`、点号子模块，并对路径叶子再判一次（`packages/shared/src/mcp.ts:216-258`）。`node_repl` 之外的 CUA 形态一律视为**已退役**并从状态投影中移除（`mcp-config.ts:188-194`）。

---

## 3. broker / helper 架构

### 3.1 进程与传输拓扑

```
模型 → node_repl MCP `js` 工具（stdio）
     → 每次调用一个全新 Worker（apps/zcode-cli/packages/node-repl-host/src/server.ts:253-288）
     → CUA bridge 私有 capability 请求（cua-bridge.ts:22-27）
     → 本机 socket：JSON 行 {id,token,method,input,context}
     → cua-broker（cua-broker.ts:65-106）
     → ComputerUseRuntime.execute({toolName: method, arguments: input, context, signal})
     → Helper（原生 .app / Windows 子进程）← broker-server 生命周期管理器
```

### 3.2 私有 broker 传输协议（逐字）

请求（`cua-bridge.ts:172`）：

```json
{"id":"<uuid>","token":"<64hex>","method":"<capability>","input":{ },"context":{ }}
```

响应（`cua-bridge.ts:183-193` / `cua-broker.ts:99, 103`）：

```json
{"id":"<uuid>","ok":true,"result":{ },"responseMeta":{ }}
{"id":null|"<uuid>","ok":false,"error":"<message>"}
```

* socket 路径：Windows `\\.\pipe\zcode-node-repl-cua-<uuid>`；其他平台 `<tmpdir>/znrc-<uuid>.sock`（`cua-broker.ts:26-29`）。
* `token` = `randomBytes(32).toString("hex")`，服务端用 `timingSafeEqual` 比对（`cua-broker.ts:30, 108-115`）。
* 单行分帧，`\n` 结束；响应超过 **32 MiB** 直接失败（`cua-bridge.ts:9, 176-179`）；请求超过 **1 MiB** 直接失败（`cua-broker.ts:13, 154-158`）。
* 响应 `id` 必须与请求一致，否则 `"Computer Use broker response id mismatch"`（`cua-bridge.ts:190`）。
* 连接生命周期：`socket.close` 或 `error` 且未完成时 abort（`cua-broker.ts:69-74`）；`signal` abort 时立刻 reject（`cua-bridge.ts:169-170, 202`）。
* `responseMeta` 必须由 bridge 合并进 session（`cua-bridge.ts:71` → `input.session().mergeResponseMeta(...)`）。

### 3.3 context 契约（服务端强校验）

客户端构造（`cua-bridge.ts:111-148`）→ 服务端校验（`cua-broker.ts:117-147`）：

| 字段 | 必填 | 来源 / 规则 |
|---|---|---|
| `sessionId` | **是** | `_meta["com.zcode/request-context"].session_id`；缺失即抛 `"node_repl CUA request is missing session_id metadata"`（`cua-bridge.ts:116-117`）；服务端再校验非空（`cua-broker.ts:120-122`） |
| `workspaceKey` | **是** | `workspace_key` ?? `workspaceIdentity` ?? `workspacePath`；缺失即抛（`cua-bridge.ts:118-121`、`cua-broker.ts:126-130`） |
| `runtimeScope` | 是（默认 `main`） | `_meta.runtime_scope === "subagent" ? "subagent" : "main"`（`cua-bridge.ts:125`） |
| `workspacePath` / `workspaceIdentity` | 否 | 原样透传 |
| `remoteSessionId` / `turnId` | 否 | `remote_session_id` / `turn_id` |
| `clientMode` | 是（默认 `desktop-continuous`） | `client_mode` ?? `"desktop-continuous"` |
| `deliveryKind` | 是（默认同 clientMode） | `delivery_kind` ?? clientMode |
| `trace` | 否 | `{traceId, spanId?, parentSpanId?}`，仅当 `trace_id` 存在 |

`_meta` 的命名空间是 `com.zcode/request-context`（`server.ts:302`），且**顶层 MCP `_meta` 是第三方可扩展字段，不能当作 session 路由凭据**（`server.ts:303-305` 注释原文）。

`ComputerUseRuntimeContext` 的完整类型定义：`packages/zcode-cua/index.d.ts:1-12`。

### 3.4 `ComputerUseRuntime` 接口

```ts
// packages/zcode-cua/index.d.ts:14-27
interface ComputerUseRuntimeExecuteInput {
  toolName: string;
  arguments?: unknown;
  context: ComputerUseRuntimeContext;
  signal?: AbortSignal;
}
interface ComputerUseRuntime {
  execute(input): Promise<unknown>;
  closeSession(context): Promise<void>;
  dispose(): Promise<void>;
}
interface ComputerUseRuntimeOptions {
  brokerSocketPath?: string;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  env?: Record<string, string | undefined>;
}
```

runtime 从环境捕获的方式：`ZCODE_CUA_PERMISSION_BROKER_SOCKET` 存在才创建，另读 `ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER`（`server.ts:372-381`）。**必须在 `main()` 生命周期内先捕获**——官方 plugin host 在 `main()` 返回后会清除短暂恢复的 Helper 凭据，而在 `serveStdio` 的 server factory 里读 `process.env` 必然得到空值（`server.ts:318-323` 注释原文）。

### 3.5 环境变量清单

| 变量 | 用途 | 证据 |
|---|---|---|
| `ZCODE_CUA_PERMISSION_BROKER_SOCKET` | broker socket 路径 | `packages/zcode-cua/broker.js:6`；`packages/shared/src/runtimeEnv.ts:14` |
| `ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE` | broker 不可用标记（仅常量，消费点无证据） | `broker.js:7` |
| `ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER` | 权限刷新标记文件 | `server.ts:379`、`mcp-config.ts:33` |
| `ZCODE_CUA_PLUGIN_AUTHORITY` | config-provenance 随机数（16 字节 hex） | `packages/shared/src/runtimeEnv.ts:129`；铸造 `windowsCuaDevHelperHost.ts:34` |
| `ZCODE_CUA_NODE_REPL_HOST` | shared node_repl host 标记（非密钥） | `runtimeEnv.ts:15-16` |
| `ZCODE_CUA_PRODUCT_HELPER` | 产品开关（`0`/`false`/`off` 关闭） | `runtimeEnv.ts:13, 34-41` |
| `ZCODE_CUA_DEV_MODE` | 本地开发一键（隐含 feature flag） | `runtimeEnv.ts:17-23, 29-32` |
| `ZCODE_CUA_DEV_ROOT` | Windows 本地 runtime 根 | `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts:7` |
| `ZCODE_CUA_PLUGIN_ROOT` | CUA 文档根 | `server.ts:47-50` |
| `ZCODE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ID` | 插件根 / 插件身份 | `server.ts:43`、`packages/shared/src/mcp.ts:16` |
| `ZCODE_CUA_HELPER_ADDON`（= `HELPER_ADDON_ENV`） | Helper native addon 路径 | `packages/zcode-cua/broker-server.js:3` |
| `ZCODE_CUA_PERMISSION_BROKER_TOKEN` | **遗留** bearer token，已不再产生也不再消费，但仍从所有子进程 env 剔除（防旧 Helper confused-deputy） | `runtimeEnv.ts:66-70` |

**凭据组纪律**：连接无口令，`socket` + `pluginAuthority` 必须**同批出现**才构成有效凭据组；半组会清空快照并 fail-closed（`runtimeEnv.ts:151-165`）。这两者都从所有子进程 env 剔除（`runtimeEnv.ts:65-72`），且**不得**经 tool-env-passthrough 恢复（`runtimeEnv.ts:96-107`）。

### 3.6 `packages/zcode-cua/` 全部文件清单与契约价值

| 文件 | 契约价值 |
|---|---|
| `index.d.ts` / `index.js` | `ComputerUseRuntime` / `Context` / `ExecuteInput` / `Options` 类型；占位实现 |
| `broker.d.ts` / `broker.js` | `BROKER_SOCKET_ENV`、`BROKER_UNAVAILABLE_ENV`、`BrokerError`、`CuaHelperError`、六个错误码工厂、`callBrokerMethod`、`probeHelperHealth`、`mintBrokerSocketPath`、`resolveBrokerSocketPath`、`parseRequestLine`/`okResponse`/`errorResponse`/`serializeResponse`、`dispatchRequest`/`handleRequestLine`、`isBrokerMethod`/`isReadOnlyBrokerMethod`、`CuaPermissionState`("granted"\|"stale"\|"denied"\|"unknown")、`CuaPermissionStatus`、`ICuaPermissionService` |
| `broker-server.d.ts` / `.js` | `HELPER_ADDON_ENV="ZCODE_CUA_HELPER_ADDON"`、`WINDOWS_DEV_CONTROL_PROTOCOL="zcode-cua-windows-dev/v1"`、`buildHelperOpenArgs`、`resolveHelperPermissionSubjectIdentity`（`appPath`/`executablePath`/`displayName`/`bundleId`）、`createCuaHelperInstaller`、`CuaHelperLifecycleManager`（`acquire({isAdmitted,shouldRetainCurrent,create})`/`peek`/`dispose`）、`CuaProductHelperHost`（`start`/`stop`/`restart`/`restartAfterCurrentStart`/`waitForTransport`/`checkHealth`）、`CuaHelperHandle`（`socketPath`/`launchSocketPath`/`pluginAuthority`/`helperAppPath`/`bundleId`/`pid`）、`CuaPermissionStatusQueryReport`（snake_case：`grant_owner`/`accessibility_probe`/`screen_recording`/`screen_capture_probe`）、`reapOrphanedHelpers`、LaunchServices 权限请求两个入口 |
| `broker-ports.js` | `isCuaPermissionStatusAvailable`（`available === true`）、`shouldRunCuaScreenCaptureProbe`（占位恒 false；隐私契约：省略 options 时**不主动抓屏**） |
| `broker-socket-path.js` | 纯 re-export |
| `broker-helper-constants.js` | `HELPER_APP_NAME="ZCode Computer Use.app"`、`DEV_HELPER_APP_NAME="…Dev.app"`、`HELPER_DISPLAY_NAME`、`HELPER_BUNDLE_ID="dev.zcode.cua-helper"`、`DEV_CUA_HELPER_BUNDLE_ID="dev.zcode.cua-helper.dev"` |
| `broker-helper-health.js` | re-export |
| `frame-contract.js` | 见 §1.7 与 §1.6 |
| `host-display-contract.js` | `CUA_APP_ASSOCIATIONS_META_KEY`、`CUA_APP_ASSOCIATIONS_MAX_META_BYTES = 16 * 1024` |
| `pip-session.d.ts` | `PipSessionEvent` 联合：`turn-started` / `focus-changed` / `turn-ended·turn-completed·turn-failed·tool-scheduled·tool-started` / `session-closed`；公共字段 `sequenceNumber`、`eventId` |
| `pip-session-node.js` | `createPipSessionClient` 占位（`enabled:false`）；选项含 `socketPath`/`timeoutMs`/`reconnectAttempts`/`reconnectDelayMs`/`peerChecker`/`onDiagnostic` |
| `request-access-contract.d.ts` | `CUA_REQUEST_ACCESS_STATUS_META_KEY`、`CuaRequestAccessStatus`（§1.2） |
| `README.md` | 自述「every runtime surface reports unavailable and fails closed」 |

### 3.7 Windows Helper 宿主（services 侧，仍未删的架构）

* `HELPER_ADDON_ENV` 与 `WINDOWS_DEV_CONTROL_PROTOCOL` 由 services **单一来源复用** producer 常量，避免重声明漂移（`windowsCuaHelperHostSupport.ts:8-16`）。
* 控制协议消息闭集：`{protocol:"zcode-cua-windows-dev/v1", type:"transport_ready"|"ready", socketPath, pid}` 与 `{protocol, type:"error", message}`；未知 type 解析为 `"ignore"`（前向兼容），缺字段返回 null（`windowsCuaHelperHostSupport.ts:185-228`）。
* `transport_ready` = 命名管道已绑定并鉴权；`ready` = 完整健康握手（`windowsCuaHelperHostSupport.ts:192-195` 注释原文）。
* 健康校验要求 **exact pid 匹配**（`isExactHealthPid`，`:230-235`）。
* 两阶段终止：先 `sendShutdown()` 等 exit（timeout）→ 再 `kill()` 等 exit（timeout）→ 仍不退抛 termination blocker（`WindowsCuaChildLifecycle.terminate`，`:70-93`）。
* 超时：启动 30 000 ms、关闭 1 000 ms（`windowsCuaDevHelperHost.ts:36-37`）。
* authority：16 字节随机 hex（`windowsCuaDevHelperHost.ts:34`）。
* 生命周期 tail 是唯一线性化边界：任何 fresh fork 都必须排在上一代 exact child exit 之后；`kill` 只是请求，不能把未观察到 exit 的进程当已终止（`windowsCuaDevHelperHost.ts:47-50` 注释原文）。
* `transport_ready` 一旦对外 resolve，Agent 可能已持有凭据，即使 full health 未完成也必须复用；显式 `stop` 才清（`windowsCuaDevHelperHost.ts:61-63`）。
* Windows runtime 解析：dev 模式要求 `ZCODE_CUA_DEV_ROOT` 绝对路径 + `package.json.name === "@zcode/zcode-cua"`；产品模式走 `runtime-manifest.json`（`PRODUCT_RUNTIME_MANIFEST`）与 `["tools","cua-helper"]` 段，逐 artifact 校验 hash 与路径包含关系（`windowsCuaDevRuntime.ts:7-11, 38-50, 283-360`）。

### 3.8 macOS Helper（services/desktop 侧）

* 授权引导**不触发任何原生权限弹窗**：只打开对应系统设置页，Helper 进入 TCC 列表靠用户把 `.app` 从浮窗拖进列表（`packages/desktop/src/main/cuaAccessibilitySettings.ts:2-7` 注释原文）。
* 设置页 URL：`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` 与 `…?Privacy_ScreenCapture`（`cuaAccessibilitySettings.ts:24-27`）。
* 阶段顺序：**先辅助功能，后屏幕录制**（与用户看到的权限列表顺序一致）（`cuaAccessibilitySettings.ts:68-70`）。
* 拖拽 TOCTOU 门：prepare 时抓 bundle 字节指纹（`ino:ctimeNs:size`，覆盖 `_CodeSignature/CodeResources`、`Info.plist`、`Contents/Resources` 树、`Contents/MacOS` 每项），dragstart 前**同步**比对（`cuaAccessibilitySettings.ts:76-144`）。
* 阶段启动前重新跑完整验签，并在验签前后各比一次指纹 + 身份一致性（`verifyHelperPermissionIdentityUnchanged`，`:183-205`）。
* 授权身份 = Helper 的 appPath/executablePath/displayName/bundleId 四元组；main 级协调器按该身份做 key，因为 macOS TCC 只认这个主体（`cuaAccessibilitySettings.ts:239-247`）。
* 导出入口：`openCuaPermissionOnboarding`（`:500`）、`prepareCuaHelperPermissionDrag`（`:594`）、`cuaHelperBundleFingerprintUnchanged`（`:139`）。
* 架构验证：`lipo -archs` 的 `x86_64`/`amd64` 归一为 `x64`，`aarch64` 归一为 `arm64`（`packages/services/src/cua-permission-broker/cuaHelperInstaller.ts:14-30`）。
* PiP 会话：`PipSessionClient` 以 turn 为作用域，`turn-started` 必须先到，否则 PiP 窗口不存在；凭据不可用时会**挂起**该事件并在凭据可用时补发（`cuaPipSessionService.ts:10-70`）。

---

## 4. node_repl 集成与 SDK 引导约束

### 4.1 `JS_TOOL_DESCRIPTION`（逐字，`apps/zcode-cli/packages/node-repl-host/src/tool-contract.ts:31-55`）

> Browser Use and Computer Use only. Run JavaScript in a fresh Node-backed kernel with top-level await only as instructed by the corresponding official skill to control a browser or computer. Do not use it as a general-purpose JavaScript runtime or for filesystem, shell, package inspection, data processing, or other non-browser work. Always provide the required `title` as a short user-facing description in the user's language without implementation terms. If `timeout_ms` is omitted, execution times out after 60000 ms. If the code may take more than 30000 ms including all awaited operations, you MUST set `timeout_ms` to at least the estimated total runtime plus 15000 ms; split the work into multiple calls if that exceeds the 120000 ms maximum. Use `nodeRepl.cwd`, `nodeRepl.homeDir`, `nodeRepl.tmpDir`, `nodeRepl.requestMeta`, `nodeRepl.setResponseMeta(meta)`, `nodeRepl.write(value)`, and `await nodeRepl.emitImage(imageLike)`. Global bindings and module cache do not persist across calls. For Computer Use SDK results, do not console.log/JSON.stringify the complete result or call `nodeRepl.emitImage` yourself; the SDK submits the structured image/state result and you should use `nodeRepl.write` for short text-only status. `get_app_state` is an explicit observation: assign it to `const state`, always call `nodeRepl.write(state.text)`, and use `state.state_id` plus `state.elements[*].index` for element targets; do not leave `get_app_state` as the final expression or regex `state_id` from its text. Metadata methods such as list_apps and list_windows may not return `action_sent`; a missing field is not a failure, so inspect text or structuredContent. Never use screenshot_display.bounds or app/window bounds as raster pixel coordinates; x/y must be integer pixels inside the width/height of the returned raster. Every Computer Use JavaScript call must start with the complete SDK bootstrap in the same cell before agent.computerUse; never split bootstrap and action across calls. Never rely on agent, runtime, browser, or imported bindings from an earlier call. Import only `node:*` builtins and absolute `file://` URLs built from the official skill root, for example `await import(pathToFileURL(join(root, "scripts", "client.mjs")).href)`; bare package specifiers do not resolve. Bootstrap the requested official capability in every call.

（原文第 37 行的 `after ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms` 是**模板串里漏了反引号**的已知瑕疵，运行时展开为 `after 60000 ms`；`NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000` 定义在 `tool-contract.ts:3`。）

### 4.2 `NODE_REPL_SERVER_INSTRUCTIONS`（逐字，`tool-contract.ts:23-29`）

> Browser Use and Computer Use only. Use `js` to run JavaScript in a fresh Node-backed kernel only when the corresponding official skill instructs you to control a browser or computer. Do not use this server for unrelated tasks, including general-purpose JavaScript, filesystem, shell, package inspection, or data processing. Calls default to a 60000 ms timeout. Always provide `title` as a short user-facing description in the user's language. Every `js` call starts fresh; reconstruct browser wrappers and recover persistent tabs from current BrowserControl facts.

其他契约常量：`NODE_REPL_SERVER_VERSION = "0.6.0"`（`tool-contract.ts:19`），serverInfo name 为 `node_repl`（`server.ts:195`）；`js` 的 input schema `{code:string, timeout_ms?:int 1..120000, title?:string 1..120}`，`.strict()`（`server.ts:51-58`），`MAX_SYNC_TIMEOUT_MS = 120_000`（`server.ts:39`）。

### 4.3 这些约束对 SDK 形态的推论

| 约束原文 | 推论 |
|---|---|
| "Every Computer Use JavaScript call must start with the complete SDK bootstrap in the same cell before `agent.computerUse`" | SDK 顶层导出**至少**包含一个名为 `setupComputerUseRuntime` 的引导函数；模型被要求「原样照抄」整段 bootstrap。锚点选择是**架构强制**而非文档软要求（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts:21-27` 注释原文：每个 cell 都是全新 Worker、SDK 绑定不跨 cell） |
| "before `agent.computerUse`" | bootstrap 会返回/装配一个对象，其上挂 `computerUse` 命名空间（具体成员名无证据） |
| 每次调用必须完整 bootstrap，不得跨 cell 复用 `agent` / `runtime` / `browser` / imported bindings | 我们若要等价，必须把「每次 cell 重建 runtime」变成**协议强制**（例如每 cell 重置 frame/state 缓存，或显式 session 令牌） |
| "Import only `node:*` builtins and absolute `file://` URLs built from the official skill root" | SDK 以**文件 URL** 形式从插件根加载，例如 `pathToFileURL(join(root,"scripts","client.mjs")).href`；bare specifier 不解析 |
| "`get_app_state` … assign it to `const state`, always call `nodeRepl.write(state.text)`, and use `state.state_id` plus `state.elements[*].index`" | `get_app_state` 返回对象必须同时提供 `text`（人/模型可读）、`state_id`、`elements[*].index`；**`text` 不是机器可解析信道**（模型被明确禁止用正则从 `text` 抽 `state_id`） |
| "Metadata methods such as list_apps and list_windows may not return `action_sent`; a missing field is not a failure" | `action_sent` 是「有则更可信」的**可选**字段，不是成功判据 |
| "Never use `screenshot_display.bounds` or app/window bounds as raster pixel coordinates; x/y must be integer pixels inside the width/height of the returned raster" | 存在 `screenshot_display.bounds`（**屏幕坐标空间**）与「返回栅格」（**图片坐标空间**）两套坐标；模型只被允许用后者。与我们的 `native-protocol.md` §3 同源 |
| "do not `console.log`/`JSON.stringify` the complete result or call `nodeRepl.emitImage` yourself; the SDK submits the structured image/state result" | SDK 内部走 `nodeRepl.emitStructuredResult`（`apps/zcode-cli/packages/core/src/repl/node-repl-session.ts:200-202`），以保住 image/image_ref 邻接 |
| "Global bindings and module cache do not persist across calls" | kernel 每次都新；模块缓存也随调用销毁（`server.ts:112-115` 注释原文） |

### 4.4 操作事件协议

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts` 把 session 事件映射为 CUA 操作事件：

* `usesComputerUse()` 只做布尔判定：源码里 `code.includes("setupComputerUseRuntime")`（`:28-32`）。**刻意不抽取动作名**，因为源码形态会随 SDK 演进（注释举了「改成 `getApp()` + 绑定对象 + `computer.*`」的例子），字符串匹配迟早一种都命中不了（`:14-27` 注释原文）。
* 事件种类：`turn-started` / `turn-completed` / `turn-failed` / `tool-scheduled`（仅此带 `computerUse:true`）/ `tool-started` / `session-closed`（`:43-88`）。
* `computerUse` 只挂在 `tool-scheduled` 上：`ToolCallStartedPayload` 没有 input，start 时拿不到模型源码（`packages/shared/src/zcode-protocol/index.ts:1075-1079` 注释原文；schema 定义 `:1049-1099`）。
* 触发条件：`toolName === "mcp__node_repl__js"` 且源码含锚点（`computer-use-operation-event.ts:65-67`）。
* 协议方法名：`computer-use/operation-event`（`packages/shared/src/zcode-protocol/index.ts:3565`）；消费方 `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`（用 `computerUseScheduledCalls` 集合跟踪未完成的 CUA 调用，`:76, 151-164, 261-268, 304-325`）。

### 4.5 文档根

`cuaDocumentationRoot = resolve(process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot, "docs")`，与 Browser Use 的 `browserDocumentationRoot = resolve(pluginRoot, "docs")` **刻意隔离**：否则 CUA skill 会因为 host root 恰好来自 Browser Use 而产生隐式依赖（`server.ts:44-50` 注释原文）。bridge 把它作为 `documentationRoot` 暴露给 SDK（`cua-bridge.ts:26, 55`）。

---

## 5. 官方插件定义与资产清单

### 5.1 插件定义（`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`）

```ts
// :34-35
const OFFICIAL_CUA_PLUGIN_NAME = "computer-use";
export const OFFICIAL_CUA_PLUGIN_ID = `${OFFICIAL_CUA_PLUGIN_NAME}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`;

// :74-78
const OFFICIAL_CUA_REQUIRED_SEED_PATHS = [
  "docs/computer-use.md",
  "scripts/computer-use-client.mjs",
  "skills/computer-use/SKILL.md",
] as const;
```

定义对象（`:326-363`）：

| 键 | 值 | 行 |
|---|---|---|
| `name` | `"computer-use"` | `:335` |
| `hostMcpServerNames` | `["node_repl"]` | `:336` |
| `listing.displayName` | `"Computer Use"`；zh-CN `"电脑控制"` | `:343-344` |
| `listing.category` / `author` | `"productivity"` / `ZAI_AUTHOR`（name `Z.ai`，url `https://z.ai`，`:57`） | `:341-342` |
| `listing.icon` | `https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-cua/icon.png`（插件更名后 CDN 目录仍叫 `zcode-cua`，避免 404） | `:58, 348-349` |
| `rootCandidates` | `packages/zcode-cua-plugin` 及 `../` 三级 | `:351-356` |
| `requiredSeedPaths` | §5.2 | `:357` |
| `runtimeTopLevelPaths` | `[]`（当前为占位包，无需复制 native runtime） | `:358-359` |
| `version` | `"0.6.3"`（追踪上游 zcode-cua runtime 版本） | `:360-362` |
| `defaultEnabled` | **不声明** = 默认关闭（产品决策） | `:326-334` |

**默认关闭的理由（原文）**：computer-use 携带 MCP server 与系统 Helper 依赖，默认开启意味着每个新用户首启即注入整套工具集并拉起 Helper；判定式是 `enabledPlugins[id] ?? defaultEnabled`，**曾在设置页手动开过的用户已落盘显式 true，不受默认值变更影响**（`:326-334`）。名单侧同步：`packages/shared/src/plugin-marketplaces.ts:27`「电脑控制回退为默认关闭，故 computer-use 不在此名单内」。

### 5.2 必需 seed 资产 —— **三个文件在开源仓库中不存在**

全仓 grep `docs/computer-use.md`、`scripts/computer-use-client.mjs`、`skills/computer-use` 的**全部**命中位置：

| 命中 | 性质 |
|---|---|
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:75-77` | 声明（字符串字面量） |
| `apps/zcode-cli/packages/bootstrap/dist/app/official-plugin-definitions.js:32-34` | 同一声明的构建产物 |
| `apps/zcode-cli/packages/node-repl-host/README.md:20` | 文档提及 |
| `packages/desktop/scripts/prepare-agent-node-bundle.mjs:77` | 注释提及「已归 `@zcode/zcode-cua-plugin`」 |
| `packages/desktop/mock-cdn/releases/3.14.3/glm/*/zcode.cjs:14759` 与 `packages/desktop/bundled-agents/win32-x64/glm/zcode.cjs:14759` | 压缩 bundle 里的同名子串（第三方依赖代码，非 CUA 资产） |
| `packages/desktop/mock-cdn/releases/3.14.3/glm/*/packages/node-repl-host/README.md:20` | mock-CDN 里的 README 副本 |

* 未在 `packages/` 下找到任何 `computer-use*` 目录或 `SKILL.md`（glob `**/computer-use*/**` in `packages/` 无结果）。
* `apps/zcode-cli/packages/node-repl-host/README.md:20-23` 说明产物归属：`dist/mcp/server.js` 与 `scripts/computer-use-client.mjs` 在 SEA 发布清单里、路径不能动；CUA 的 client/docs 副本「由构建脚本生成而非手工维护」。
* `packages/desktop/scripts/prepare-agent-node-bundle.mjs:77` 指出这些资产「已归 `@zcode/zcode-cua-plugin`」——即被拆到非开源仓库。

**结论：这三个文件的真实内容在开源版中不可获得。** 我们能重建的只是它们的**角色**：`docs/computer-use.md` = 模型读的参考文档（含 bootstrap 原文）；`scripts/computer-use-client.mjs` = SDK 实现，由 skill root 以 `file://` 方式 import；`skills/computer-use/SKILL.md` = 技能入口。

### 5.3 seed 门控与抑制

* `resolveOfficialPluginRoots` 在 **seed/discovery 层**（不只是隐藏 UI 面）门控：feature flag 关闭时把 `computer-use@zcode-plugins-official` 加进 `suppressedBuiltins`，这样用户无法经 plugin 列表 / marketplace / MCP 设置 / CLI 命令看到它（`apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts:234-239`）。
* CUA **不做 fallback root**：frame contract 随 wrapper 与 producer 原子升级，加载旧版本 cache 会把旧 block 布局接到新 consumer 上，宁可不注册（`bundled-plugins.ts:245-253`）。
* 恢复内置插件时，若 CUA feature flag 关闭，协议层也会在写盘前失败，保证用户配置与插件缓存零痕迹（`apps/zcode-cli/packages/bootstrap/src/plugins.ts:892-900`）。
* `resolveOfficialPluginHostMcpServerNames(pluginId)` 返回定义的 `hostMcpServerNames`（`:376-381`）。

### 5.4 feature flag

`isZCodeCuaInternalFeatureEnabled`（`packages/shared/src/runtimeEnv.ts:34-41`）：

```ts
if (isCuaDevModeRequested(env)) return true;            // ZCODE_CUA_DEV_MODE = 1|true|on
const explicit = env[ZCODE_CUA_PRODUCT_HELPER_ENV_KEY]?.trim().toLowerCase();
if (explicit === "0" || explicit === "false" || explicit === "off") return false;
return true;                                            // 默认 true
```

注释原文：「CUA 现已默认打包进正式版（plugin staged + Helper enabled），不再需要显式 env flag」。调用点：`bundled-plugins.ts:237`、`plugins.ts:895`（另有 `packages/desktop` 打包层默认值，见 `official-plugin-definitions.ts:333-334` 注释）。

### 5.5 plugin host 启动与凭据恢复

`apps/zcode-cli/packages/cli/src/plugin-host-command.ts`：

* `__zcode-plugin-host` 在 agent 子进程里运行 official plugin 的 MCP server（`:23`）。
* 恢复 bearer token 的最后一道宿主边界；**只凭存在 capture 就把 token 恢复给任意 server path，第三方/被替换的插件可借此取得 CUA broker 的 TCC 能力**（`:25-29` 注释原文）。
* 授权校验要求：`credentials.socket` 与 `credentials.pluginAuthority` **都非 undefined**、`ZCODE_PLUGIN_ID === computer-use@zcode-plugins-official`、`ZCODE_CUA_NODE_REPL_HOST === "1"`，任一不符在 import 之前拒绝（`:83-105`）。
* 校验**不能**要求 token 齐全——身份模式凭据没有 token，强校验会让 node_repl 宿主启动即退出（`"connection closed during the server/discover probe"`），工具面为空（`:88-95` 注释原文）。

---

## 6. 权限模型

### 6.1 权限种类与状态机

| 概念 | 取值 | 证据 |
|---|---|---|
| `CuaPermissionKind` | `"accessibility"` \| `"screen_recording"` | `packages/shared/src/cuaAccessibilitySettings.ts:1` |
| `CuaPermissionState` | `"granted"` \| `"stale"` \| `"denied"` \| `"unknown"` | `packages/zcode-cua/broker.d.ts:74` |
| `CuaPermissionStatus.accessibility` | `granted` \| `stale` \| `denied` \| `unknown` | `broker.d.ts:80` |
| `CuaPermissionStatus.screenRecording` | `granted` \| `denied` \| `unknown` | `broker.d.ts:86` |
| `CuaRequestAccessStatus`（wire schema，**platform 硬编码 `"darwin"`**） | `{schemaVersion:1, platform:"darwin", grantOwner:string, accessibility:"granted"\|"stale"\|"denied", screenRecording:"granted"\|"denied"\|"unknown"}` | `packages/shared/src/zcode-protocol-v4/cuaPermission.ts:5-14` |
| 必需权限推导 | `accessibility ∈ {denied, stale}` 与 `screenRecording === denied` 才算缺失；`unknown` **不算**缺失 | `cuaPermission.ts:16-27` |
| broker 侧查询报告（snake_case） | `grant_owner`、`owner.display_name`、`accessibility_probe.{ok,classification?}`、`screen_recording`、`screen_capture_probe.{ok,classification?}` | `packages/zcode-cua/broker-server.d.ts`（`CuaPermissionStatusQueryReport`） |
| 对话内权限观察事件 | `{schemaVersion:1, eventId, eventSeq, occurredAt, sessionId, turnId?, toolCallId, permissionStatus}` | `packages/shared/src/zcode-protocol-v4/cuaPermission.ts:29-41` |

**隐私契约**：`shouldRunCuaScreenCaptureProbe(state, options)` 决定「省略 options 时是否主动抓屏」；实现漂移会导致隐私契约破坏（`packages/services/src/cua-permission-broker/cuaPermissionService.ts:43-49` 注释原文）。UI 侧调用一律显式传 `{ includeFunctionalProbes: false }`（`packages/ui/src/cua-permission/CuaPermissionObservationAttachment.tsx:148, 183`）。

**`available` 判别**：`isCuaPermissionStatusAvailable(result)` 要求 `result.available === true`（`packages/zcode-cua/broker-ports.js:1-3`）；不可用形态是 `{available:false, reason, idle?, grantOwnerDisplayName?}`（`broker.d.ts:95-100`）。

**UI 文案到状态的映射**（`packages/ui/src/settings/ComputerUseSection.tsx`）：`granted`→`cuaPermission.status.granted`（`:556`）、`stale`→`.stale`（`:563`）、`denied`→`.missing`（`:569`）、其他→`.unknown`（`:574`）；探测中显示 `.verifying`（`:540`）。

### 6.2 服务接口

```ts
// packages/zcode-cua/broker.d.ts:102-125
interface ICuaPermissionService {
  getStatus(workspacePath, workspaceIdentity?, options?: {probeScreenCapture?: boolean}):
    Promise<CuaPermissionStatusResult>;
  restartHelper(workspacePath?, workspaceIdentity?, options?: {
    onboardingSessionId?: string; reason?: string; beforeFreshStart?: () => void;
  }): Promise<CuaPermissionRestartResult>;  // { ok: boolean; reason?: string }
}
```

services 侧把它注册为 RPC descriptor（`ServiceChannels.CuaPermission`），类型从 producer 的 `@zcode/zcode-cua/broker` 复用、value 由 services 的 `createServiceDescriptor` 创建，避免 producer 反向依赖 RPC/service registry（`cuaPermissionService.ts:1-55`）。

### 6.3 macOS 授权引导

见 §3.8。关键交互契约（`packages/shared/src/cuaAccessibilitySettings.ts:11-26`）：

| 字段 | 语义 |
|---|---|
| `success` | 整个引导是否成功 |
| `canceled` | 用户取消 |
| `sessionId` | main 级 onboarding 会话 id；同一 Helper identity 的并发窗口共享同一 id |
| `returnedFromSettings` | **只有所有 staged 设置页都观察到任意 ZCode 窗口返回后才为 true**；renderer focus 可能来自 TCC 原生 prompt、另一窗口或普通切换，不能当授权完成信号（`packages/ui/src/lib/cuaPermissionAction.ts:18-29` 注释原文） |
| `restartHelperAfterReturn` | additive ABI；同一 renderer/host 的重复调用拿到 `false`，不同窗口的独立 Helper 各自恢复（`cuaAccessibilitySettings.ts:18-23`） |
| `error` | 失败原因 |

`PrepareCuaHelperPermissionDragResult`（renderer 可见形态）：`{success, error?, helperAppPath?, helperDisplayName?, helperBundleId?}`；`helperBundleFingerprint` **故意不在此声明**——它是 main 进程内存缓存的同步 TOCTOU 证据，跨 IPC 暴露给 renderer 既无用又扩大攻击面（`cuaAccessibilitySettings.ts:28-40` 注释原文）。

### 6.4 Windows 权限模型

* Windows **没有** TCC 等价物：`cuaRequestAccessStatusSchema.platform` 是字面量 `"darwin"`（`cuaPermission.ts:8`），仓库中**无 Windows `request_access` 返回形态的证据**。
* Windows 侧的「权限」体现为 Helper 子进程的两阶段 transport + exact-pid 健康校验（§3.7），以及 `ZCODE_CUA_DEV_MODE` 下的本地未签名/未鉴权放宽（`packages/shared/src/runtimeEnv.ts:17-23` 注释原文：「unsigned/unauthenticated local helper, dev install variant, "Dev.app" naming」）。
* `WindowsCuaHelperHost` 的 authority 是 config-provenance 随机数（16 字节 hex），与 node.ts 懒分支 spawn 同口径（`windowsCuaDevHelperHost.ts:33-34`）。

### 6.5 已弃用/保留件

* `CuaAgentAdmissionGate` 标注 `@deprecated`——默认 CUA 装配已不再注入该准入屏障；当前 Helper recovery 只影响后续 Agent admission，不阻塞也不回收已有 Agent（`packages/services/src/cua-permission-broker/cuaAgentAdmissionGate.ts:13-19` 注释原文）。接口仍保留 `beginRecovery`/`isRecovering`/`waitForSpawnAdmission`/`commitRecovery`/`failRecovery`。
* `CuaHelperLifecycleManager` 占位实现里 `acquire()` 只做 `isAdmitted()` 检查后直接 `create()`，**没有**真实实现的 `shouldRetainCurrent` 复用逻辑（对比 `broker-server.d.ts` 的签名与 `broker-server.js:61-83` 的实现）——这本身就是 producer 逻辑缺失的证据。

---

## 7. 子代理与作用域策略

### 7.1 三条独立的 fail-closed 门

| 层 | 机制 | 证据 |
|---|---|---|
| 运行时 bridge | `assertAvailable()` 检查 `active.requestMeta.runtime_scope === "subagent"`，抛 `"Computer Use is not available in subagent"`；同时 broker 连接不存在也抛 | `apps/zcode-cli/packages/node-repl-host/src/cua-bridge.ts:8, 43-52` |
| 子代理配置预检 | `validateSubagentComputerUseConfiguration` 在**创建子代理之前**检查 profile 是否显式请求了官方 CUA server / tool / skill，命中即抛 `ConfigurationError`，`context.code = "SUBAGENT_COMPUTER_USE_UNAVAILABLE"`，`recoverable: true` | `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts:149-180, 834-878` |
| 借用的 MCP port | `createBorrowedSubagentMcpAccess(..., officialCuaServerNames)` 把官方 CUA server 名传入 `deniedServerNames`；`callTool` 命中即抛同一 message | `subagent.ts:607-612`；`apps/zcode-cli/packages/core/src/subagent/borrowed-mcp-port.ts:9-18, 42-45` |

常量：`SUBAGENT_COMPUTER_USE_UNAVAILABLE_CODE = "SUBAGENT_COMPUTER_USE_UNAVAILABLE"`、`SUBAGENT_COMPUTER_USE_UNAVAILABLE_MESSAGE = "Computer Use is not available in subagent"`（`apps/zcode-cli/packages/core/src/subagent/computer-use-policy.ts:9-11`）。第三处在 Skill 加载路径复用同一 code（`subagent.ts:890-903`）。

### 7.2 官方 CUA 策略对象（`computer-use-policy.ts:21-117`）

```ts
interface OfficialCuaPolicy {
  serverNames: ReadonlySet<string>;
  isOfficialToolRequest(name): boolean;
  isOfficialServerSelector(name): boolean;
  isOfficialSkillRequest(name): boolean;
  isOfficialSkill(metadata): boolean;
}
```

* 前缀集合：`mcp__computer-use__`（canonical）+ `mcp__computer_use__`（alias）（`:13-14`）。
* server selector 段集合：`computer-use` / `computer_use` / `toModelVisibleMcpNamePart("plugin:computer-use:computer-use")`（`:15-19, 56-63`）。
* server selector 语法：必须以 `mcp__` 开头、以 `__*` 结尾（`:92-94`）——即形如 `mcp__computer-use__*`。
* 工具名判定：**一旦收到真实 descriptor 就收窄为精确集合**，只有「尚无启动快照」时才退回前缀匹配，避免第三方同名工具被误判成官方 CUA（`:79-88` 注释原文）。
* 裸 Skill 名不用作官方判据（第三方同名 Skill 会被误拒）；官方 Skill 判定要求 `metadata.source === "plugin"` + pluginName 匹配 + rootPath 被官方 rootPath 包含 + qualifiedName 在集合内（`:96-110`）。

### 7.3 项目级授权语义

* 能力组常量：`PermissionCapabilityGroup.OfficialCua = "official_cua"`（`apps/zcode-cli/packages/contracts/src/interfaces/permission.port.ts:13`）；`mcp/index.ts:38` 用 `satisfies` 复述同一字面量，`:158-166` 在官方 authority 门成立时挂到 ToolEntry 上。
* 保留规则键：`OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME = "zcode:permission-capability:official_cua"`（`packages/shared/src/zcode-protocol-legacy-types.ts:45`）。
* 规则匹配**不能**只看字符串：只有当当前 tool entry 另行携带宿主验证后的 `official_cua` capability 时才匹配；同名第三方 MCP、authority 漂移、旧普通 tool 都不能把可解析的 wire/storage 字符串升级成可信能力（`apps/zcode-cli/packages/core/src/permission/service.ts:269-281` 注释原文）。
* 默认建议规则：`buildDefaultPermissionUpdates` 在 capabilityGroup 存在时**只**输出这一条保留规则；其他 capabilityGroup 直接抛 `Unsupported permission capability group`（`apps/zcode-cli/packages/core/src/tool/executor/permission-suggestions.ts:6-22`）。
* 用户可见文案（**逐字**）：
  * 项目级选项名 `"Always allow Computer Use in this project"`（`apps/zcode-cli/packages/bootstrap/src/permission-options.ts:81-83`；TUI 侧同串 `apps/zcode-cli/packages/tui/src/app-approval.ts:59-63`）
  * 描述 `"Do not ask again for official Computer Use tools in this project"`（`permission-options.ts:77-79`）
  * 普通项目级选项 `"Always allow in this project"` / `"Do not ask again for matching requests in this project"`（`permission-options.ts:78-83`）
  * 会话级选项 `"Always allow in this session"`，`optionId = "allowSession"`，`kind = "allow_session"`，response **不带** permissionUpdates（会话语义由 broker 在应答侧合成，纯内存、绝不落项目规则）（`permission-options.ts:23-25, 56-74`）
  * `optionId` 常量：`allow_once` / `allow_project` / `deny`（`permission-options.ts:50, 84, 95`）
* TUI 侧同一判定：`isOfficialCuaProjectApproval(request)` 检查 `addRules`+`allow`+规则名命中保留键（`app-approval.ts:67-74`），面板据此切换文案（`apps/zcode-cli/packages/tui/src/app-approval-panel.tsx:6, 108`）。
* 无关工具不应显示 Computer Use 字样：`buildProtocolPermissionOptions` 用 `officialCuaProjectScope` **布尔**决定文案分支（`permission-options.ts:43-45, 77-83`）。
* MCP 工具的通用权限声明：`permission: "mcp"`、`patternSources: ["toolName","input","network"]`、`denyPriority: "beforeAsk"`、`needsApproval: true`；`node_repl` 的 `js` 被特别标注 `sideEffectScope: "system"`、`riskLevel: "high"`（其它 MCP 默认 `network`/`medium`），否则权限 UI 会把文件/进程级能力错误描述成普通网络调用（`mcp/index.ts:108-124, 189-197` 注释原文）。

### 7.4 工具可见性与超时

* MCP 工具默认超时 30 000 ms（`mcp/index.ts:37, 124`）。
* `official_cua` 能力组还会带上 `modelContentProtection: official_cua_frame_v1`（`mcp/index.ts:158-166`），由 `preserveOfficialCuaFrameResult` 在归一化阶段消费（`image-normalization.ts:17, 40-41`）。
* 官方 CUA 图片压缩开关：`js` cell 走 `compressOversizedImages: true`，但 `preserveOfficialCuaFrames: officialCuaAuthorityVerified` 优先（`mcp/index.ts:247-254`）。

---

## 8. 平台支持矩阵

| 平台 | 支持 | 判据 | 证据 |
|---|---|---|---|
| 本地 macOS 桌面 | **支持** | `isMacDesktop` | `packages/ui/src/settings/computerUseAvailability.ts:56` |
| 本地 Windows 桌面 | **支持** | `isWindowsDesktop` | `computerUseAvailability.ts:57` |
| 本地 Linux 桌面 | **不支持** | 兜底分支 | `computerUseAvailability.ts:58` |
| Web（非桌面） | **不支持** | `!isDesktop` | `computerUseAvailability.ts:55` |
| 远端（ssh / wsl / docker / 其它 server） | **不支持** | `remoteSessionId \|\| remoteTarget \|\| isRemoteWorkspaceIdentity(workspaceIdentity)` | `computerUseAvailability.ts:36-54` |

* 远端种类细分：`remote-ssh` / `remote-wsl` / `remote-docker` / `remote-server`（`computerUseAvailability.ts:42-49`）。
* `isRemoteWorkspaceIdentity` 定义在 `packages/shared/src/remote-workspace-identity.ts:111`。
* 其它使用同一判定的入口：`packages/ui/src/hooks/useCuaComposerEntry.ts:8, 62`、`packages/ui/src/settings/ComputerUseSection.tsx:14, 80`。
* 设置页在「不支持」时不返回 `null`（否则只剩标题、让用户以为加载失败），而是渲染明确的能力边界卡片，且**不渲染任何会触发本地 CUA 写操作的控件**（`ComputerUseSection.tsx:683-702` 注释原文）。文案：`settings.computerUse.unsupported.title` / `.remoteDescription`（"not yet supported for SSH, WSL, Docker, or other remote environments. Switch to a local macOS or Windows workspace."）/ `.linuxDescription` / `.badge` / `.group`（`packages/ui/src/i18n/locales/en-US.ts:6805-6811`；zh-CN `packages/ui/src/i18n/locales/zh-CN.ts:6483-6489`）。
* 插件市场页同款提示与徽标：`packages/ui/src/settings/PluginsSection.tsx:649-661, 892`。

**macOS 版本地板**（`packages/desktop/src/main/cuaOsSupport.ts`）：

* `CUA_MINIMUM_MACOS_VERSION = "12.0"` —— 承诺地板 = `max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA 二进制 minos 11.0)`；2026-08 事故：地板检查缺位时低版本 macOS 用户只看到授权反复无响应（真因是 LaunchServices `-10825` 拒启 Helper）（`:4-7` 注释原文）。
* `CUA_MINIMUM_DARWIN_MAJOR = 21`（Darwin major − 9 = macOS major）（`:8-10`）。
* `resolveCuaOsSupport(platform, darwinRelease)`：非 darwin 返回 `{kind:"not-applicable"}`（`:20`）；darwin major < 21 返回 `{kind:"macos-below-minimum", minimumMacOs, currentMacOs}`（`:23-29`）；否则 `{kind:"supported"}`（`:30`）。
* 类型：`CuaOsSupport = {kind:"supported"} | {kind:"macos-below-minimum", minimumMacOs, currentMacOs} | {kind:"not-applicable"}`（`packages/shared/src/platform.ts:514-517`；注释 `:506-513` 记录了 LaunchServices `-10825` 事故）；RPC 通道 `DesktopCommandIds.GetCuaOsSupport = "getCuaOsSupport"`（`platform.ts:501`），main 侧处理 `packages/desktop/src/main/desktopCommandHandlers.ts:685-686`。
* UI：`osSupport.kind === "macos-below-minimum"` 时渲染提示卡并**隐藏授权操作区**（`ComputerUseSection.tsx:104-123`）；文案 `cuaPermission.osFloorTitle` / `.osFloorDescription`（`en-US.ts:6787-6790`），渲染 `ComputerUseSection.tsx:757-764`。
* **Windows 最低版本在仓库中无证据。**

### 8.1 文案遗留（无消费者）

以下 i18n 键在开源版全仓 grep **无任何消费者**，是真实 build 被剥离后留下的文案残骸，可作为我们重建范围的提示：

* `chat.cuaReadiness.toolsNotLoaded` / `.toolsPreparing`（`en-US.ts:6635-6638`）——原用于「CUA 工具尚未加载（已加载 {count} 个）」的就绪态提示。
* `cuaPermission.probeVerifyingHint`（`:6774`）、`cuaPermission.tools.preparing` / `.agentUpdateRequired` / `.untrustedRuntime`（`:6776-6782`）、`cuaPermission.ready` / `.ready.sessionValidationHint`（`:6791-6793`）。
* `cuaPermission.modal.restartButton` / `.restarting` / `.restartFailed` / `.relaunchAppButton` / `.relaunchAppHint` / `.unavailable` **有**消费者（`ComputerUseSection.tsx:241, 267, 391, 447, 500, 590-600`），与上面那组要区分。
* `chat.toolCall.cua.details.raw` / `.rawInput` / `.rawOutput`（`:6675-6677`）、`.automation` / `.inputPermission`（`:6711-6712`）、`chat.toolCall.cua.openNamedApplication`（`:6653`）、`.clickElement` / `.clickElementFailed` / `.clickTarget` / `.clickTargetFailed`（`:6659-6662`）、`.readNamedApp` / `.listNamedWindows` / `.openTarget`（`:6654-6656`）、`.typeText`（`:6671`）、`.pressKey`（`:6746`）、`.waitDuration`（`:6750`）均无消费者。
* `packages/ui/src/ToolCallBlocks/renderers/cuaDetails.tsx:58-59` 注释解释了为什么 raw 视图被删：「完整 tool call JSON 混入了面向用户的 CUA 详情，暴露内部生命周期字段并制造无效入口。原始数据继续保留在协议与持久化层；这里仅渲染用户完成操作所需的信息。」

---

## 9. 重建对照表（ZCode 契约 ↔ 我们的 `docs/native-protocol.md`）

> 对照基准：本仓库的 `docs/native-protocol.md`（协议标识 `dsh-cua/1`，宿主 Windows PowerShell 5.1，stdin/stdout NDJSON）。

### 9.1 架构对照

| 维度 | ZCode | 我们（native-protocol） | 判定 |
|---|---|---|---|
| 模型入口 | `node_repl` 的 `js` cell 内 bootstrap SDK，模型不直接见 25 个工具 | 25 个 `cmd` 直接暴露给桥的调用方（JS 插件层可再包装） | **有意偏离**：我们不做「每次 cell 重 bootstrap」，改为进程内持久 session |
| 后端宿主 | macOS 原生 `.app`（bundle `dev.zcode.cua-helper`）/ Windows Helper 子进程 + native addon | 单个常驻 `powershell.exe -File cua.ps1` | **有意偏离**（见 9.5） |
| 传输 | 本机 socket / named pipe，JSON 行，`{id,token,method,input,context}` | stdin/stdout NDJSON，`{id,cmd,args}` | **有意偏离**：管道即边界，无 token |
| 鉴权 | 32 字节 hex token + `timingSafeEqual`；另有 identity 模式（socket + pluginAuthority 成对） | 无（父进程管道本身是可信边界） | **有意偏离**，需在文档中显式声明威胁模型 |
| 上限 | 请求 1 MiB / 响应 32 MiB | 无显式上限 | **缺口**：应补 base64 图片与 NDJSON 行上限 |
| 生命周期 | Helper 由 SDK 首次调用懒启动；`stop`→`shutdown`→terminate 两阶段；`kill` 后必须观察到 exit | `shutdown` cmd 后 exit 0；`stop` 幂等 | 语义一致，粒度更细的 ZCode 两阶段终止值得借鉴 |
| 会话隔离 | 每次 cell 全新 Worker，全局绑定与模块缓存都不跨 cell | 常驻进程，frame/state/按住键跨请求保留 | **有意偏离**，但必须把「state_id 失效」做成显式错误（我们已有 `ELEMENT_STALE`） |

### 9.2 方法对照

| ZCode 能力 | 我们的 `cmd` | 差异与理由 |
|---|---|---|
| `request_access` | **无对应** | 我们有 `ping` + `screen_info` 但无权限探针。Windows 无 TCC 等价物；ZCode 的 schema 也硬编码 `platform:"darwin"`。**建议**：新增 `request_access` 返回 `{platform:"win32", available:true, accessibility:"granted"(由 UIA 可用性探测), screenRecording:"granted"\|"unknown"(由截图探测)}`，保持字段名一致以便复用 UI 逻辑 |
| `list_apps` | `list_apps` | 字段名不同：ZCode 用 `bundle_id`/`active`，我们用 `appKey`/`displayName`/`foreground`。**建议**另加 `bundle_id`（Windows 用 exe path 或 AUMID）与 `active` 兼容字段 |
| `list_windows` | `list_windows` | ZCode 的 `bounds` 是 **4 元数组**，我们是对象。**建议**保留对象并在文档标注差异（数组形态对模型更差） |
| `get_app_state` | `get_app_state` | 高度一致：都有 `state_id`、`elements[*].index`、`window`、`focused`。差异：ZCode 有 `changes.{added_count,removed_count}`（界面变化计数）我们**没有** → 值得补；ZCode 有 `focused_element`(number) 我们是 `focused:{elementIndex,name,role}` → 我们信息更多；我们的 `actions` 数组是 ZCode 未暴露的（ZCode 侧无证据） |
| `screenshot` | `screenshot` | ZCode 参数是 `region:[x,y,w,h]`，我们是 `left/top/width/height/max_width/monitor`。ZCode 的 `screenshot_display.{mode,bounds,raster,screen}` **只在 SDK 引导文案里出现**，我们把它显式化成返回字段（`native-protocol.md:108-109`），并额外给出 `frame_id`/`source`/`scale`——**这是我们的增强** |
| `zoom` | `zoom` | ZCode 侧 `scale` 参数**无证据**；我们的 `scale` 1–8 + `clamp` 是自研。ZCode 的 `Region clamped` 文案证明它也有裁剪语义 → 语义同源，命名不同 |
| `open_application` | `open_application` | ZCode 唯一实证参数是 `app.url`（可为文件夹）；我们支持 `name`/`path`/`url`/`args`/`wait_ms`。**兼容**：接受 `app.url` 形态的调用即可 |
| `left_click`/`double_click`/`triple_click`/`right_click`/`middle_click` | `click`（`button` + `clicks:1\|2\|3`） | **有意偏离**：ZCode 拆成 5 个工具名（对模型的 tool-list 更冗长）；我们用 2 个参数覆盖同一语义空间。若要与 ZCode UI 兼容，可在插件层做名字到参数的映射（`left_click`→`{button:"left",clicks:1}` 等） |
| `scroll` | `scroll` | ZCode 侧参数无证据；我们的 `direction`+`amount`（1 格 = `WHEEL_DELTA` 120）是自研且更明确 |
| `left_click_drag` | `drag` | 名字不同，语义应一致（两点拖拽）。ZCode 侧参数无证据 |
| `mouse_move` | `mouse_move` | 一致 |
| `type` | `type` | ZCode 必填 `text`；我们额外支持 `element_index`+`state_id` 先聚焦、`interval_ms`。ZCode 的 `SendInput KEYEVENTF_UNICODE` 逐字符注入是我们的实现选择，ZCode 侧无证据 |
| `set_value` | `set_value` | 语义同源；ZCode 无参数证据。我们额外有 `submit` |
| `select_text` | `select_text` | 同上；ZCode 的 `not_selectable` 错误码（= TextPattern 缺失）与我们 `NOT_SELECTABLE` **完全对应** |
| `key` | `key` | ZCode 用 `key` 或 `text`（单字符）；我们同构，modifier 名集合也覆盖 `cmd/command/meta` |
| `hold_key` | `hold_key` | ZCode 无时长参数证据；我们的 `duration_ms` 1–10000 是自研。ZCode 的 `stop` 释放按住键（`releasedKeys`）与我们 `stop { release_keys:true }` 语义一致 |
| `perform_action` | `perform_action` | ZCode 的 action 取值集**无证据**；我们的 7 值（含 `scroll_into_view`）是自研。ZCode 的 `action_unavailable` 与我们 `ACTION_UNAVAILABLE` 对应 |
| `wait` | `wait` | **单位不同**：ZCode `duration` 是**秒**，我们 `duration_ms` 是**毫秒**。这是最容易踩的兼容坑 → 必须显式记录。另：我们额外支持 `appKey`/`hwnd` 等待后重取状态，ZCode 侧只有「等待」语义 |
| `read_clipboard` / `write_clipboard` | `clipboard_read` / `clipboard_write` | 命名顺序相反（ZCode 动词在后）。**有意偏离**：我们保留自己的命名，文档记录映射。ZCode 的 STA 要求在 Windows 上同样成立（`powershell.exe -STA`） |
| `stop_computer_control` | `stop` | 语义一致（释放按住键 + 结束拖拽）。我们额外有 `shutdown`（进程退出） |
| — | `focus_window` | **我们独有**。ZCode 未见独立切前台工具；它把「非前台窗口先尝试切前台，失败则 `foreground_required`」内建在动作里（错误码 `foreground_required` 佐证）。**建议**：保留 `focus_window` 但在文档注明 ZCode 无对应 |
| — | `screen_info` / `ping` | 我们独有（ZCode 对应物是 `list_apps` 里的 `foreground`/窗口几何） |

### 9.3 坐标语义

* ZCode：`x`/`y` 必须是「返回栅格内部的整数像素」；**明令禁止**把 `screenshot_display.bounds` 或 app/window bounds 当栅格坐标（`tool-contract.ts:48-49`）。
* 我们：`frame_id` + `space:"raster"|"screen"` 把这条隐含约定**显式化并使其可校验**；省略 `frame_id` 视为沿用最近一次 frame，显式传入不一致则 `ELEMENT_STALE`；从未截图就调输入方法且 `space != "screen"` → `NO_FRAME`（`native-protocol.md:56-72`）。
* **判定**：语义同源；我们把 ZCode 的「软警告」升级为「协议级硬约束」。这是**有意的增强**，应在文档中标注为偏离。
* 应用/窗口/UIA 元素的 `bounds` 一律物理像素、不得当栅格坐标 —— 两边一致（`native-protocol.md:71-72`）。

### 9.4 结果与配额

| 项 | ZCode | 我们 | 判定 |
|---|---|---|---|
| 图片内联上限 | 单张 256 KiB、合计 512 KiB、最多 4 张（`result-display.ts:233-235, 288-291`）；官方帧 base64 200 KiB（`frame-contract.js:5`） | 无上限 | **缺口**，必须补 |
| 文本字段上限 | display 文本 32 KiB（`result-display.ts:233`） | 无 | **缺口** |
| 图片/引用原子对 | `image` + 紧随的 `image_ref` 必须是结果前两块 | 无 `image_ref` 概念 | **有意偏离**：我们没有「模型可能看不到图但仍拿到引用」的问题，因为我们把 image 与坐标空间绑定在同一个返回对象里 |
| `action_sent` | 可选；缺失不等于失败（`tool-contract.ts:46-47`） | **强制**：动作方法必须 `action_sent:true`，纯读取**不得**带（`native-protocol.md:285-291`） | **有意收紧**：我们让 `action_sent` 成为可判定字段，比 ZCode 更安全 |
| 错误形态 | `{error, state_id?, index?, target_app?}`（text 内 JSON） | `{ok:false, error:{code,message,details}}` | **有意偏离**：结构化错误优于文本内嵌 JSON |
| 错误码 | 六个 broker 码 + `element_stale` + ... | 18 个（`native-protocol.md:263-283`） | 我们的码是本报告 §1.5 的超集，一一对应关系已在上文注明 |

### 9.5 我们有意保留的偏离（需长期维持）

1. **常驻 PowerShell vs ZCode 的每 cell 新 Worker**。ZCode 用「每次全新内核」换取隔离，代价是模型每次必须抄完整 bootstrap。我们选择常驻进程 + `state_id` 语义来换取性能与更少 token，代价是必须把「状态陈旧」做成显式错误（`ELEMENT_STALE`）——这是我们已经做的。
2. **`action_sent` 由可选变强制**，纯读取禁止携带。
3. **坐标空间显式化**（`space`/`frame_id`）替代 ZCode 的文档级软警告。
4. **`click` 合并 5 个工具名**、`clipboard_*` 命名顺序、`wait` 用毫秒。
5. **不做** SDK bootstrap 范式：我们的插件层可以直接把 25 个方法映射到桥的 `cmd`，不需要 `setupComputerUseRuntime` 那样的「每次重放引导」。
6. **不做** frame integrity / modelContentProtection 体系：我们的图片与坐标在同一返回对象内闭环，不存在「引用到了但图没到」的中间态。

### 9.6 建议补齐的契约（按优先级）

| 优先级 | 项 | 依据 |
|---|---|---|
| P0 | 图片/文本/行大小上限 | §1.6 |
| P0 | `request_access`（Windows 语义） | §6.4、§9.2 |
| P1 | `get_app_state` 的 `changes.{added_count,removed_count}` | §1.2 |
| P1 | `list_apps` 的 `bundle_id` / `active` 兼容字段 | §1.2 |
| P2 | `perform_action` 的 action 取值集与 UIA Pattern 的映射表 | §1.5（`action_unavailable` 的存在证明有映射） |
| P2 | 两阶段终止（shutdown → 等 exit → kill → 等 exit → 报 blocker） | §3.7 |
| P3 | PiP / 操作事件流（`turn-started`/`focus-changed`/…） | §3.6、§4.4 |

---

## 10. 未解之谜（开源版无法确定的细节）

### 10.1 真实 SDK 方法签名

* 只知道引导锚点是 `setupComputerUseRuntime`（`tool-contract.ts:51`），且其后接 `agent.computerUse`（`tool-contract.ts:51`）。
* `setupComputerUseRuntime` 的参数、返回值、`agent.computerUse` 的成员（是 `leftClick()` 还是 `left_click()`？返回 Promise 还是结果对象？）**全部无证据**。
* `node-repl-session.ts:200-202` 只暴露 `nodeRepl.emitStructuredResult` 这一通用通道，SDK 如何调用它、传什么形状，无证据。
* 唯一间接线索：`computer-use-operation-event.ts:17-19` 提到源码形态「会随 node_repl SDK 演进（如改成 `getApp()` + 绑定对象 + `computer.*`）」——说明历史上存在 `getApp()` 这一形态，但当前形态未知。

### 10.2 Helper 原生接口

* native addon 加载器（`loadRealNativeAddon` / `resolvePackagedNativeAddonPath` / `resolveInTreeAddonPath`）全是桩（`broker-server.js:49-58`）。
* `createAxReadOnlyMethods` 返回 `{}`、`ROLE_TO_KIND = {}`（`broker-server.js:60-66`）——**AX 角色到 kind 的映射表整个丢失**。UI 侧只看到 `role` 原始字符串。
* broker RPC 方法名集合未知：`isBrokerMethod()` 恒 `false`、`isReadOnlyBrokerMethod()` 恒 `false`（`broker-server.js:36-42`），`BrokerMethod = string`（`broker.d.ts:56`）。
* Windows 侧控制协议只定义了 `transport_ready` / `ready` / `error` 三种控制消息（`windowsCuaHelperHostSupport.ts:185-188`）；Helper 内部对 UIA 的调用形态、命名管道上的实际 RPC、以及它如何把 `caseId`/`state_id` 编进结果，**无证据**。
* macOS Helper 的 `Info.plist` 内容（除 `LSMinimumSystemVersion 12.0` 外）、`ax_macos.node` 的导出面，**无证据**。

### 10.3 CDN 资产内容

* `docs/computer-use.md` 的全文（含被反复引用为「模型必须原样照抄」的 bootstrap 代码块）不可获得。
* `scripts/computer-use-client.mjs` 的全文（SDK 实现）不可获得。仅知它由 skill root 以 `file://` import（`tool-contract.ts:53-55`）。
* `skills/computer-use/SKILL.md` 的全文不可获得。仅知它的存在与限定名集合被 `computer-use-policy.ts` 用于官方判定，且扫描路径为 `<plugin root>/skills/**`。
* CDN 图标 `https://cdn-zcode.z.ai/zcode/official-plugin/assets/zcode-cua/icon.png`（`official-plugin-definitions.ts:349`）内容不可获得。

### 10.4 25 个工具的完整参数

* 仓库中**不存在** producer 侧的 input JSON Schema。§1 表里标 **[无证据]** 的 10 个工具（`scroll`、`left_click_drag`、`mouse_move`、`set_value`、`select_text`、`perform_action`、`read_clipboard`、`write_clipboard`、`stop_computer_control` 以及 `open_application` 的 url 以外参数）需要自行设计。
* 已知的具体空白：`set_value` 的 value 字段名、`select_text` 的区间表达、`perform_action` 的 action 取值集、`scroll` 的方向/步长、`left_click_drag` 的起止点表达、剪贴板工具的返回字段、`hold_key` 的时长参数、`zoom` 的缩放参数。
* 模型契约只额外定义了 `title`（`mcp/index.ts:39-45, 336-343`），因为它是 ZCode 特意叠加的，不是上游 schema。

### 10.5 其他

* `element_stale` 之外的真实错误码全集。
* `get_app_state` 的 `detail` 参数取值（只有截断标记里的 `detail=compact` 一处线索，`result-content-projection.ts:15`）。
* 界面元素 `actions` 数组在 ZCode 侧的取值集（我们自定义了 8 个；`native-protocol.md:166-167`）。ZCode 只有 Pattern 缺失类错误码可反推。
* `screenshot_display` 的完整字段表：仅 `tool-contract.ts:48` 一处提到 `.bounds`，其余字段（`mode`/`raster`/`screen`）在我们的文档里是**自研**的。
* `zcode.cua/official-frame-integrity-v1` 的值结构与 `image_ref` 的凭证格式（`parseOfficialCuaImageRef` 返回 `{authority}`，但解析逻辑是桩 `frame-contract.js:15-17`）。
* Windows 最低支持版本、Windows 上 `appKey` 的 AUMID 解析细节（`windows-aumid:` 前缀只在 `tool-result-metadata.ts:150` 的类型注释里出现）。
* `CUA_APP_ASSOCIATIONS_MAX_META_BYTES = 16 * 1024` 之外，`app-associations` 的完整 schema（`items` 模式的元素形状）无证据。
* PiP 会话 socket 的名字/路径：`PipSessionClientOptions.socketPath` 是可传的，但生产值来自 `CuaPipPresentationCredentials.socketPath`，而 `resolveCredentials` 的实现不在仓库（`cuaPipSessionService.ts:44-49`）。
* `reapOrphanedHelpers` 的判定规则（孤儿 Helper 如何识别）无证据。

---

## 附：本报告用到的证据文件索引

```
packages/zcode-cua/{index,broker,broker-server,broker-ports,broker-socket-path,
  broker-helper-constants,broker-helper-health,frame-contract,host-display-contract,
  pip-session,pip-session-node,request-access-contract}.{js,d.ts}
packages/ui/src/ToolCallBlocks/renderers/cua{,-group}.tsx
packages/ui/src/ToolCallBlocks/renderers/cua{ActionDetail,AccessDetails,Details,
  ErrorDetails,ListDetails,ResultState,ScreenshotDetails,SummaryMessages}.ts
packages/ui/src/ToolCallBlocks/renderers/CuaScreenshotSection.tsx
packages/ui/src/ToolCallBlocks/toolResultDisplay.ts
packages/ui/src/lib/cuaPermissionAction.ts
packages/ui/src/v4/conversationCuaGroups.ts
packages/ui/src/settings/{computerUseAvailability.ts,ComputerUseSection.tsx,PluginsSection.tsx}
packages/ui/src/cua-permission/CuaPermissionObservationAttachment.tsx
packages/ui/src/i18n/locales/{en-US.ts,zh-CN.ts}
packages/shared/src/{mcp.ts,runtimeEnv.ts,cuaAccessibilitySettings.ts,platform.ts,
  plugin-marketplaces.ts,remote-workspace-identity.ts}
packages/shared/src/zcode-protocol/index.ts
packages/shared/src/zcode-protocol-v4/{cuaPermission.ts,rows.ts}
packages/services/src/cua-permission-broker/*
packages/desktop/src/main/{cuaOsSupport.ts,cuaAccessibilitySettings.ts,desktopCommandHandlers.ts}
apps/zcode-cli/packages/node-repl-host/src/{tool-contract.ts,cua-bridge.ts,cua-broker.ts,
  server.ts,result.ts,browser-bridge.ts}
apps/zcode-cli/packages/node-repl-host/README.md
apps/zcode-cli/packages/core/src/mcp/{index.ts,image-normalization.ts}
apps/zcode-cli/packages/core/src/repl/node-repl-session.ts
apps/zcode-cli/packages/core/src/tool/executor/{result-display.ts,result-content-projection.ts,
  permission-suggestions.ts,permission-capability.ts}
apps/zcode-cli/packages/core/src/permission/service.ts
apps/zcode-cli/packages/core/src/subagent/{computer-use-policy.ts,borrowed-mcp-port.ts}
apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts
apps/zcode-cli/packages/contracts/src/tools/tool-result-metadata.ts
apps/zcode-cli/packages/contracts/src/interfaces/{mcp.port.ts,permission.port.ts}
apps/zcode-cli/packages/adapters/src/config/schema.ts
apps/zcode-cli/packages/adapters/src/model/tool-result-media-projection.ts
apps/zcode-cli/packages/bootstrap/src/{mcp-config.ts,plugins.ts,permission-options.ts}
apps/zcode-cli/packages/bootstrap/src/app/{official-plugin-definitions.ts,bundled-plugins.ts,
  plugin-runtime-features.ts,runtime-config.ts}
apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts
apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cua-app-snapshot.ts
apps/zcode-cli/packages/cli/src/plugin-host-command.ts
apps/zcode-cli/packages/tui/src/{app-approval.ts,app-approval-panel.tsx}
```
