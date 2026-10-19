# dsh-computer-use 交接文档

> 读者：接手本仓库的下一个 AI（或人）。
> 目标：**十分钟内知道现状、知道改哪里、知道怎么验证，并且不重复已经踩过的坑。**
> 撰写时间：2026-10-20（实测快照，不是设计稿）。
>
> **关于路径**：文中出现的 `E:\dsh-cua-verify` 是撰写时的工作副本目录，
> `%USERPROFILE%` 是撰写时的用户目录。换一台机器时把这两处替换成你自己的即可，
> 其余内容（行号、数字、结论）与路径无关。

---

## 0. 一句话现状

一个能在 Windows 上真正操控桌面的 DSH 插件，已经装进用户 profile、**25 个工具全部实现并通过真机验证**，性能经四轮优化后 get_app_state 从 1432ms 降到约 250ms（400 元素档）；**改代码后需要重启 DSH 才生效**。

---

## 1. 这是什么（30 秒背景）

- 仓库：本仓库（DSH Computer Use Enhance），MIT，基线是上游 `JHyugou/dsh-computer-use`，在其之上做了性能与契约加固（见 README §0）。
- 定位：把 ZCode 的 computer use 能力**重建成 DSH 插件**。不是包装别人的 API，是 25 个工具一个一个对着 DSH 官方工具契约重建的（契约来自 `E:\DSH\resources\app.asar` 里的官方内核，`docs/zcode-cua-contract.md` 记录了逆向过程）。
- 技术栈：DSH 插件（ESM）+ 长驻 `powershell.exe` 原生后端（UI Automation 读界面、SendInput 注入键鼠、GDI 截图）+ 一个 C# 树遍历快路径。
- 数据面：25 个 DSH 工具名（与上游同名）→ 24 个原生命令（`click` 对应 DSH 的 `left_click`）。

---

## 2. 当前状态（事实表）

| 项目 | 状态 | 证据 |
|---|---|---|
| 单元测试 | 102 tests / 102 pass / 0 fail / 0 skipped | `node --test test/*.test.mjs` |
| 原生协议冒烟 | PASS 147 / FAIL 0 | `node tools/native-smoke.mjs` |
| 端到端（真实桌面） | PASS 74 / FAIL 0 | `node tools/e2e.mjs` |
| 注册表投影 | PASS 10 / FAIL 0（25 个工具名与上游集合完全一致） | `node tools/verify-real-registry.mjs` |
| 指示器 | SMOKE PASS（含点击穿透、截图排除、脉冲动画） | `node tools/indicator-smoke.mjs` |
| 已装进 profile | 是，经 junction | 见 §3 |
| 重启 DSH 后生效 | **是，当前需要重启** | 内核在启动时读 bundle |

---

## 3. 环境事实（**不要重新探测**，这些已经实测过）

```
node               D:\nodejs\node.exe  v24.21.0
powershell.exe     5.1.26100.4768   <-- 后端宿主，故意不用 pwsh 7，理由见 §7.1
pwsh.exe           7.6.5            <-- 仅用于跑脚本，不是后端宿主
插件源目录         E:\dsh-cua-verify
生效方式           junction:
  %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-computer-use
    -> E:\dsh-cua-verify
profile manifest   %USERPROFILE%\.dsh\profiles\desktop\package.json
  dependencies     14 项，含 "dsh-computer-use": "link:E:/dsh-cua-verify"
  dsh.profile.bundles 16 项，含 "dsh-computer-use"
安装前备份         %USERPROFILE%\.dsh\profiles\desktop-backup-20261019
插件数据目录       %USERPROFILE%\.dsh\plugins\dsh-computer-use\
  config.json      【不存在】= 用户从未改过设置，全部跑默认值
  frames\          最近 4 个 jpg 截图帧
技能已装           %USERPROFILE%\.dsh\skills\computer-use
DSH 进程           运行中（GUI）
```

两个必须知道的坑：

1. **`node_modules\dsh-computer-use` 是 junction，不是拷贝。** 改 `E:\dsh-cua-verify` 里的文件就等于改已装插件，不用重装。
2. **`npm prefix -g` 在本机被污染**，返回字面量 `<cwd>\${APPDATA}\npm`。任何依赖 npm 全局路径的判断都不可信。

