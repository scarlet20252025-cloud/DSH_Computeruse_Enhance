# 逆向复盘：从「不可用占位包」到能用的 DSH 插件

本文记录这次逆向的**过程、判断依据、有意偏离与验证强度**。
逐条证据（432 处 `path:line`）在 [zcode-cua-contract.md](zcode-cua-contract.md)，
冻结的层间接口在 [native-protocol.md](native-protocol.md)。

---

## 1. 起点：源仓库里没有实现

ZCode 的开源版（本地克隆）把 Computer Use 做成了**占位**：

```js
// packages/zcode-cua/index.js
const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";
export function createComputerUseRuntime(_options) {
  …        // 所有方法都返回不可用错误
}
```

同目录的 `broker-server.js` 更直白：`createAxReadOnlyMethods` 返回 `{}`、
`ROLE_TO_KIND = {}`、`isBrokerMethod()` 恒 `false`——**接口壳留着，实现与数据表被挖空了**。

三个必需资产（`docs/computer-use.md`、`scripts/computer-use-client.mjs`、
`skills/computer-use/SKILL.md`）在仓库里根本不存在，但被
`official-plugin-definitions.ts:74-78` 列为 seed 必需项；`prepare-agent-node-bundle.mjs:77`
说明它们归非开源的 `@zcode/zcode-cua-plugin`。

`git log` 只有三个提交（`Initial commit` → `feat: open source` → `feat: update v3.14.3`），
`git log --all -- packages/zcode-cua` 只命中「open source」那一次——**历史里也没有**。
所以这次没有「翻旧提交找回实现」这条路，只能从契约重建。

---

## 2. 重建的支点：契约比实现活得更久

| 我们需要的 | 仓库里的来源 |
|---|---|
| 25 个动作叫什么 | `packages/ui/src/ToolCallBlocks/renderers/cuaSummaryMessages.ts` |
| 每个动作的参数长什么样 | 同上目录的 `cuaActionDetail.ts` / `cua.tsx` / `cuaListDetails.tsx` |
| 模型面的硬纪律 | `node-repl-host/src/tool-contract.ts` 的 `JS_TOOL_DESCRIPTION`（1857 字，逐字） |
| `state_id` / 元素寻址 | 同上的「`state.state_id` 配 `state.elements[*].index`，禁止从 text 正则」 |
| 坐标语义 | 同上的「x/y 必须是返回栅格的整数像素」「不得用 `screenshot_display.bounds` 当栅格坐标」 |
| 结果字段与配额 | `core/src/tool/executor/result-display.ts`（`state_id`、`action_sent`、内联图 256 KiB/512 KiB/4 张） |
| 稳定错误码 | `packages/zcode-cua/broker.js` 的 `not_selectable`/`not_settable`/`element_unavailable`/`action_unavailable`/`foreground_required` |
| 传输协议 | `node-repl-host/src/cua-bridge.ts` + `cua-broker.ts`（JSON 行、`id/token/method/input/context`、32 MiB 上限、1 MiB 请求上限） |
| 元数据键 | `host-display-contract.js` 的 `zcode.cua/app-associations-v1` |
| 平台矩阵与产品决策 | `official-plugin-definitions.ts:326-363`、i18n 的 `settings.computerUse.unsupported.*` |

**最关键的一条发现**（子代理取证得出，我复核过）：在当前版本里，那 25 个动作
**不是**模型可见的 MCP 工具，而是 `node_repl` 的**私有 capability 方法名**——
模型只看到 `js` 一个工具，在 cell 里 bootstrap SDK 再调 `agent.computerUse.*`。
`cua-bridge.ts:22-27` 的注释原文：「私有 capability 请求；这里不是 MCP tool 调用，
MCP 只承载外层 node_repl」。

这解释了 `mcp__computer_use__*` 那套命名的来历（另一条历史路径，
`core/src/mcp/index.ts:46-47`），也决定了我们的落地形态。

---

## 3. 我们的落地选择（以及为什么）

DSH 没有等价的 JS kernel 桥（它的 `node_repl` 类比物是 PTC `run_code`，
但那不是我们要重建的对象），所以：

