# AGENTS.md — DSH_Computeruse_Enhance（发布仓库）

本目录是 Computer Use 插件的**发布副本**，推送到
https://github.com/scarlet20252025-cloud/DSH_Computeruse_Enhance

它与开发工作副本 `E:\dsh-cua-verify` 内容一致但**各自独立**：

- 在这里改 → 只影响发布版，运行中的 DSH 用的还是 `E:\dsh-cua-verify`（junction 指向那边）
- 想发版：先把工作副本的改动同步过来，再 commit + push

## 第一件事

读 [HANDOVER.md](HANDOVER.md)（代码地图 / 性能结论 / 已否决方案 / 效率守则），
以及 [README.md](README.md) §0「本仓库相对上游做了什么」——那是这个仓库存在的理由。

## 发布前检查

```bash
cd /e/DSH_Computeruse_Enhance

node --test test/*.test.mjs   # 不加引号；无 .ref/ 时部分断言会 skip，这是预期的
npm run check                 # JS 语法

git add -A
git -c user.name="scarlet20252025-cloud" \
    -c user.email="scarlet20252025-cloud@users.noreply.github.com" \
    commit -m "<type>: <说明>"
GIT_TERMINAL_PROMPT=0 git -c http.version=HTTP/1.1 -c credential.helper=manager push
```

**`http.version=HTTP/1.1` 是必需的**：本机 git 走 HTTP/2 时 TLS 握手会在 renegotiate 阶段卡死
（`Failed to connect to github.com:443`），降级到 1.1 立刻通。

## 不要做

- 不要提交 `.ref/`（从本机 DSH 提取的官方代码，NOTICE.md 明确写了不应入库）。
- 不要把真实用户名/工作区名写进文档（已统一为 `%USERPROFILE%` / `<cwd>`）。
- 不要改 `package.json` 的 `name`（必须保持 `dsh-computer-use`，
  `cordis.patch.yml` / `dsh.profile.bundles` / 已装 profile 全按这个名字解析）。