---

## 4. 架构与代码地图

### 4.1 四层，从外到内

```
DSH 内核
  |  注册 25 个工具 + /computer-use 命令
  v
src/index.js        apply() / enforceAccess() 访问闸门
  |  参数校验 + 权限决策（fail-closed）
  v
src/tools.js        createToolDefinitions() 25 个工具定义 + runHandler
  |  NDJSON 一行一个请求
  v
src/bridge.js       NativeBridge：长驻子进程 + 串行队列 + 超时 kill 重启
  |  stdin/stdout，{id,cmd,args} -> {id,ok,data|error}
  v
src/native/cua.ps1  24 个原生命令；UIA / SendInput / GDI
  |  Add-Type 编译加载
  v
src/native/cua-tree.cs   树遍历快路径（唯一用 C# 的地方）
```

### 4.2 文件清单（改之前先看尺寸，判断影响面）

| 文件 | 字节 | 行 | 职责 |
|---|---|---|---|
| `src/native/cua.ps1` | 133381 | 3317 | **主战场**。24 个命令、UIA 封装、截图、白名单 |
| `src/native/cua-tree.cs` | 11208 | 266 | 树遍历快路径。热路径，改动要极其小心 |
| `src/native/indicator.ps1` | 43407 | 1121 | 屏幕指示器（独立进程，与主后端无关） |
| `src/tools.js` | 47460 | 1133 | 25 个工具定义、参数映射、截图预算降级 |
| `src/index.js` | 22273 | 518 | 插件入口、访问闸门、命令注册 |
| `src/bridge.js` | 15294 | 438 | 子进程生命周期 + 请求队列 |
| `src/format.js` | 14083 | 282 | 工具返回值格式化（给模型看的文本） |
| `src/access.js` | 11199 | 252 | 调用方分类（user/agent/subagent）与决策 |
| `src/indicator.js` | 10675 | 312 | 指示器控制 |
| `src/schema.js` | 10279 | 266 | 工具参数 schema |
| `src/config.js` | 9702 | 214 | 21 个配置键 + 落盘 |
| `lib/client.js` | 10480 | 264 | 客户端 UI（下拉菜单、开关） |
| `skills/computer-use/SKILL.md` | 11440 | 164 | 教模型怎么用这些工具 |
| `docs/native-protocol.md` | 15744 | 314 | **原生协议规范，改协议必须同步改这里** |
| `README.md` | 28976 | 459 | 上游文档 + 本项目改动 |
| `VERIFY-REPORT.md` | 32780 | 447 | 验证报告，13 节，含全部实测数据与踩坑 |
| `HANDOVER.md` | 24302 | 414 | 本文档 |
| `tools/bench.mjs` | 6515 | 192 | 性能基准 |
| `tools/call.mjs` | 7664 | 221 | 单次调用（排查用） |

### 4.3 `src/native/cua.ps1` 关键行号

| 行 | 内容 |
|---|---|
| 418-422 | 五个 `Add-Type -AssemblyName`（顺序有讲究，见 §7.5） |
| 455/463/465 | `$script:treeApi` 加载器（找不到 cua-tree.cs 就回退 PS 实现） |
| 506 | `Fail`（抛结构化错误） |
| 522 | `Send-Object`（写一行 JSON 到 stdout） |
| 619 | `$script:argWhitelist = @{`（**24 个命令各自允许的参数名**） |
| 646 | `Assert-Args`（未知参数直接 BAD_REQUEST） |
| 858 | `Intersect-Rect`（截图/缩放裁剪） |
| 885 | `Get-ProcessInfo` |
| 907 | `Get-ProcessTable`（一次拿 413 个进程，12ms） |
| 989 | `Get-AppKeyForWindow` |
| 1092 | `Resolve-Target`（appKey / hwnd / title / window_index → 窗口） |
| 1213 | `Get-CachedValue` |
| 1221 | `Get-ElementSnapshot`（单元素属性 + actions） |
| 1430 | `Convert-NodeToSnap`（C# 节点 → 老字段名） |
| 1455 | `Build-ElementTreeCSharp` |
| 1478 | `Build-ElementTree`（PS 兜底，与 C# 行为必须保持一致） |
| 1627 | `Invoke-AppState` |
| 1864 | `Resolve-Frame`（帧归属校验） |
| 2192 | `Invoke-Cmd`（命令分发入口） |
| 3194 | `Initialize-BackendCaches`（预热函数本体） |
| 3220 / 3231 / 3236 | `$ready` → `Send-Object $ready` → `Initialize-BackendCaches`（**这三步的顺序不能改**，预热必须在 ready 之后，否则启动被拖长 0.8s） |