| 决策 | 理由 |
|---|---|
| **把 25 个动作注册成 DSH 工具** | 模型直接函数调用，不需要 bootstrap；同时保留 `tools:"single"` 模式（一个 `computer_use` + `action`）以贴近上游「capability 方法」的调用姿势 |
| **不用 `defineTool`，直接 `ctx.tools.register(原始 JSON Schema)`** | `@deepseek-ai/dsh-tools` 在插件侧**不可解析**（实测 `createRequire(profile/index.js).resolve()` 失败）；原始 JSON Schema 正是 MCP 工具注册进 DSH 的方式，属官方扩展点 |
| **自研参数校验** | 既然绕过了 `defineTool` 的校验包装，就自己补上：语义与**文案**逐字对齐官方 `validateJsonSchemaValue`（`"<path>" must be a string`、`missing required property "<path>"`…），并在测试里用官方实现跑同一批用例做等价性对比 |
| **后端用长驻 `powershell.exe` 5.1** | Windows 上 `System.Drawing` + `UIAutomationClient` 在 5.1 宿主开箱可用；不需要随包发二进制，也不受 DSH 内部 koffi 影响 |
| **`SetProcessDPIAware()` 必调** | 实测 150% 缩放下不调用：截图 1707x1067 vs UIA/窗口坐标 2560x1600，**两套坐标空间**，整个坐标映射会错 |
| **超时即换进程** | 协议串行；超时后无法判断迟到响应归属，猜错比报错危险得多 |
| **技能自装到 `<dsh home>/skills/`** | 该目录是官方扫描根（rank 400）且被 watcher 监视，无需重启即生效；`customSkillDirs` 要绝对路径，写进随包 patch 在别人机器上会指空 |

### 有意保留的偏离

1. `request_access` 的平台语义。上游 `CuaRequestAccessStatus.platform` 硬编码 `"darwin"`，
   字段是 `grantOwner`/`accessibility`/`screenRecording`；Windows 没有这套授权模型。
   我们返回同构但平台正确的环境自述（后端、DPI 感知、显示器数、截图/输入可用性），
   并在文档里标明这是**我们定义的部分**（仓库无证据）。
2. `wait` 的单位。上游是秒，我们的协议是毫秒；工具层两者都收（`duration` / `duration_ms`），
   这是刻意的兼容层。
3. `changes` 字段。上游 UI 显示「{added} added, {removed} removed」，但 producer 侧的
   完整结构不在仓库里；我们按同一语义自行计算（元素身份 = 角色|名字|值|AutomationId 的集合差）。
4. 没有 PiP 会话、操作胶囊、内联截图渲染那套 UI；截图以原生图像块 + 落盘路径替代。
   但**保留了上游的可见性保证**：Computer Use 一动，屏幕顶部居中就出现「DSH 正在操作电脑」浮层
   （点击穿透、不抢焦点、不进截图、30s 无活动兜底隐藏、`stop_computer_control` 立即收起）。
   上游是 Electron `BrowserWindow`，我们用长驻 WPF 进程实现同样三条硬性质
   （`WS_EX_TRANSPARENT` / `WS_EX_NOACTIVATE`+`ShowActivated=false` /
   `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`），协议见
   [indicator-protocol.md](indicator-protocol.md)。

---

## 4. 验证强度（这是本文最该看的一节）

六层，从「协议对不对」到「真实 DSH 里模型能不能自己操作」：

