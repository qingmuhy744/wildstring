# GitHub Security and quality

本仓库为个人账号下的公开仓库，使用当前账号可用的 GitHub 安全功能。扫描结果查看 [Security and quality](https://github.com/qingmuhy744/wildstring/security)，漏洞通过 [私密报告入口](https://github.com/qingmuhy744/wildstring/security/advisories/new) 提交，披露约定见 [SECURITY.md](../../SECURITY.md)。

## 持续检查

| 能力 | 配置与范围 |
| --- | --- |
| CodeQL | `codeql.yml` 使用高级配置，分析 Python、JavaScript／TypeScript、Java／Kotlin 与 GitHub Actions；运行 `security-and-quality` 规则，覆盖扩展安全规则和可靠性、可维护性问题 |
| Kotlin 提取 | `make android-codeql` 在 JDK 21、Android SDK 36.1 下实际编译 debug；关闭增量与构建缓存，避免编译缓存导致未提取 Kotlin |
| 依赖审查 | 每个 PR 运行 `dependency-review.yml`；新引入高危及严重依赖漏洞时失败，不自动忽略已有告警或授权自动合并 |
| Dependabot | 告警与自动安全更新在仓库设置启用；`dependabot.yml` 每周检查 uv、两处 npm、Gradle、Actions 和 Docker，常规更新分组后生成 PR |
| Android 依赖图 | `dependency-submission.yml` 在主分支推送、每周和手动触发时解析 Gradle 传递依赖并提交 GitHub；PR 不执行带写权限的依赖提交 |
| 密钥保护 | 使用 GitHub 密钥扫描和推送保护；本地 hooks 另检查私钥。不会在日志中打印密钥或自动关闭告警 |
| 现有质量检查 | Ruff、Bandit、类型检查、网页与 Android 测试继续由原 CI 执行 |

CodeQL 在主分支推送、PR、每周和手动触发时运行。工作流使用固定提交的官方 Action，最小化权限，不使用 `pull_request_target` 执行 PR 代码，不读取签名或生产凭据。依赖更新仍需通过普通审查和检查；Android 锁文件与校验元数据需要同步维护，必要时运行 `make android-locks`。

社区插件上游使用固定提交的源码归档；GitHub 对这些归档的版本更新支持取决于包管理器，不能把 Dependabot 已启用等同于会自动跟踪上游最新提交。插件维护者继续负责更新提交、锁文件、格式适配和随包许可证。

## 套餐与计费边界

- 独立的 **GitHub Code Quality** 产品需要 GitHub Team／Enterprise Cloud；当前仓库 API 返回不可用。免费 CodeQL 的 `security-and-quality` 规则不等同于该产品的 AI 面板和覆盖率功能。见 [Code Quality 启用条件](https://docs.github.com/en/code-security/how-tos/maintain-quality-code/enable-code-quality)。
- 通用模式密钥扫描、有效性检查及扩展元数据检查有组织账号和 Secret Protection 等资格要求。当前个人仓库的通用模式与有效性状态仍为关闭，不能把 API 请求成功当成实际启用。见 [通用模式](https://docs.github.com/en/code-security/how-tos/secure-your-secrets/detect-secret-leaks/enabling-secret-scanning-for-generic-patterns) 与 [有效性检查](https://docs.github.com/en/enterprise-cloud%40latest/code-security/how-tos/secure-your-secrets/customize-leak-detection/enable-validity-checks)。
- **AI Scan／Agentic Autofix** 会消耗 Code Security AI Credits，公开仓库也可能产生计费；本配置不启用这两项、不购买套餐、不调整计费预算。经典 Copilot Autofix 的建议与 Agentic Autofix 是不同功能。见 [计费规则](https://docs.github.com/en/billing/concepts/product-billing/github-advanced-security)。

## 启用与验收

工作流文件必须合入默认分支，定时扫描、Dependabot 版本更新与 Android 依赖提交才算正式生效。第一次扫描完成后核验 GitHub 上报的分析语言和提交，确认不是仅保存了 YAML；主分支合并规则应要求扫描及依赖审查通过，并阻止新引入的高危安全结果。告警是否为零和扫描是否成功分别核对，已有问题不得为追求绿色结果随意忽略。

2026-10-18 已核验主分支 `0fcaa2d` 四种语言分析均成功上报，Android 依赖图提交成功；`security-and-quality` 分支规则已启用，要求原 CI、四项语言扫描与依赖审查，并阻止新增 high／critical 安全问题和 error 级代码问题。已有扫描及依赖告警保留待审查。

本仓库使用高级工作流，默认设置 API 的 `state: not-configured` 仅表示没有启用默认设置，不能用于判断高级扫描是否运行。请查看 [CodeQL 运行记录](https://github.com/qingmuhy744/wildstring/actions/workflows/codeql.yml) 和 [Code scanning 告警](https://github.com/qingmuhy744/wildstring/security/code-scanning)。切换到默认设置会覆盖高级工作流，见 [GitHub 默认设置说明](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/configure-code-scanning/configure-code-scanning)。