### 4.4 `src/native/cua-tree.cs` 关键行号

| 行 | 内容 |
|---|---|
| 29 | `Props`（9 个 AutomationProperty 缓存） |
| 43 | `AddDefault`（CacheRequest：9 属性 + 9 pattern，TreeScope=Element） |
| 57 | `ActionsOf`（与 PS 版 `Get-ElementActions` 同序同义） |
| 83 | `ReadValue` |
| 118 | `SetStat`（**带越界检查**，见 §7.6） |
| 121 | `public static CuaNode[] Walk(root, maxElements, maxDepth, budgetMs, int[] stats)` |
| 126 | `cache.Push()` |
| 203-205 | Document 跳过逻辑（性能优化的核心，见 §5.2） |

`stats` 是 8 个 int：`[0]` truncated、`[1]` walkMs、`[2]` focusedIndex、`[3]` error flag、`[4]` findAllMs、`[5]` snapshotMs、`[6]` actionsMs、`[7]` offscreenFindAllMs。

### 4.5 JS 关键函数

| 文件:行 | 函数 |
|---|---|
| `src/tools.js:151` | `appSelectorToArgs`（appKey/hwnd/title → 原生参数） |
| `src/tools.js:230` | `createToolDefinitions`（25 个工具） |
| `src/tools.js:999` | `runHandler`（统一返回格式化） |
| `src/tools.js:1021` | `resolveWindowRegion`（**回传 `target_hwnd`**，帧归属校验靠它） |
| `src/tools.js:1064` | `finishImageResult` |
| `src/tools.js:1092` | `captureWithinBudget`（超预算自动降级 jpeg/缩放） |
| `src/index.js:67` | `createGuardedExecute` |
| `src/index.js:97` | `enforceAccess`（fail-closed 闸门） |
| `src/index.js:140` | `apply` |
| `src/index.js:441` | `registerAccessCommand`（/computer-use） |
| `src/bridge.js:113` | `ensureStarted` |
| `src/bridge.js:317` | `call` |
| `src/bridge.js:379` | `probe` |
| `src/access.js:45` | `classifyCaller` |
| `src/access.js:75` | `decideAccess` |
| `src/access.js:184` | `parseCommandArguments` |

### 4.6 协议一句话

stdin/stdout 各一行一个 JSON：`{id, cmd, args}` → `{id, ok:true, data}` 或 `{id, ok:false, error:{code, message, details}}`。

**完整规范在 `docs/native-protocol.md`，改协议必须同步它。**

---

## 5. 性能：现状和已经证明过的结论

### 5.1 当前数字（Firefox 前台 1920x1080，`npm run bench`）

| 操作 | 耗时 |
|---|---|
| ready（进程冷启动） | 2469~2516 ms |
| ping（暖） | 1~2 ms |
| 第一次 get_app_state 120/8 | 349~425 ms |
| 之后 120/8 | 188~225 ms |
| 25/8 | 62~76 ms |
| 100/8 | 116~122 ms |
| 200/16 | 179~216 ms |
| 400/16 | 250~281 ms |
| list_windows(all) | 23~27 ms |
| list_apps | 20~22 ms |
| screenshot jpeg q60 | 92~171 ms（负载敏感） |
| zoom 600x300@2x jpeg | 35~98 ms（负载敏感） |

数字取多次运行的最小值~最大值；截图类受系统负载影响明显（同一命令 92ms 与 171ms 都出现过），**判断退化要看元素树的耗时，不要看截图**。

优化前的基线（做对比用）：400/16 = 1432ms、200/16 = 895ms、100/8 = 540ms、25/8 = 374ms、1/1 = 297ms、list_windows = 309ms、list_apps = 171ms。

### 5.2 五个真正有效的优化（按收益排序，都已落地）

