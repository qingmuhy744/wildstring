状态：已交付于 PR #137

# 历史文档状态清理

## 目标

按 PR #137 的方案生命周期，核对并清理过期状态、被替代的计划入口和重复台账。用户已要求清理，并提供会话 `01a1df0d-130f-72f2-883d-b2d5cba3122d` 的只读审查作为线索；每项以当前分支重新核对为准。

## 不碰的边界

不修改功能、真实数据或发布状态，不把已有代码等同于完整验收。不删除仍有决策价值的历史方案，不把真正未实现的播客转写方案标为交付；合并前不提前标为已交付。

## 方案

- 保留 `origin/main` 合入的 `docs/archive/` 归档目录与提示头，修复 `docs/archive/README.md` 跨目录指向 `../research/` 的 3 处相对链接，并将早期方案与一次性审计的状态细节合入归档副本，避免回退搬迁制造死链；`docs/plans/` 专管后续重活方案并与 `AGENTS.md` 状态行分层共存。
- 核对 iOS、Android 设置、Agent、元数据编辑与整理，以及旧版播放样式等状态，并补齐客户端主入口（`frontend/android/README.md`、`frontend/macos/README.md`）、`contracts/` 全量契约及历史批次文档的状态核对。
- 遵循 `AGENTS.md` §1 版本台账约定：保留 `docs/releasing.md` 补全后的版本对照表与 `versionCode` 清单、将 `frontend/android/README.md` 顶部源码版本更新为 `0.8.16（versionCode 52）`；消除发布指南的旧授权、脚本检查范围歧义及失败版本单跳引用；历史测试结果不改写成此次验证。
- 规范改动独立核对与提交：`AGENTS.md` §1 接入 `docs/plans/` 并分层状态行、§2 引用 `DESIGN.md` §5.5/§7 规则，`DESIGN.md` §6.1 只保留 §3 令牌表作为 `--row-active` 色值来源；提交时将 `AGENTS.md`／`DESIGN.md` 规范修改与批量文档清理分拆提交。

## 验收

L0：`make check`；扫描受管 Markdown 本地文件链接及 `#章节锚点`，反查旧状态词，检查 diff。外部 URL、全量代码符号映射、真实设备、运行实例和历史发布产物不作为本次验收范围。

## 风险与回滚

历史方案可能只有部分实现：明确标为历史方案并列当前实现入口，不逐项补勾。修改仅为 Markdown，可逐文件回退。

## 核对与处理记录

| 审查线索 | 当前分支证据与处理 |
| --- | --- |
| iOS、Android 设置、Agent、0.3.0 仍像未实施 | GitHub 确认 PR #50、#81、#20、#14 已合并；补首版交付状态，保留目标与未验收边界；`android-settings-navigation-plan.md` 补充正式发布承接 `0.8.4` |
| 每日推荐、歌词、帮助、缓存仍写未发布 | 分别对照 0.8.2、0.5.3、0.5.12、0.2.0 版本说明更新；旧 0.2.3 内容注明并入 0.3.0 |
| 元数据批量／封面／目录整理被列为未实现 | 核对 `management.py` 与 `file_reorganizer.py`，修正架构说明和管理／托管契约；标签写回、可恢复批量任务仍未实现 |
| 失效引用 | `origin/main` 已新建 `docs/archive/README.md` 并迁移 12 份历史文档，核对补修其中 3 处 `../research/` 相对路径断链；历史 Agent 计划引用已删除 `ai_config.py` 已改为说明并链接 0.8.12 说明；修正 `scope.md` 悬空“上方各版本记录／本批记录”指代 |
| 失败发布与重复台账 | 0.8.3／0.8.11 就地注明 Release 未完成及承接版本；按 `AGENTS.md` §1 新规保留 `releasing.md` 完整版本对照表与 `versionCode` 清单，仅清除旧版 0.3.0 授权并标明 `package_release.py` 未自动检查 Apple `project.yml`；`scope.md` 精简为范围、契约及版本入口 |
| 现行入口误指历史计划 | `scope.md` 与 Agent ADR 指向当前契约及归档路径；`agent-platform.md` 清理残留“当前开发分支”；未归档计划补齐状态行；播客转写保留 `进行中（未排期，roadmap 后续能力）` 与提案边界 |
| 规范冲突 | `AGENTS.md`／`DESIGN.md` 单独提交：AGENTS §1 分层引入 `docs/plans/` 五态与通用状态行，§2 对齐 DESIGN §5.5/§7 动画与圆角引用；DESIGN §6.1 移除重复冲突暗色值；`docs/plans/README.md` 对齐不自动委派约定并指向 `docs/archive/` |
| schema 与歌词实现状态冲突 | 开发说明改为引用 `SCHEMA_VERSION`；歌词契约开头与四端实现表对齐 |
| 二次校验扩展：客户端主入口与契约 | 修正 `frontend/android/README.md`（按台账规范将顶部源码版本更新为 `0.8.16（versionCode 52）` 并指向 `build.gradle.kts`；对齐默认黑胶样式与逐线路 HTTP 规则、补充 0.5.9 一次接受策略；在 0.3.0／0.4.0 段落明确区分首版记录与现行网页端管理边界，注明重管理、巡检、定时计划、模型连接增删改及非歌单草案核对已移至 Web，iOS 已于 0.5.13 交付；更新两个 `../../docs/archive/` 链接）与 `frontend/macos/README.md`（“开发分支”改为 `0.8.3／0.8.4`）；更新 `contracts/` 下 `podcast-search.md`、`interface-language.md`、`storage-and-podcast-resources.md`、`multiple-libraries.md`、`mobile-completion.md` 状态与四端／schema 说明 |
| 二次校验扩展：历史批次产品与架构文档 | 对照 PR 与版本说明收敛 `server-connections-and-mcp.md`、`lyrics-preview-and-handoff.md`、`client-and-podcast-explore.md`、`docs/archive/web-navigation-and-settings-audit.md`、`docs/archive/multi-user-settings-audit.md`、`provider-network-diagnostics.md`、`library-admin.md`、`docs/archive/library-browsing.md`、`docs/archive/mcp-download-import-0.5.7.md` 及 `scope-history.md` 残留“当前分支／开发分支／未提交／尚未实施”表述 |
| rebase 融合 `origin/main`（PR #134–#136） | 基于 `cfca43b` 重新整理分支并保留 `docs/archive/` 与 `.github/pull_request_template.md` 等上游更新；将 8 份迁入 `docs/archive/` 的清理增量合入归档副本，更新各相关文档状态行措辞以对齐 `AGENTS.md` §1 |

