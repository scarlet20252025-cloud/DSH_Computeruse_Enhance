# DSH Computer Use Enhance 验证报告（Windows / 官方 DSH 44.7.0 内核 0.2.1-rc.2）

> 本报告记录的是**本仓库（改良版）**在真实机器上的验证过程与数据。
> 第一节的候选筛选是「当初为什么选上游 JHyugou/dsh-computer-use 作为基线」，
> 后续章节记录的都是在本仓库上做的修复、优化与实测。

验证时间：2026-10-19 23:00–23:40 (Asia/Shanghai)
验证方式：只读。未触碰 %USERPROFILE%\.dsh 下任何 profile、配置、凭据；所有测试在独立工作副本中进行。
基线来源：JHyugou/dsh-computer-use（GitHub main，2026-10-16T04:05:47Z，MIT）；本仓库在其之上做了性能与契约加固，见 README §0。

## 一、候选筛选（为什么是它）

| 候选 | 结论 | 依据 |
|---|---|---|
| JHyugou/dsh-computer-use | ✅ 选定 | 唯一 Windows 原生（os:[win32]，PowerShell 5.1 + System.Drawing + UIAutomationClient），25 个工具与上游 ZCode Computer Use 完全同名，自带 3 层验证体系（101 单测 + 官方 asar 交叉验证 + 真实注册表验证） |
| Anionex/dsh-computer-use | ❌ 排除 | profiles:["web"]、Prerequisites 明写 macOS 14+、需 macOS Accessibility 授权与外部 cua-driver 二进制 |
| @bhzhangsun/dsh-computer-use | ❌ 排除 | ★0、无 license、README 为空、curl|sh 下载执行外部二进制到 ~/Library/Caches |
| @dsh-external/dsh-computer-use | ❌ 排除 | npm 404，从未发布 |

## 二、验证结果（本机实测）