1. **跳过离屏 Document 子树**（cua-tree.cs:203-205）。深度直方图显示 95% 的离屏 FindAll 落在 depth>=4，那里是菜单弹层和后台标签页的 Document。400 元素预算下 438→272ms，而且 onscreen 元素反而更多（66→142）。
   判定用的是 `sawOnscreenDoc`（"前面已经有可见文档了才跳过离屏 Document"），**不是**"这个 Document 离屏就跳"。后者会在窗口最小化时把整页正文丢掉（400→139 元素）。
2. **C# 下沉树遍历**。BFS + 属性缓存从 PowerShell 循环搬进 C#，400 元素 700~1000ms → 280~430ms。C# 与 PS 输出逐字段等价（Notepad 37 元素，mismatched=0）。
3. **进程表缓存**。原来每个 pid 一次 `Get-Process -Id`（72ms）+ VersionInfo（38ms）；改成一次 `[Process]::GetProcesses()`（12ms）建表 + 30s TTL。list_apps 171→20ms，list_windows 309→24ms。
4. **离屏元素不探 pattern**。`Get-ElementSnapshot` 里 offscreen 直接 `actions = @()`，A/B 实测 1.37x。
5. **预热**。`ready` 之后立刻 `Get-ProcessTable` + `ListWindows` + 前台 `FromHandle` + 一次小树遍历。第一次 get_app_state 932→346ms。预热自身 478ms，与宿主装技能/模型思考并行，不占用户时间。

### 5.3 十个试过但**不要重试**的方案（附理由）

| 方案 | 实测 | 为什么否掉 |
|---|---|---|
| 离屏子树全局截断（depth 3/4/5） | 400 预算 56~72ms | onscreen 只剩 66、Hyperlink=0，正文全丢 |
| 跳过离屏 Menu 子树 | 234~295ms | 比只跳 Document 更慢，且 menuItems 归零 |
| SkipLeafSet（跳过 Text/Image/Hyperlink 等叶子） | 166~204ms，省 10~30ms | WindowsTerminal 丢 5 个 ScrollBar/Button（可操作元素） |
| `CachePatterns=false` | 无差异 | actions 早已降到 1~7ms，pattern 缓存不是瓶颈 |
| 只用 ControlViewCondition | 省 10~20ms | 不值得增加分支 |
| `TreeScope::Subtree` 一次性缓存 | fromHandle 439ms + total 3106ms | 比逐层 Children 慢 10 倍 |
| `CachedChildren` | 返回 0 或抛 SafeHandle null | 不可用 |
| `ForEach-Object -Parallel` / `Parallel.For` | seq 52ms → par 300ms / par8 70ms | PowerShell 并行要序列化 AutomationElement，慢 6 倍；C# 并行只快 31% 且有 UIA 并发竞态风险 |
| 换 pwsh 7 当宿主 | 启动省 1.2s，整体只省 0.4~0.8s | 要按 Codex 运行时目录探测程序集路径（不可移植），全部真机回归要重做 |
| 预编译 cua-tree.dll | 编译 231ms / 加载 26ms | 必须用本机 UIAutomationClient.dll 的绝对路径引用，且首次调用已被预热覆盖 |

---

## 6. 怎么验证（照抄，按这个顺序）

### 6.1 五个命令，各自覆盖什么

| 命令 | 耗时 | 覆盖 |
|---|---|---|
| `npm test` | ~15s | 102 项单元测试（含官方契约、client、schema、access） |
| `npm run smoke` | ~60s | 147 项原生协议断言（真机） |
| `npm run e2e` | ~120s | 74 项端到端（真机，会动真窗口） |
| `npm run verify:registry` | ~20s | 真实 cordis + 真实 dsh-tools 注册表投影 |
| `npm run indicator:smoke` | ~90s | 指示器：点击穿透 / 截图排除 / 脉冲动画 |

改 `cua.ps1` 至少跑前两个；改 `tools.js` / `index.js` 至少跑第 1、4 个；改 `indicator.ps1` 跑第 5 个。

### 6.2 三个测试命令的坑（会让你**误判为通过**）

1. **`node --test "test/*.test.mjs"`（带引号）在 cmd / 某些 bash 调用下不会被 shell 展开**，结果是 `0 tests / exit 0` —— 看起来通过，一条没跑。
   - 正确：bash 里不加引号 `node --test test/*.test.mjs`；或 `cmd //c npm test`；或 PowerShell 里 `npm test`。