验证：L0 `make check`（17 项 pre-commit 钩子）、`python3 scripts/package_release.py --tag v0.8.16 --check-only` 与 `git diff --check` 通过；以 `git ls-files '*.md'` 全量受管 Markdown（含本方案与归档／PR 模板共 **149 份**）实测，共 **493 个本地链接**（含图片与页内引用）、**17 个 `#章节锚点`**，`broken_files=0`、`broken_anchors=0`；残留时效词反查仅保留规则举例、真正未实施项及明确的历史版本／升级说明。未覆盖外部 URL、全量代码符号静态映射，未重跑功能／设备验收、核验历史发布产物或当前部署，不能将静态检查通过视为全部文档语义均已验证。`AGENTS.md`／`DESIGN.md` 规范修改已独立提交；在 PR #137 合并前保持 `已实施` 状态，不提前标为已交付。

复现链接与锚点统计命令（在仓库根目录执行）：

```sh
python3 - <<'PY'
import re, subprocess, unicodedata
from pathlib import Path
from urllib.parse import unquote

root = Path.cwd()
files = sorted(subprocess.check_output(["git", "ls-files", "*.md"], cwd=root, text=True).splitlines())

def slug(h):
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", h)
    s = re.sub(r"[`*_~]", "", s).strip().lower()
    return "".join("-" if c in (" ", "-") else c for c in s if c in (" ", "-", "_") or unicodedata.category(c)[0] in ("L", "N"))

def anchors(p):
    out, seen, fence = set(), {}, False
    for line in p.read_text(encoding="utf-8").splitlines():
        if re.match(r"^\s*(`{3,}|~{3,})", line):
            fence = not fence; continue
        if fence: continue
        m = re.match(r"^#{1,6}\s+(.+?)\s*$", line)
        if m:
            s = slug(m.group(1))
            seen[s] = seen.get(s, -1) + 1
            out.add(s if seen[s] == 0 else f"{s}-{seen[s]}")
    return out

total_links = anchor_links = broken_files = broken_anchors = 0
for rel in files:
    md, fence = root / rel, False
    for line in md.read_text(encoding="utf-8").splitlines():
        if re.match(r"^\s*(`{3,}|~{3,})", line):
            fence = not fence; continue
        if fence: continue
        for m in re.finditer(r"!?\[[^\]]*\]\(([^)]+)\)", re.sub(r"`[^`]*`", "", line)):
            raw = m.group(1).strip().split()[0]
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", raw) and not raw.startswith("file://"):
                continue
            total_links += 1
            raw_path = unquote(raw[7:] if raw.startswith("file://") else raw)
            path_part, sep, frag = raw_path.partition("#")
            target = Path(path_part) if raw.startswith("file://") else ((md.parent / path_part).resolve() if path_part else md.resolve())
            if not target.exists():
                broken_files += 1
            elif sep and frag and target.suffix.lower() == ".md" and not re.match(r"^L\d+", frag):
                anchor_links += 1
                a = anchors(target)
                if frag.lower() not in a and slug(frag) not in a:
                    broken_anchors += 1

print(f"files={len(files)} total_links={total_links} anchor_links={anchor_links} broken_files={broken_files} broken_anchors={broken_anchors}")
PY
```