| 层 | 命令 | 规模 | 覆盖 |
|---|---|---|---|
| 单元 | `npm test` | **95 通过 / 0 失败** | schema 子集与官方逐字等价（20 例对照）、bridge 协议边界（就绪/串行/超时换进程/重启上限/关停）、25 个工具的参数映射与信封、**全部 25 个工具的返回值在「后端只回最小字段」时仍是无损 JSON**、插件注册与技能自装、技能 frontmatter 用**官方解析器**验证、指示器控制器、**访问闸门矩阵（模式 × 调用方 × 子代理开关）**、客户端插件契约（槽位注册与逐字命令） |
| 原生后端 | `npm run smoke` | **147 通过 / 0 失败**（另开 `CUA_SMOKE_INPUT=1` 为 **170/170**） | 24 个协议方法、错误码、stdout 纯净性（无 CR、无非 JSON 行、UTF-8 字节级核验）、UWP 应用解析、剪贴板往返 |
| 端到端 | `npm run e2e` | **74 通过 / 0 失败** | **本插件完整链路**在真机上：`index.js` → `tools.js` → `bridge.js` → `cua.ps1` → 真实桌面。键盘注入后 UIA 回读文本相等、元素点击让真窗口标题改变、栅格坐标点击同样改变标题、剪贴板链路、拖拽/滚轮/长按/perform_action、图像块只在该路由支持图像时附加、**指示器随动作亮起并在交还控制权后收起**、**访问闸门（禁用期间窗口标题不变、被拒调用不点亮指示器、子代理被单独拦住、放开后真的能点）**、卸载后不遗留后端/指示器进程。另含**前置体检**：桌面被全屏应用占用时明确报「环境不适合」而不是给误导性失败 |
| 操作指示器 | `npm run indicator:smoke` | **54 通过 / 0 失败** | 点击穿透（`WindowFromPoint(卡片中心)` 不是浮窗）、不抢焦点（`GetForegroundWindow` 从不等于浮窗）、**不进截图**（与背景无关的 `PrintWindow` 判据 + 逐像素旁证）、30s 兜底隐藏、窗口复用、stdout 纯净度 |
| 真实注册表 | `npm run verify:registry` | **10 通过 / 0 失败** | 在**真实 cordis + 真实 `dsh-tools` ToolRuntime + SystemPrompt** 里加载插件：投影出 25 个 schema、无 `execute`/`render` 泄漏、按名字可解析 |
| 真实 DSH | `npm run verify:in-dsh` | **14 通过 / 0 失败** | 在**真实 DSH 的一次性运行**（`dsh --profile cu-verify --json`）里让模型自己走完整链路：加载技能 → `get_app_state` → 按 `element_index + state_id` `left_click` → `wait` → 复查 → `stop_computer_control`。**结论不采信模型汇报**：脚本用原生后端独立再读一次窗口标题，确认它真的变成了 `CLICKED:1` |
| 真实 DSH·访问闸门 | `--access-mode=off` / `=ask` | **10 / 11 通过 / 0 失败** | **受控对照**：任务与上面完全相同，唯一差别是这一条设置。禁用场景：模型尝试调用 → 被拒（`CUA_DISABLED`，说明里含「桌面没有任何变化」）→ 模型停手 → **夹具标题一字未变**；询问场景在 headless 下无审批方可答 → 同样 fail-closed。这条同时**反证了调用方分类**：auto 场景下默认 `allowSubagents=false`，主 Agent 的调用被放行，说明真实的 `exec.agent.session.header` 判定正确 |
| 客户端半 | 临时 web 实例 | 通过 | 另起一个临时 DSH web 实例（独立端口，用完即删）：启动清单里出现 `{"id":"dsh-computer-use","url":"plugins/??dsh-computer-use/client.js&rev=…"}`，bundle 路由返回 **200 / 9016 字节**且内容是本插件代码；界面上按钮 `🖱 电脑操控：全自动` 与菜单（子代理开关 + 三模式）正常渲染；点「禁用」后 `<dsh home>/plugins/dsh-computer-use/config.json` 真的被写成 `"accessMode": "off"`，点回「全自动」又写回 `auto` |

端到端与真机验证都用**我们自己的 WPF 夹具窗口**（`tools/e2e-fixture.ps1`）作为目标：
零用户数据风险，且它的可观察状态是确定的（文本框 value 可回读、按钮点击改窗口标题）。

### 这套验证抓到的四个真 bug（都是单测测不到的）

1. **`URL` 直接交给 spawn**：`config.nativeScriptPath()` 返回 `URL`，bridge 直接塞进 spawn 参数，
   PowerShell 收到 `file:///E:/…` 后以「不支持给定路径的格式」立刻退出。
   单测因为用字符串路径而全绿。→ 修 `bridge.js`（`fileURLToPath`）+ 加回归测试。
2. **`elements[].value` 恒为空**：`Convert-Str` 对任何 `System.__ComObject` 一律返回空串，
   而 UIA 缓存**恰恰会把合法字符串值包成 `__ComObject`**——读到了却被丢掉，
   模型的读值通道整条断掉（症状：`set_value` 明明成功、`select_text` 也能报出正确长度，
   但 `get_app_state` 的 `value` 永远是空）。→ 改成「取到字符串再判断它是不是类型名」，
   并给 `Read-ElementValue` 加分层兜底（缓存 pattern → 缓存属性 → 未缓存 → TextPattern）。
3. **层间协议不一致**：`docs/native-protocol.md` §4.10 规定 drag 用 `from`/`to` 对象，
   而 `tools.js` 发的是扁平 `from_x/from_y/to_x/to_y`，后端直接 `BAD_REQUEST`。
   → 工具层负责翻译（模型侧仍可写扁平形式）。
4. **返回值不是无损 JSON**（最凶的一个，只有在真实 DSH 里才暴露）：
   点击结果里 `app`/`state_id` 在坐标路径上是 `undefined`，DSH 判定整次调用失败——

   ```
   Error: tool "left_click" returned invalid output: value is not lossless JSON
   ```

   **而桌面已经被真的点过了**（独立核验：窗口标题已变成 `CLICKED:1`）。
   这类「副作用成功、结果被拒」的失败最容易被误读成「工具不好用」。
   → 在注册收口处统一清洗（`toLosslessJson`，丢弃 `undefined` 键），
   并把守卫抽成可导出的 `createGuardedExecute`，让单测走**与生产完全相同的路径**：
   现在全部 25 个工具都会被官方 `validateJsonSchemaValue` 判一次无损性。