2. `node --test test/`（给目录）→ `MODULE_NOT_FOUND`，exit 1。
3. 裸 `node --test` 会把 `test/helpers.mjs` 也当测试跑（变成 103 个）。

另外：在 ops_bash 的 bash 里直接 `npm test` 可能报 `node 不是内部或外部命令`（bash 的 PATH 传给 npm 的子 cmd 时丢了 node），前置 `PATH=/d/nodejs:$PATH` 即可。

### 6.3 只想快速看一眼某个命令的返回

**不要写 tmp 脚本。**（这条曾经浪费了大量时间：为了看一眼返回，写了几十个 `tmp-*.cjs`。）

```bash
npm run call -- list_windows --title=Firefox
npm run call -- get_app_state --app=firefox --els=40 --depth=4
npm run call -- screenshot --format=jpeg --quality=60 --out=.probe/shot.jpg

# 一次连调多条，共用一个后端进程（省掉 2.5s 冷启动）
npm run call -- ping + list_apps + list_windows
```

`--k=v` 的参数名规则：**先查别名表**（`--app` → `appKey`、`--els` → `max_elements`、`--depth` → `max_depth`、`--window` → `window_index`、`--target` → `target_hwnd`），查不到才把驼峰转下划线。数字/布尔自动转型；`--out=` 只在客户端落盘，不发给后端。

> 这里有过一个真实的坑：原生协议的名字是 **camel/snake 混排**的（`appKey` 是驼峰，`max_elements` 是下划线）。最初 `call.mjs` 只做"驼峰转下划线"，于是 `--appKey` 被转成 `app_key` 然后被 `Assert-Args` 拒绝（`Unknown argument(s) for get_app_state: app_key`）。所以别名表是必需的，不是便利。

### 6.4 改完代码的完整流程

```bash
cd /e/dsh-cua-verify
# 1) 语法（改 .ps1 后必做）
npm run check          # JS 语法
# PowerShell 语法：见下方内联命令
# 2) 单测 + 冒烟
npm test && npm run smoke
# 3) 性能有没有退化
npm run bench -- --repeat=3
```

PowerShell 语法检查（改 `.ps1` 后必做，秒级）：

```powershell
$e=$null
[void][System.Management.Automation.Language.Parser]::ParseFile('E:\dsh-cua-verify\src\native\cua.ps1',[ref]$null,[ref]$e)
if ($e.Count) { $e } else { 'SYNTAX_OK' }
```

然后**告诉用户重启 DSH**。不重启的话跑的还是旧代码（磁盘上已经是新代码，所以"改了没反应"会非常反直觉）。

---

## 7. 关键决策记录（这些是有代价换来的，别轻易推翻）

### 7.1 后端宿主保持 `powershell.exe` 5.1

冷启动 2.5s 里，powershell.exe 自身占 1.8~2.3s（空脚本实测），`System.Drawing` 的 `Add-Type` 又占约 500ms。pwsh 7 启动只要 658ms，但：

