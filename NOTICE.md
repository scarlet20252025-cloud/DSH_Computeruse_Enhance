# NOTICE — 归属与第三方说明

本仓库的**代码**以 MIT 许可发布（见 [LICENSE](LICENSE)）。下面按类别说明其中涉及的第三方信息。

## 1. 与上游产品的关系

* 本项目是 **独立第三方插件**，不是 DeepSeek Harness（DSH）或 ZCode / Z.ai 的官方项目，
  与其维护方无隶属或背书关系。
* 插件**调用** DSH 的宿主插件 API（`ctx.tools.register()` 等）与会话事件（`agent/status`），
  但**不包含、不复制**任何 `@deepseek-ai/*` 的代码。测试与验证脚本会在本地从已安装的应用
  提取这些包做交叉验证（`.ref/`，见第 3 节），该目录已列入 `.gitignore`，**不在本仓库中**。
* 仓库中出现的产品名（DeepSeek Harness、ZCode、Windows、阿里云等）仅用于说明兼容对象与
  运行环境，各自商标归其所有者。

## 2. 来自 ZCode 开源仓库的接口信息（Apache-2.0）

`docs/zcode-cua-contract.md` 记录的是**接口事实取证**，用于把「Computer Use」这套能力重建到
DSH 上。它引用了 ZCode 开源仓库中的文件路径、行号、类型名、常量名、错误码，并在若干处
**逐字摘录**了面向模型/开发者的说明文本（例如 `JS_TOOL_DESCRIPTION`、
`NODE_REPL_SERVER_INSTRUCTIONS`、i18n 文案）。

* 上游仓库以 **Apache License 2.0** 发布；上述摘录的著作权归其原作者，
  在 Apache-2.0 条款下使用并在此署名。
* 本仓库**不包含**上游的任何源代码文件、二进制、图标或其它资产，
  也不包含其未开源的 Computer Use runtime / Helper / CDN 资产。
* 上游开源版中的 Computer Use 本身是**不可用占位实现**；本文档只使用其公开的接口契约，
  重建出的实现（`src/`）为独立编写。

## 3. `.ref/`（仅开发期，不入库）

`node_modules/` 与 `.ref/` 都被 `.gitignore` 排除：

* `.ref/` 由 `node tools/ref-extract-validator.mjs` 从**本机已安装的 DSH 应用**中提取
  `@deepseek-ai/*` 包，用途仅限本地交叉验证（用官方实现校验我们的 schema 与技能 frontmatter）。
  它属于 DeepSeek Harness 的代码，**不随本仓库发布**，也不应在派生仓库中提交。
* 缺少 `.ref/` 时，相关断言自动跳过，其余测试照常运行。

## 4. 运行环境与系统 API

插件的原生后端通过 Windows 系统 API 工作（UI Automation、`SendInput`、GDI、
`SetWindowDisplayAffinity` 等），全部经 P/Invoke 调用系统 DLL，**未链接任何第三方原生库**。
`src/native/*.ps1` 与 `tools/*.ps1` 均为本仓库原创代码。

## 5. 测试夹具与文档图片

* `tools/e2e-fixture.ps1` 会在测试期间创建**属于本测试进程**的临时窗口，用于安全地验证输入注入。
* `docs/indicator-preview*.png` 是**本插件自身窗口**的 `PrintWindow` 抓取（合成在中性底色上），
  不含任何用户屏幕内容、桌面背景或第三方界面截图。