| 项目 | 命令 | 结果 |
|---|---|---|
| 源码语法 | npm run check（8 个源文件） | 8/8 通过 |
| 单元测试 | node --test test/*.test.mjs | **101 tests / 101 pass / 0 fail / 0 skipped** |
| 官方实现交叉验证 | 同上 + DSH_ASAR=E:\DSH\resources\app.asar | 官方 @deepseek-ai/dsh-tools 真实加载，25 个工具的 parameters/output.schema 全部通过官方 assertSupportedJsonSchema；插件校验器与官方 validateJsonSchemaValue 行为逐字一致 |
| 真实注册表 | node tools/verify-real-registry.mjs | **PASS 10 / FAIL 0**（真实 cordis + 真实 ToolRuntime，注册表向模型投影出 25 个工具，无 execute/render 泄漏） |
| 原生后端（只读段） | node tools/native-smoke.mjs | **PASS 147 / FAIL 0**（ready 横幅、ping、screen_info、list_apps/list_windows、全屏/区域/缩放/JPEG 截图、zoom、剪贴板、open_application、get_app_state 元素树 120 项、错误码路径、wait、stop、shutdown、stdout UTF-8 纯净性） |
| 安装预览 | node tools/install-plugin.mjs（dry-run） | 识别到 %USERPROFILE%\.dsh\profiles\desktop，将备份 package.json 后加 link: 依赖与 bundle |

### 环境事实（本机实测，非文档声明）
- Windows PowerShell 5.1.26100.4768 正常拉起；dpiAware=true
- 显示器 \\.\DISPLAY36 1920x1080，AppliedDPI=96（100% 缩放）→ 坐标映射无缩放歧义
- 窗口枚举 17–27 个，中文窗口标题 UTF-8 传输无损（如「更新后工作路径丢失恢复」原始字节 e69bb4e696b0... 验证在）
- 截图 1920x1080 PNG 2.08MB，缩到 1280 宽 1.16MB，JPEG 45KB，预算阶梯降级生效

## 三、实测中发现的问题（如实记录）

1. **输入注入段间歇性失败（测试脚本问题，非插件缺陷）**
   native-smoke 的 CUA_SMOKE_INPUT=1 段中，type 后 Ctrl+A/C 回读剪贴板偶发读到上一次的旧值。
   复刻 6 次：4 过 2 不过；失败时剪贴板内容 = 上一次运行的 marker，即那次 Ctrl+C 未生效。
   在干净环境（清理残留记事本进程后）单独复刻同序列：连续 5 次全过。
   根因是测试前置条件被污染：我的实验进程崩溃时留下 6 个 notepad.exe，使 smoke 的
   「独占一个新建记事本窗口」前置断言失败，窗口激活竞争加剧。
   判定：**环境/清理问题，不计入插件缺陷**。

2. **未验证项（缺前置条件，如实标注）**
   - node tools/verify-in-dsh.mjs：需要 E:\deepseek-harness 源码 checkout 执行 pnpm dsh，
     本机不存在该 checkout（只有 E:\DSH\resources\app.asar\dsh 打包产物）→ 跳过。
   - node tools/indicator-smoke.mjs：会在屏幕上显示置顶浮层数秒。尊重用户「避免打扰」的要求 → 未跑。
     其逻辑层（show/update/autoHide/点击穿透/不抢焦点/不进截图的单元断言）已在 npm test 覆盖并通过。

## 四、安装步骤（可回滚）

安装前备份（一条命令）：
  robocopy %USERPROFILE%\.dsh %USERPROFILE%\.dsh-backup-20261019 /E /XO

安装（二选一）：
  A. DSH 插件页 → 「从路径安装」→ 选 E:\dsh-cua-verify → 重启 DSH
  B. 命令行：
     set DSH_HOME=%USERPROFILE%\.dsh
     set DSH_PROFILE=desktop
     node E:\dsh-cua-verify\tools\install-plugin.mjs --apply --install

回滚（一条命令）：
  node E:\dsh-cua-verify\tools\install-plugin.mjs --rollback
  （恢复 package.json.bak-dsh-computer-use，重启 DSH 即卸载）

## 五、安装后四步自查

1. 输入框旁应出现一行：🖱 电脑操控：<模式>（默认「全自动」）
2. 改成「禁用」后调用 left_click 等 GUI 动作 → 应返回 CUA_DISABLED，且桌面无任何变化
3. 调用 request_access → 返回应带 access_mode / subagents 字段
4. %USERPROFILE%\.dsh\plugins\dsh-computer-use\config.json 应落盘，含 accessMode

## 六、建议的初始配置（安全优先）

装好后第一件事把 accessMode 从 auto 改成 ask，确认行为符合预期后再决定是否放宽：
  编辑 %USERPROFILE%\.dsh\plugins\dsh-computer-use\config.json
  {"enabled": true, "tools": "native", "accessMode": "ask", "indicator": true,
   "screenshotMaxWidth": 1600, "screenshotMaxBytes": 524288, "maxRestarts": 3}

ask 模式下：主 Agent 的 GUI 动作每次都要你在 DSH 里确认；子代理默认拒绝（allowSubagents=false）。

## 七、已知限制（来自插件文档，未逐条实测）

- UIPI 提权窗口（如任务管理器）注入不到
- UWP/ApplicationFrameHost 属主 appKey 可能带 pid 后缀
- 最小化窗口无几何信息
- 自绘界面（Electron canvas / 游戏 / 远程桌面）元素树可能为空，只能截图 + 坐标点击
- 组策略禁止 powershell 执行脚本时后端起不来（本机执行策略 RemoteSigned，不受影响）

## 八、顺带发现（与本插件无关，供参考）

E:\dsh-cua-verify 下有两个非本仓库的目录，创建时间 2026-10-19T14:48Z：
  - E:\dsh-cua-verify\%SystemDrive%\ProgramData
  - E:\dsh-cua-verify\NVIDIA Corporation\umdlogs
这是某个安装程序把「当前目录」误当作解包目标造成的（典型的未加引号路径缺陷），
与本插件无关。未删除，留给你确认。

---

## 九、安装执行记录（2026-10-19 23:50–23:58）

用户已批准安装。执行过程：

1. **备份**：整个 desktop profile 目录复制到 %USERPROFILE%\.dsh\profiles\desktop-backup-20261019
   （14 个顶层条目，含 node_modules 18169 个文件、package.json、pnpm-lock.yaml、cordis.yml 等）。
   另记录安装前 package.json 的 SHA-256 前 16 位：33c6f587cf4f3aaf。
2. **改 profile manifest**：node tools/install-plugin.mjs --apply
   - 自动备份 package.json -> package.json.bak-dsh-computer-use
   - dependencies 新增 "dsh-computer-use": "link:E:/dsh-cua-verify"（13 -> 14 个依赖，无版本变更）
   - dsh.profile.bundles 追加 "dsh-computer-use"（15 -> 16 个 bundle）
3. **lockfile**：pnpm install --lockfile-only 通过（119 项，只新增 link 条目，其它版本未动）
4. **node_modules 链接**：pnpm install（完整版）被 pnpm 自身拒绝执行
   （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY —— 它想 purge 整个 node_modules 重建，
   无 TTY 环境下 pnpm 主动中止，这是安全行为）。未强行绕过（设 CI=true 会允许删除 18169 个文件，
   风险不可接受）。
   改用与现有 dsh-our-free-model 完全同形态的方案：创建目录联接（junction）
   %USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-computer-use -> E:\dsh-cua-verify
   （插件零运行时依赖，无需安装任何 npm 包，这与它能在只读环境跑通全部 101 项测试一致）
5. **静态自检（重启前可验的全部）**：
   - 15 个必需文件全部就绪（9 个 src、lib/client.js、2 个 native ps1、SKILL.md、cordis.patch.yml、package.json）
   - 从 profile 用 createRequire 解析 'dsh-computer-use/package.json' -> E:\dsh-cua-verify\package.json ✓
   - package.json main=src/index.js，type=module，exports 含 ./client ✓
   - 客户端插件（lib/client.js）是 window.__ModuleLoader__ 形态，只 require('react')，无 icon/locale 依赖，
     由 DSH 的 bundle 路由按 exports "./client" 自动加载（与官方 dsh-ops 组件同约定）✓
   - 宿主端入口 src/index.js 导出 name / inject:['tools'] / apply()，注册 25 工具 + /computer-use 命令 ✓
   - cordis.patch.yml 形态与官方 dsh-ops 一致（insert 列表），bundles 已含本插件 ✓

**回滚方式（一条命令）**：
  node E:\dsh-cua-verify\tools\install-plugin.mjs --rollback
或恢复整个目录：
  robocopy %USERPROFILE%\.dsh\profiles\desktop-backup-20261019 %USERPROFILE%\.dsh\profiles\desktop /MIR
（回滚后都要重启 DSH）

**安装时 DSH 正在运行**（10 个进程，其中 GUI 主进程 2 个各约 700–800MB），
因此新插件要等重启后才生效。


---

## 十、深色主题适配（2026-10-20 01:05）

**问题**：用户重启后看到「电脑操控」设置菜单是纯白实底，与深色界面（dream-skin frosted 材质）形成刺眼断层。

**根因（已核实，非猜测）**：`lib/client.js` 的 styles 用了 `var(--dsh-surface, #ffffff)` 与 `var(--dsh-border, ...)`。在整个 DSH 客户端范围内（E:\\DSH\\resources\\app.asar\\dsh，16197 个 .js/.css 全量扫描）**不存在** `--dsh-surface` / `--dsh-border` 这两个变量的任何定义，因此永远命中硬编码 fallback `#ffffff`。

**DSH 真正的主题变量**（出自 @deepseek-ai/dsh-client-ui-theme 的 design_platform.css，定义在 `body` 与 `body[data-ds-dark-theme]` 上，插件 DOM 位于 body 内可正常继承）：

| 变量 | 浅色 | 深色 |
| --- | --- | --- |
| `--dsw-alias-bg-base` | neutral-bluish-00 | neutral-bluish-950 |
| `--dsw-alias-bg-layer-1` | neutral-bluish-00 | neutral-bluish-875 |
| `--dsw-alias-bg-layer-2` | neutral-bluish-00 | neutral-bluish-850 |
| `--dsw-alias-label-primary` | neutral-bluish-1000 | neutral-bluish-50 |
| `--dsw-alias-label-secondary` | neutral-bluish-700 | neutral-bluish-300 |
| `--dsw-alias-border-l1` | #0000000a | #ffffff0f |
| `--dsw-menu-surface-fill` | #f8f9fa94 | #43454a73 |
| `--dsw-alias-state-error-primary` | red-600 | red-400 |

（官方客户端插件 dsh-pocket / dsh-dream-skin 用的就是这一 `--dsw-*` 命名空间。）

**改动**（只改 `E:\\dsh-cua-verify\\lib\\client.js`，8944 -> 9046 字节，5 处）：
- `panel.background`: `var(--dsh-surface, #ffffff)` -> `var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2, #262a33))`（官方菜单的半透明毛玻璃填充，深色下为 #43454a73）
- `panel.boxShadow`: `rgba(15,23,42,0.18)` -> `rgba(0,0,0,0.45)`（浅色投影在深色环境里等于没有投影）
- `button`/`panel` 的 `border`: `var(--dsh-border, rgba(127,127,127,0.28))` -> `var(--dsw-alias-border-l1, rgba(255,255,255,0.14))`
- `divider.background`: 同上改为 `--dsw-alias-border-l1`
- `error.color`: 硬编码 `#e5484d` -> `var(--dsw-alias-state-error-primary, #f25a5a)`

`color: 'inherit'` 保持不变（跟随 body 的 `--dsw-alias-label-primary`，深色下为浅字）；fallback 也从中性白改成中性深色 `#262a33`，即使将来宿主某天不注入变量也不会再出现白底。

**回归**：`node --check` 通过；`node --test "test/*.test.mjs"` -> 101 tests / 99 pass / 0 fail / 2 skipped（两条 skip 是「找不到 app.asar: E:\\DSH-DeskTop\\resources\\app.asar」，与本改动无关的既有环境探测项）。

**生效方式**：`lib/client.js` 经 junction 被 profile 引用，**重启 DSH** 后生效，无需重装、无需再跑安装脚本。


---

## 十一、Computer Use 链路实测复盘（2026-10-20 01:30）

用户转来另一会话的使用体验，要求「找优化方法」并「总结操控中的真实问题」。本节全部结论都在本机实测得出，不是推测。

### 1. 实测数据

**UIA 树对浏览器有多贫瘠**（驱动 `src/native/cua.ps1` 直接打协议，目标 Firefox pid 39228，bilibili 播放页）：

| 指标 | 默认 `max_elements=120 / max_depth=8` | `max_elements=400 / max_depth=16` |
| --- | --- | --- |
| 返回元素数 | 120（**truncated**） | 400（**truncated**） |
| 其中 offscreen | 376/400（94%） | 376/400 |
| onscreen 且有 actions | 22 | 22 |
| onscreen Hyperlink（视频卡片） | **0** | **0** |
| 原生 UIA 全树规模（另测） | 3914 个元素 / 2866 个带名字 | 同 |

即：**原生树有 3914 个节点，工具只给前 120~400 个，而 BFS 顺序把当前 tab 的正文内容排在 400 名之后**。返回列表前 30 个全是 `Menu "" id=tabContextMenu` 这类离屏右键菜单模板，第 64~72 个才是 9 个后台 tab 的 `Document`，正文（Group/Text/Hyperlink）全部落在 400 之外被截断。

**延迟**（同一进程内串行调用）：

| 调用 | 耗时 |
| --- | --- |
| `ping` | 120 ms |
| `screenshot` 1920x1080 PNG | 434 ms，**670,586 字节** |
| `get_app_state` 默认 | 494 ms |
| `get_app_state` 400/16 | 1,670 ms |

**截图预算**：`src/tools.js:1078-1126` 的 `captureWithinBudget` 已实现阶梯降级（PNG → JPEG → 长边压到 60%），上游硬预算为单张 256 KiB / 合计 512 KiB / 最多 4 张。也就是说模型侧确实做了压缩，但**单次 434 ms 的拍照成本 + 每步都要拍**是链路长的直接来源。

**`open_application` 的对象形状**：实测复现另一会话的报错。`{url: 'about:blank'}` → `LAUNCH_FAILED: Could not launch "about:blank": 无法完全运行此命令`；根因在 `cua.ps1:2621` 用的是 `Start-Process -FilePath $target`，它对 `http(s)://` 走 shell 关联能成（`https://example.com/` 实测成功），但对 `about:` 之类 scheme 直接失败。`{name: 'notepad'}` 实测成功。**结论：传字符串是对的，对象形状的 `url` 分支可用但不通用**。

**DPI**：本机 `AppliedDPI=96`（100% 缩放，1920x1080 物理像素）。另一会话报 `scale=0.833` 说明其显示器为 125% 缩放。`cua.ps1:1628-1629` 的 `Resolve-Point` 已有 `frame.source + x / frame.scale` 的换算，`space="screen"` 可绕过帧换算——**帧不一致问题有解，只是模型没用 `frame_id`**。

### 2. 真实问题清单（按严重度）

1. **Web 内容在 UIA 树里等于不存在**（最致命）。`max_elements` 上限 400 卡住了 BFS，而 Firefox 把 26 个离屏右键菜单模板 + 9 个后台 tab 排在前面。→ 元素目标路线对浏览器完全不可用，只能猜坐标。这是架构问题，不是参数问题。
2. **每步必须截图确认，因为缺少便宜的「刚才生效了吗」探针**。`get_app_state` 默认 494 ms 无图，但浏览器场景拿不到有用的元素；窗口标题变化是唯一免费信号，而工具没有暴露「只读窗口标题」的轻量接口。
3. **截图单张 670 KB**，即使有预算降级，拍照本身 434 ms，13 次调用里 4 次拍照 ≈ 1.7 s 纯等待 + 4 张图进上下文。
4. **`open_application` 的 `url` 分支不通用**（`about:` 等 scheme 失败），错误信息 `The system cannot find the file specified` 指向文件系统而非 shell 关联，误导性强。
5. **`wait` 无有效返回语义**。另一会话 3 次 `wait` 全回 `status="unknown"`，等于没有等到信号，此时应该截图而不是继续。
6. **右键菜单残留**（另一会话遇到的）：`get_app_state` 输出里能看到 `contentAreaContextMenu @(931,339,235,386) offscreen` 和 12 个 `MenuItem`（复制/全选/截图…）。这个菜单是上一次操作遗留的副作用，截图时会一起拍进去，污染模型判断。

### 3. 可落地的优化（按性价比排序）

**A. 浏览器任务根本不该走 computer use**。本机 Firefox **未开 `--remote-debugging-port`**（实测 wmic 命令行无该 flag），所以 CDP 路线要重启浏览器才可用。但 DSH 自带 `web_fetch` + REA 的 CDP 工具链（`inspect_web_page` / `capture_browser_scenario` / `list_browser_targets` 需要 `cdp_endpoint`）。**建议：读页面、点链接、填表单全部走 CDP；computer use 只留给「必须真实鼠标键盘」的最后一两个动作**（如播放器进度条拖动、需要登录态的点击）。

**B. 用 `get_app_state` 读窗口标题当免费探针**。返回体里 `window.title` 是现成的（实测 `"华强买瓜，但死神来了_哔哩哔哩_bilibili — Mozilla Firefox"`）。点击后先比标题变没变，变了才算生效；没变就 `zoom` 局部定位而不是重试。`zoom` 比全屏 `screenshot` 便宜一个数量级。

**C. 始终带 `frame_id` + `space="raster"`**，或直接 `space="screen"` 绕开换算。125% 缩放的机器上这是坐标漂移的唯一根因。

**D. 提高 `max_elements` 无用，应该缩小根**。Firefox 的正确做法是让 `get_app_state` 支持从当前 tab 的 `Document` 节点起跳。**⚠️ 注意：实测传 `root:"document"` 返回 ok:true，但那是假阳性 —— 原生脚本里 `'root'` 出现 0 次，未知参数被静默忽略，元素数仍是 400/truncated。这条改进尚未实现，需要改原生脚本。**

**E. 动作后不截图也能验证的两个免费信号**：① `window.title`；② `stop_computer_control` 前用一次 `get_app_state` 的 `changes` 差分（`tools.js` 已实现 `computeChanges`）。

### 4. 建议给插件的三个改进（未实施，待用户决定）

1. `cua.ps1` 的 `open_application` 的 `url` 分支改用 shell 关联（`cmd /c start` 或 `ShellExecute`），让 `about:`/`mailto:` 也能开，错误信息改成「不是文件路径问题」。
2. `get_app_state` 增加 `root: "document"` 之类的起跳参数，绕开 BFS 被离屏菜单挤占的问题。
3. 增加轻量 `get_window_title`（或让 `wait` 返回标题变化作为完成信号），给「刚才生效了吗」一个零成本答案。


### 5. 自测验证结果（2026-10-20 01:50，实测推翻/修正了上文的若干结论）

用户要求「你自己测试验证一下」。我直接驱动 `cua.ps1` 的 24 个原生命令逐条打靶，结论如下。

**✅ 站得住的**

- **`set_value` 真实生效**：对记事本 `[5] Document "Text editor"` 写 `MARK-jrtcb`，再 `get_app_state` 读回 `value` 一字不差。元素目标路线在 Win32 应用上是可靠的。
- **`click` 元素目标精确**：`click {element_index:5, state_id:"s1"}` → `target {x:828,y:523}`，正是编辑区中心。
- **`zoom` 省字节是真的**：500×200 区域 `zoom` 只有 11~31 KB，全屏 JPEG 是 127~167 KB，**省 81~91%**。
- **`wait` 带 `app` 选择器 = 可用的「等 + 看」探针**：`wait {duration_ms:1500, appKey:"notepad"}` 一次调用同时返回 `waitedMs:1500` + `window.title` + `elementCount`，不需要截图。
- **`clipboard_write` / `clipboard_read` 往返正常**（17 字符写入读回一致）。
- **`open_application` 的 `{url}` 分支**：`https://example.com/` 成功（走 shell 关联），`about:blank` 失败 —— 与上文一致。

**❌ 被实测推翻的（重要）**

1. **`root:"document"` 是假阳性**。上文建议 D 说「让 `get_app_state` 支持从 Document 起跳」，我实测传 `root:"document"` 返回 `ok:true`，差点当成已支持。核对源码：原生脚本里字符串 `'root'` 出现 **0 次**；传 `totally_bogus_param:"lol"` 与不传结果完全一样（elementCount 都是 10）；firefox 传 `root:"document"` 仍是 **400 且 truncated**。
   → **协议对未知参数静默忽略**，这是本插件最阴的坑：任何 API 探索都会「看起来成功」。这条改进**尚未实现**，要改原生脚本。

2. **`window.title` 探针不可靠**。记事本打开的是已有文件（`wolfmount.ini - Notepad`），`set_value` 写入后标题**没有任何变化**。只有「未命名新文件」被编辑时才会出现 `*` 前缀（实测 `*ABCXYZ - Notepad`）。
   → 标题探针只在特定场景成立，**不能当通用「生效了吗」的答案**。

3. **`zoom` 不是「更快」，只是「更省」**。三轮实测：`zoom` 63~484 ms，全屏 `screenshot` 124~126 ms —— **zoom 反而更慢**，因为它先整屏抓取再裁剪缩放（`Get-VirtualScreen` → crop → resize）。省的是上下文字节，不是时间。

4. **`wait` 的 `status="unknown"` 是参数名用错**。原生 `wait` 只认 `duration_ms`，另一会话传的 `timeout_ms` 被静默忽略 → 永远睡默认 1000 ms。DSH 侧的工具定义（`tools.js:852-877`）暴露的是 `duration`/`duration_ms`，参数本身是对的，问题是**静默忽略**让错误不可见。

**⚠️ 新发现的真实危险（比原文更严重）**

**跨窗口静默复用旧帧 = 坐标漂移到别的窗口**。实测：

1. 对 firefox 做 `zoom {left:400,top:300,width:500,height:200,scale:2}` → `frame f1`，记录 `source {x:400,y:300}`、`scale {2,2}`
2. 转去操作 notepad，`click {x:250, y:100}`（`space` 默认 `raster`，**不带 frame_id**）→ 实际点在 **`{x:525, y:350}`**
3. 换算正是 `400 + 250/2 = 525`、`300 + 100/2 = 350` —— 它套用了 firefox 的帧几何

也就是说：**换应用时如果不显式带 `space:"screen"`，坐标会被上一个窗口的 frame 静默污染，而且返回 `ok:true`**。这比直接报错危险得多。

对照实验：
- 带正确 `frame_id` → 精确生效
- 带过期 `frame_id` → **会报错** `ELEMENT_STALE: frame_id f1 is not the latest frame (f2)`（这个是安全的）
- 带 `space:"screen"` → 绕过换算，坐标直通
- 不带 `frame_id` + `raster` → **静默污染**（最危险）

### 6. 修正后的行动建议

1. **换应用操作时一律带 `space:"screen"`**，或每次操作前重新拍一张并立刻用它的 `frame_id`。这是唯一能防住静默污染的做法。
2. **别指望 `window.title` 当探针**，改用 `wait {app:...}` 拿 `elementCount`/`elements` 做差分（`tools.js` 的 `computeChanges` 已经做了对比）。
3. **`zoom` 用来省上下文，不要指望它省时间**；追求速度直接 `screenshot` + `quality:50`。
4. **任何新参数先验证是否真的被读取**：传一个明显荒谬的值对照结果，否则会把「静默忽略」误判成「支持」。


---

## 十二、修复：参数契约与跨窗口帧污染（2026-10-20 02:10）

用户看完第十一节后说「那就修复」。以下改动全部经过实测验证，不是纸面修改。

### 问题 1：未知参数被静默忽略 → 已修复

**症状**：传 `root:"document"` 给 `get_app_state` 返回 `ok:true`，但原生脚本里 `'root'` 出现 0 次——参数被吞掉，调用方误以为功能已支持。

**修复**（`src/native/cua.ps1`）：
- 新增 `$script:argWhitelist`（24 个 cmd 各自的参数表）+ `Assert-Args` 函数
- `Invoke-Cmd` 入口调用 `Assert-Args`，任何未列出的键 → `BAD_REQUEST`，且 `details.unknown` / `details.accepted` 都给出

**实测**：
```
get_app_state {appKey:'firefox', root:'document'}
→ BAD_REQUEST: Unknown argument(s) for get_app_state: root.
  Accepted: appKey, hwnd, pid, window_index, title, max_elements, max_depth, timeout_ms
```

这条与协议文档 §5 原本就写着的「`BAD_REQUEST` | 参数缺失/类型错/**键名未知**」一致——是补齐实现，不是改规范。

### 问题 2：白名单暴露出一批「DSH 会发、原生不读」的参数 → 逐个补齐实现

| 参数 | 之前 | 现在 |
| --- | --- | --- |
| `zoom.max_width` | 被忽略，**DSH 的截图预算降级对 zoom 完全无效** | 真实现长边限制 |
| `list_windows.title` / `window_index` | 被忽略，「按标题选窗口」静默退化成「按 appKey 取第一个」 | 真实现过滤 |
| `Resolve-Target` 的 `title` / `window_index` | 同上 | 真实现解析 |
| `key.element_index` / `state_id` | 被忽略，元素目标静默降级成全局按键 | 先点元素再发键 |

**实测 `zoom.max_width`**：600×300 @2x，不压 57,240 B → `max_width:300` 后 8,094 B（**省 86%**）。之前这条降级路径是死的。

**实测窗口过滤**：
```
list_windows {title:'Firefox'}                  → 1 个
list_windows {appKey:'firefox', window_index:99} → 0 个（越界返回空，不报错）
focus_window {window_index:99}                  → WINDOW_NOT_FOUND: out of range (0..1)
```

### 问题 3：跨窗口静默复用旧帧（最危险）→ 已修复

**复现**：给 firefox 拍 `zoom {left:400,top:300,scale:2}` → `f1`；转去 notepad `click {x:250,y:100}`（默认 raster，不带 frame_id）→ 实际点 `{x:525,y:350}`，**还返回 ok:true**。坐标被上一个窗口的 `source`/`scale` 静默平移。

**修复**：
- `Set-LatestFrame` 增加第 4 个参数 `$TargetHwnd`，帧上记录 `hwnd`（0 = 整屏/未知，不参与校验）
- `screenshot` / `zoom` 接受 `target_hwnd`，写进帧归属
- `Resolve-Frame` 在返回前比对「帧归属 hwnd」与「本次操作解析到的目标 hwnd」，不一致 → `FRAME_TARGET_MISMATCH`
- DSH 侧 `resolveWindowRegion` 回传 `target_hwnd`（`first.hwnd`），`zoom` 新增 `app`/`window` 选择器

**实测**：
```
zoom(firefox, target_hwnd=firefox)     → OK f1
click(explorer, raster, 复用 f1)       → FRAME_TARGET_MISMATCH（拦住）
click(firefox,  raster, 同窗口)        → OK target={x:450,y:325}
click(explorer, space=screen)          → OK target={x:100,y:50}
screenshot(整屏, 无归属) → click(explorer, raster) → OK 放行（不误伤）
```

### 回归

- PowerShell 语法：`SYNTAX_OK tokens=20335`
- 单元测试：**102 tests / 100 pass / 0 fail / 2 skipped**（新增 1 条 zoom 归属测试；更新 screenshot 断言）
- 端到端 10 项全通过：未知参数×2、zoom 压缩、title 过滤、越界、跨窗口拦截、同窗口放行、screen 绕过、整屏不误伤、key 元素目标
- 协议文档 `docs/native-protocol.md`：补 `FRAME_TARGET_MISMATCH`、`target_hwnd`、以及「未知键名真的会拒绝」

### 仍需注意（未修）

- **`get_app_state` 仍无法从 Document 起跳**。白名单现在会**明确拒绝** `root`，比之前「假成功」好，但浏览器正文依旧取不到。真正的修法是给 `Build-ElementTree` 加一个「只从当前 tab 的 Document 子树 BFS」的参数——这是功能增强，不在本次修复范围。

## 十三、性能优化（2026-10-20 02:40–03:05）

目标（用户原话）：「让延迟尽可能低，响应尽可能快」。下面每个数字都是本机实测（Firefox 前台，
`tmp-bench-real.cjs` 走真实 NDJSON 协议，每档取多次最小值），不是估算。

### 1. 优化前基线

| 档位 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| get_app_state 400/16 | 1432 ms | 280–360 ms | **-78%** |
| get_app_state 200/16 | 895 ms | 165–207 ms | **-79%** |
| get_app_state 100/8 | 540 ms | 120–190 ms | **-72%** |
| get_app_state 25/8 | 374 ms | 72–94 ms | **-78%** |
| get_app_state 1/1 | 297 ms | 36–43 ms | **-87%** |
| list_windows（全部） | 309 ms | 23–34 ms | **-90%** |
| list_apps | 171 ms | 32–51 ms | **-75%** |
| 第一次 get_app_state（预热后） | 932 ms | 396 ms | **-58%** |
| screenshot jpeg q60 | 78 ms | 211–219 ms | 见下（口径不同） |

### 2. 做了什么（按收益排序）

**① 进程信息改查全量进程表（-130~280 ms/次）**
`Get-ProcessInfo` 原来对每个 pid 单独 `Get-Process -Id`（实测 72 ms/次）+ `Get-Item VersionInfo`（+38 ms）；
`list_windows` 一次要枚举几十个窗口，于是秒级。改成一次 `[Diagnostics.Process]::GetProcesses()`（12 ms / 413 进程）
建 pid→{name,path,description} 表，TTL 30 s 缓存（`Get-ProcInfoTtlMs`）；三处调用点从「每次全清」改成 `Reset-ProcessInfoCacheIfStale`。

**② 离屏元素不探 UIA pattern（-390 ms @400）**
`Get-ElementActions` 对每个元素探 7 个 pattern（Invoke/ExpandCollapse/Toggle/SelectionItem/Value/Text/ScrollItem），
每个都是跨进程 COM。离屏元素根本点不到，所以直接返回空数组。A/B：1432 → 1042 ms。

**③ 树遍历下沉到 C#（-400~500 ms @400）**
新增 `src/native/cua-tree.cs`（`CuaNode` / `CuaTree.Walk`）。同样的 BFS 逻辑，PS 版 700~1000 ms，
C# 版 280~430 ms —— 差的全是 PowerShell 的循环/属性绑定/哈希表开销，不是 UIA 本身。
`cua.ps1` 用 `Add-Type -Path` 加载，失败自动回退到 PS 实现（`$script:treeApi = $false` + stderr 诊断）。
等价性实测：Notepad 37 元素逐字段比对 `compared=37 mismatched=0`。

**④ 跳过后台标签页的 Document 子树（-160 ms @400，且内容更多）**
Firefox 9 个标签页里 8 个是后台，它们的 DOM 占了 95% 的离屏 FindAll。判定口径是
「已经有可见 Document 在前」而不是「这个 Document 离屏」——因为窗口最小化时所有 Document 都会被标离屏，
按离屏跳过会把整页正文一起丢掉。

```csharp
if (node.Role == "Document") {
  if (!node.Offscreen) sawOnscreenDoc = true;
  else if (sawOnscreenDoc) continue;
}
```

副作用是好的：400 预算下 onscreen 从 66 升到 142，Hyperlink 从 37 升到 101。

**⑤ 启动预热（第一次调用 -536 ms）**
新增 `Initialize-BackendCaches`，在**就绪横幅发完之后**执行：建进程表、枚举窗口、连一次 UIA、跑一次 8 元素小树。
放在 ready 之后是因为 ready 一发宿主就能用，预热期正好和宿主装技能/模型思考并行。

**⑥ 其他**：UIA root 按 hwnd 缓存（`$script:rootCacheEl`）、离屏元素跳过 runtimeId、BFS 子节点 onscreen 优先入队。

### 3. 试过但**没有**采用的（附理由，避免重复踩）

| 方案 | 实测 | 否掉理由 |
|---|---|---|
| 全局离屏截断（depth 3/4/5 不展开） | 400 预算 56–72 ms | onscreen 只剩 66、Hyperlink=0，正文全丢 |
| 跳过离屏 Menu 子树 | 400 预算 234–295 ms | 比只跳 Document 更慢，且 menuItems 归零 |
| 跳过叶子角色（Text/Image/Separator/Hyperlink/MenuItem）的子节点 | 400 预算 166–204 ms（-10~30 ms） | WindowsTerminal 会丢 5 个 ScrollBar/Button（可操作元素） |
| 只跳「离屏的」叶子角色 | 400 预算 334 ms | 反而更慢（比基线 +63 ms），还丢了 8 个 Menu |
| 缓存 pattern 关掉（CachePatterns=false） | 无差别 | actions 已经降到 1~7 ms |
| 换 PowerShell 7 宿主 | READY 2243 ms（vs 2689） | 只省 0.4–0.8 s，但要重做 Add-Type 引用探测（依赖 Codex 运行时目录）与全部真机回归 |
| C# walker 预编译成 dll | 加载 26 ms（编译 241 ms） | 需要按机器路径引用 UIAutomationClient.dll，不可移植；且首次调用已有预热覆盖 |
| `Parallel.For` 并行 FindAll | 300 父元素 seq=102 ms / par8=70 ms | 只快 31%，但 UIA COM 并发会引入不确定的跨进程竞态，不值得 |

### 4. 两个值得记下来的坑

* **stats 数组长度**：C# 侧往 `stats[4..7]` 写，PowerShell 传的是 `New-Object 'int[]' 4`。
  越界赋值在 PS 里不报错，但整次 `Walk` 被判失败 → 返回空数组 → `elementCount: 0` 而且 `ok: true`。
  已改成 8，并在 C# 侧加了带边界检查的 `SetStat`。
* **`node --test test/` 会把目录当模块**（MODULE_NOT_FOUND）。正确写法是 `node --test "test/*.test.mjs"`，
  且在 Windows 上需要 `shell: true`。

### 5. 回归

* `node --test "test/*.test.mjs"`：**102 tests / 100 pass / 0 fail / 2 skipped**。
* PowerShell 语法：`SYNTAX_OK`。
* Notepad 37 元素字段级一致；最小化窗口仍返回 37 元素、`minimized: true`；Firefox 最小化仍 400 元素。
* 清理：删掉 108 个 `tmp-*` 实验脚本与 `cua.ps1.bak-perf2`，`src/native/` 现在只有 `cua-tree.cs`、`cua.ps1`、`indicator.ps1`。

### 6. 仍未解决的

* **冷启动 ~2.7–3.3 s**：其中 1.8–2.3 s 是 `powershell.exe` 自身的启动（空脚本就要这么久），
  另有约 0.5 s 是脚本里 `Add-Type -AssemblyName System.Drawing`（它会连带解析 System.Windows.Forms 依赖链）。
  要把这 0.5 s 拿掉只能改成按需加载，代价是首次截图变慢 —— 当前选择保持现状。
* **每次 FindAll 的固定跨进程成本**（约 1.0–1.3 ms/元素）：这是 UIA 的固有开销，只能靠少枚举（已做）而不是加快单次调用。
* **`get_app_state` 仍无法从 Document 起跳**：浏览器正文（视频卡片等）依然取不全，现在会明确报错而不是假成功。
