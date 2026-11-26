状态：已实施

# 本地 CodeQL 检查

本地入口复用 CI 查询配置和语言矩阵，按需运行 Java/Kotlin 构建，数据库和 SARIF 写入忽略的缓存目录。

验收覆盖语言矩阵、SARIF 摘要、缺少 CLI 的提示，以及默认语言的端到端扫描。

CodeQL 2.27.6 默认三语言扫描耗时约 70 秒。Python 报告 24 条既有告警，JavaScript/TypeScript 与 Actions 各为零。CLI 接受 CI 使用的 JavaScript/TypeScript 和 Java/Kotlin 语言名。