- 现有 102 项测试 + 全部真机验证都基于 5.1；
- pwsh 7 下 `Add-Type -Path cua-tree.cs` 必须用**运行时程序集绝对路径**引用（实测在 `%USERPROFILE%\.cache\codex-runtimes\...\native\powershell\`），不可移植；
- 整体只省 0.4~0.8s，而用户感知的"第一次调用慢"已经被预热覆盖（进程一直活着，冷启动只付一次）。

### 7.2 C# 只做树遍历，不做别的

C# 快路径只负责 `Walk()`。点击、截图、键鼠仍在 PS 里。理由是收益/风险比：树遍历是唯一有 O(n) 跨进程 COM 往返的热点，其余命令都是常数次调用。

### 7.3 未知参数必须报错（不是宽容）

`Assert-Args` 会对未知参数直接 `BAD_REQUEST`。这条是**故意**的：之前协议静默忽略未知参数，导致：

- `get_app_state {root:"document"}` 返回 `ok:true`，但源码里 `root` 出现 0 次 —— 假阳性，让人以为能力存在；
- `wait {timeout_ms:...}` 被吞，调用方看到 `status=unknown` 却找不到原因；
- `zoom.max_width` 被吞，DSH 的截图预算降级对 zoom 完全失效（57240B → 8094B 的收益拿不到）。

### 7.4 帧必须绑定窗口（`FRAME_TARGET_MISMATCH`）

截图/缩放产生的 frame 上记录了归属 hwnd。拿 A 窗口的 frame 去点 B 窗口会报错而不是静默换算。

这是修一个真实事故：对 firefox `zoom {left:400,top:300,scale:2}` 得到 f1，转去 notepad `click {x:250,y:100}`（不带 frame_id）实际点了 (525,350)，**而且返回 ok:true**。

### 7.5 `Add-Type` 的顺序不要动

418-422 行的五个 `Add-Type -AssemblyName`：第一个付掉全部程序集解析费（约 350ms），之后每个只加 ~30ms。`System.Drawing` 单独就要 500ms（PS5 会连带解析 Windows.Forms 依赖链）。

想省这 500ms 只能改成按需加载，但会让第一次截图变慢 —— 当前选择是保持启动时全加载。

### 7.6 C# 侧两个必守的写法

1. **`stats` 数组长度必须是 8。** 曾经因为 `New-Object int[] 4` 而 C# 写 `stats[4..7]`，PowerShell 越界赋值不报错，但整个 `Walk` 调用按失败处理 → 返回空数组 → 元素数 0、`bytes=642`、`truncated=true`。排查花了很久。现在 C# 侧统一用 `SetStat(stats, i, v)` 带边界检查。
2. **`try` 里赋值 + `catch` 里重赋值的模式，两条路径都必须赋值。** 否则编译报 `CS0165 使用了未赋值的局部变量`。

---

## 8. 已知限制（诚实记录，别当成 bug 去修）

1. **`get_app_state` 无法从 Document 起跳** —— 浏览器正文（例如 bilibili 的视频卡片列表）取不到，只能拿到外层 Group/Text/Button。目前传 `root` 会明确报 `BAD_REQUEST`（比之前的假成功好，但能力仍缺）。要修需要让 BFS 支持"从某个已知 Document 节点向下展开"，并且处理跨进程 COM 的时序。
2. **冷启动 ~2.5s** 主要是宿主成本，本插件内消不掉（理由见 §7.1）。
3. **每元素约 1.0~1.3ms 的 FindAll 固定跨进程成本** 仍在。这是 UI Automation 的固有开销，不是代码问题。
4. `type` / `set_value` 之后 UIA 的 Value 需要 ~200~330ms 才收敛（SendInput 异步 + 目标进程逐字符处理）。任何断言都要轮询，不能立刻读。
5. `zoom` 比 `screenshot` 省字节（省 81~91%）但**更慢**（63~484ms vs 124~126ms），因为它先整屏抓取再裁剪缩放。

---

## 9. 效率守则（这部分最省时间，逐条都是踩过的）

1. **看返回用 `npm run call`，不要写 `tmp-*.cjs`。**
2. **不要用"传个参数看它成不成功"来探测 API。** 协议对未知参数现在会报错，但历史上会静默忽略，任何"看起来成功"都不代表参数被支持 —— 去 `docs/native-protocol.md` 和 `$script:argWhitelist` 里核对。
3. **不要用 `window.title` 当变更探针。** 记事本打开已有文件时 `set_value` 写入后标题毫无变化；只有未命名新文件才出现 `*` 前缀。
4. **`data.image` 是对象** `{base64, mediaType, width, height, bytes}`，不是裸 base64 字符串。
5. **修改 `.ps1` 必须保留 UTF-8 BOM**（当前文件有 BOM，133381 字节）。C# 源码读中文注释必须 `[System.IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`，`Get-Content -Raw` 会按 ANSI 读并报 `CS1518`。
6. **`.ref/` 目录是有意的**（旧版 DSH 源码参照），不要删。
7. 评估"要不要做某个优化"时，**先看 §5.3 的否决表**，那十条每条都测过。
8. 做 A/B 时用 `tools/call.mjs` 或 `tools/bench.mjs`，**不要改测试文件去试**。
9. 跑真机测试前确认有窗口可测（Firefox 前台最好），否则某些 e2e 步骤会因为拿不到元素而跳步。
10. 指示器跑完记得 `npm run call -- shutdown`，否则后端进程会挂着（`npm run kill-backends` 可批量清）。
11. `docs/native-protocol.md` 是协议的**唯一真相**，改行为必须同步它，否则下一个人会以为文档是错的。
12. `VERIFY-REPORT.md` 是证据库（13 节）。写结论前先 grep 一遍，很可能已经测过。

---

## 10. 常见需求 → 直接去哪里改

| 需求 | 改哪里 |
|---|---|
| 加一个原生命令 | `cua.ps1` 的 `$script:argWhitelist`(619) + `Invoke-Cmd` 的 switch(2192) + `src/tools.js:230` 加工具定义 + `docs/native-protocol.md` |
| 改某个命令的行为 | 先确认 `argWhitelist` 里有那个参数名，再改对应 `Invoke-*` 函数 |
| 让 get_app_state 更快 | 只能动 `cua-tree.cs`。先跑 `npm run bench` 建基线，改完再跑 |
| 让截图更小 | `src/tools.js:1092` `captureWithinBudget` 的降级策略，或改 `src/config.js` 的 `screenshotMaxBytes` |
| 改权限/访问闸门 | `src/access.js` + `src/index.js:97` `enforceAccess`（fail-closed，改松要格外小心） |
| 改客户端 UI | `lib/client.js`（手写，用 `React.createElement` 而非 JSX，只 require `react`） |
| 改指示器外观 | `src/native/indicator.ps1` + `src/indicator.js` |
| 教模型怎么用 | `skills/computer-use/SKILL.md` |

**改客户端 UI 的颜色必须用 DSH 的 `--dsw-*` 变量。** `--dsh-surface` / `--dsh-border` 在整个 DSH 客户端里零定义，会永远命中硬编码 fallback —— 这就是深色主题下变成纯白的原因。可用：`--dsw-alias-bg-layer-2`、`--dsw-menu-surface-fill`、`--dsw-alias-label-primary` / `secondary`、`--dsw-alias-border-l1`、`--dsw-alias-state-error-primary`。

---

## 11. 交接检查单

接手后第一次动手前，确认这几件事：

- [ ] `cd /e/dsh-cua-verify && git status` —— 当前有一批未提交改动，**全部是已完成的优化，不要当成半成品回滚**：

```
 M .gitignore                      （加 .probe/）
 M README.md                       （目录/断言数同步、链接 HANDOVER）
 M docs/native-protocol.md         （预热、clamp、target_hwnd、FRAME_TARGET_MISMATCH）
 M lib/client.js                  （深色主题：改用 --dsw-* 变量）
 M package.json                    （bench/call 脚本、files 加 HANDOVER.md）
 M src/native/cua.ps1              （参数白名单、C# 接入、预热、screenshot clamp）
 M src/tools.js                    （target_hwnd 回传、zoom 选择器）
 M test/helpers.mjs               （asar 路径自动探测）
 M test/official-contract.test.mjs （同上）
 M test/tools.test.mjs            （zoom 归属测试、screenshot target_hwnd 断言）
 M tools/e2e.mjs                  （type 后轮询到收敛）
 M tools/ref-extract-validator.mjs （asar 路径自动探测）
?? HANDOVER.md                     （本文档）
?? VERIFY-REPORT.md                （13 节验证报告）
?? src/native/cua-tree.cs          （C# 树遍历快路径）
?? tools/bench.mjs                 （性能基准）
?? tools/call.mjs                  （单次调用）
```

- [ ] `npm test` 是 102 pass（不是 0 tests）。
- [ ] `npm run bench -- --repeat=1` 确认数字在 §5.1 的量级（差 2 倍以上说明环境变了）。
- [ ] 确认用户是否已重启 DSH（未重启则所有改动都不生效）。
- [ ] 改动前先读 `VERIFY-REPORT.md` 对应章节，避免重复已否决的方案。

---

## 附：这份文档没覆盖的

- 上游 `JHyugou/dsh-computer-use` 的原始设计意图（看 `README.md` §1–§3 + `NOTICE.md`）。
- DSH 插件系统的通用规则（看 `E:\DSH\resources\app.asar` 里的官方内核，或 `docs/reverse-engineering.md`）。
- 指示器协议的细节（`docs/indicator-protocol.md`）。
