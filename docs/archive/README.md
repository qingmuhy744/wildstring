# 归档文档

这里保存已完成、已被取代或被否决的方案、审计与调研记录。它们保留当时的决策依据和验收过程，**不代表当前实现**。现行状态见 [范围变更记录](../product/scope-history.md)、[产品范围](../product/scope.md) 与 `docs/releases/`。

## 一次性的审计与调研

| 文档 | 内容 | 对应版本 |
| --- | --- | --- |
| [Web UI 审计](web-ui-audit-2026-11-07.md) | 2026-11-07 的 Web 界面问题清单 | 0.8.7 |
| [Web 导航与设置审计](web-navigation-and-settings-audit.md) | 内容侧栏、分层设置与管理中心的改造记录 | 0.8.3（正式发布见 0.8.4） |
| [播放器审计](2026-11-07-player-audit.md) | 播放页视觉与控制的问题清单 | 0.8.7 |
| [CodeQL 0.8.0 逐条审查](codeql-0.8.0-review.md) | 告警逐条处置与误报依据 | 0.8.0 |
| [多用户设置检查](multi-user-settings-audit.md) | 账号隔离与个人偏好的检查记录 | 0.8.0 |
| [数据源样本核对](../research/metadata-source-sample-shanshui-zhijian.md) | MusicBrainz、CAA、酷狗、Shazam 的字段比对 | 元数据自动化开工前 |
| [Navidrome 参考](../research/navidrome-reference.md) | 同类自托管播放器的参考记录 | 开工前 |
| [原始讨论](../research/2026-10-15-original-discussion.txt) | 用户提供的历史讨论原文 | 开工前 |

## 已交付的批次方案

| 文档 | 内容 | 交付版本 |
| --- | --- | --- |
| [元数据刷新与指纹识别](metadata-refresh-0.2.3.md) | AcoustID 指纹、手动刷新与来源优先级 | 0.2.3（并入 0.3.0） |
| [播放页样式](player-styles-0.2.3.md) | 封面、黑胶、磁带三种样式 | 0.2.3（并入 0.3.0） |
| [手机使用闭环](mobile-completion-0.3.0.md) | Android 与 Web 的功能补齐 | 0.3.0 |
| [连续浏览与专辑布局](library-browsing.md) | 连续滚动、首字母索引、碟号布局 | 0.3.3 |
| [MCP 整理与下载导入](mcp-download-import-0.5.7.md) | MCP 整理草案与下载导入 | 0.5.7 |
| [Android 第一版](android-v1.md) | 原生首版的工程与验收 | 0.1.0 |
| [AI 助手、MCP、诊断与通知计划](agent-mcp-observability-notifications-plan.md) | 0.4.0 起的助手、MCP 与通知阶段计划 | 0.4.0–0.5.x |

## 已过时的说明

这些文件保留当时的写法，不再随代码更新。现行命令见 [开发与本地部署](../development.md) 和 `Makefile`，现行 schema 见 `backend/src/wildstring/database.py` 的 `SCHEMA_VERSION`，现行行为见 `contracts/`。

| 文档 | 内容 | 说明 |
| --- | --- | --- |
| [组件分工](components.md) | 后端与客户端的模块清单 | 表内 schema 停在 53 |
| [播客收音机试用](podcast-radio.md) | 收音机视觉与旧续播规则 | 续播规则已由播客队列契约取代 |
| [开发与本地部署](development.md) | 本地部署与检查命令长文 | uv 版本已过时 |