除此之外还修了两处一致性问题：`bridge.js` 的 `maxRestarts` 从未计数（重启上限形同虚设）、
`single` 模式的定义把 schema 直接放在 `output` 上而不是 `output.schema`（真实注册表会拒）——
后者是**官方 `assertSupportedJsonSchema` 抓出来的**，属于「用真码验自己」的直接收益。

### 两次「验证方法本身在骗人」

**一、自匹配**。追查「卸载后是否遗留后端进程」时，第一版检测把特征串 `*native\cua.ps1*`
写进了 PowerShell 查询语句——于是**运行这条查询的 powershell.exe 自己**的命令行里也含这个字样，
查询把自己匹配成了「遗留后端」。症状是：反复出现杀不干净的进程，清理时甚至误杀了工具进程本身。
真相是**根本没有进程泄漏**。教训不是「多测几次」，而是：**判定条件不能出现在被判定对象的
观测面上**。修法：查询里不带任何特征串，取回全量命令行后在 Node 侧过滤，并按父进程 pid
只认自己派生的进程。现在的 e2e 把「卸载后不遗留」变成一条断言（`dispose 后不遗留原生后端进程`），
`tools/kill-backends.mjs` 用同样的正确姿势做独立复核。

**二、多行参数被 shell 截断，看起来像「模型跑偏」**。真机验证脚本第一版用
`spawn('pnpm', ['dsh', ..., task], { shell: true })` 把任务拼进命令行——cmd.exe 在
**第一个换行处就截断**，模型只收到「请严格按下面的步骤执行」+ 空列表，于是它**正确地**
拒绝执行并反问步骤。当时的日志里是模型在 glob/grep/read 乱逛、点了三次、还输入了键盘，
很容易被误判成「模型不听话」；实际是参数传递 bug。

修法：不经 shell，直接调 CLI 入口，任务从 **stdin** 原样送入（headless 文档规定的 `-` 标记）。
教训：**当行为看起来像「对方不配合」时，先验证对方收到的输入和你以为的输入是否一致。**

---

## 5. 没做到的（诚实清单）

* **真实 SDK 的方法签名不可得**。只知道锚点 `setupComputerUseRuntime` 后接
  `agent.computerUse`；成员命名（`leftClick()` 还是 `left_click()`）、返回形态、
  参数顺序全部无证据。我们的 25 个工具名取自 UI 常量表，语义按 UI 可观察行为重建。
* **10 个工具的完整参数无从确定**。producer 侧 input JSON Schema 不在仓库；
  `scroll`/`left_click_drag`/`mouse_move`/`set_value`/`select_text`/`perform_action`/
  两个剪贴板/`stop_computer_control` 以及 `open_application` 的 url 之外参数，
  我们在契约文档里一律标 **[无证据]**，实现里取了合理形态并接受多种同义写法。
* **Windows Helper 的原生 RPC 全丢**：`isBrokerMethod()` 恒 `false`（方法名集合未知）、
  `ROLE_TO_KIND = {}`（AX 角色→kind 映射表整个没了）、Windows 侧只有控制面三消息。
* **权限模型没有对齐**：上游用保留规则键 `zcode:permission-capability:official_cua`
  加 capability group 双重校验做项目级授权；DSH 的权限模型不同，
  本插件在 `enabled:true` 时全量暴露工具，未实现项目级授权。
* **GUI 会话（`desktop` profile）本身在重启后尚未确认**。已经做到的是：
  ① 插件装进了 `desktop` profile，原有插件完好（manifest 差异只有我加的两行）；
  ② 用备份复刻的 `desktop` 组合跑 `--dump-config` 成功（唯一警告 `experimental-auto-review`
     在无插件基线下同样出现，属既有问题）；
  ③ 在独立的 `cu-verify`（出厂 headless 模板）里让真实模型完整跑通了一次点击并被独立核验。
  还差「重启 DSH 后在对话框里用一次」——那一步只能由用户触发。

---

## 6. 复现路径

```powershell
cd <本仓库目录>

node tools/ref-extract-validator.mjs   # 从 app.asar 提取官方实现到 .ref/（开发期依赖）
npm test                               # 64：单元 + 官方等价性交叉验证（含无损 JSON 闸门）
npm run smoke                          # 147：原生后端协议（真机）
npm run e2e                            # 66：完整链路端到端（真机，注入到自家夹具窗口）
npm run verify:registry                # 10：真实 cordis + 真实工具注册表
npm run verify:in-dsh                  # 14：真实 DSH 里让模型自己点一次按钮（profile=cu-verify）
npm run indicator:smoke                # 54：操作指示器三条硬性质（真机）
node tools/install-plugin.mjs          # 预览安装改动（默认 dry-run）
```
