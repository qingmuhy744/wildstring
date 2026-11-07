# WildString 工作约定

- 产品定位为 AI native 的自托管音乐与播客播放器，覆盖 Python 后端及 Web、Android、macOS、iOS 客户端。
- 动手前先读 `docs/product/scope.md` 与 `DESIGN.md`。文档中的计划不代表已实现，交付时分别说明实现与验证状态。
- 文档职责：`AGENTS.md` 管工作流程与验收，`DESIGN.md` 管视觉与布局规范，产品范围与实现状态以 `docs/product/scope.md` 及其引用契约为准。发现过时条目或相互冲突时，结合当前用户要求和实际实现核对并修正文档，不选择性套用；无法确定的产品决策再向用户澄清。
- 极简架构与界面降噪：目标、架构、设计与实现保持简单。砍掉标语、空洞副标题、冗余提示文字和装饰性次要标签；如果高频页面靠解释文字才看得懂，去改布局。但必须完整保留并设计好 `Loading / Empty / Error / 权限不足` 等边界状态，报错须平静说明“原因 + 下一步操作”。
- 视觉对齐与交互质感：严格遵守 `DESIGN.md` 的色彩、字体层级与等宽数字（`tabular-nums`）；并列元素保持基线对齐，嵌套圆角遵循 `内圆角 = 外圆角 - 间距`，播放按钮等图标注意光学居中；优先用间距与表面色差代替重阴影和多余边框；动画仅限 `transform/opacity` 并遵守 `prefers-reduced-motion`。
- 布局适应：同组按钮使用布局容器和明确间距，Web 使用 flex/grid 与 `gap`，不依赖自然换行或空白字符形成间距。说明区允许收缩和换行，操作区不得被挤压到非预期折行；空间不足时按组换行。避免用固定高度撑出无意义留白，具体尺寸与断点统一维护在 `DESIGN.md`。
- 视觉验收：UI 改动必须实际渲染并逐张查看截图，检查按钮间距、对齐、非预期换行、遮挡、溢出、重复信息和异常留白，发现问题后修复并复查。构建、类型检查和自动化功能测试不能替代视觉验收；无法渲染时明确报告验证缺口，不宣称视觉验收通过。
- 覆盖与交付：按改动影响检查页面的正常、空、加载、错误和权限不足状态，并覆盖窄屏、宽屏、浅深主题及长文案。共享样式或组件改动须核对使用页面并覆盖受影响布局；走通播放、切页、返回等相关关键路径。交付列明实际验证的页面、状态及未覆盖范围，不以局部截图或功能测试代表全站通过。浏览器验收使用隔离合成曲库，不修改用户真实音乐与运行数据。
- 兼顾 UX、DX 与 AX：语义化结构、单一数据源与清晰组件边界，方便人类阅读与 Agent（及 MCP 客户端）解析修改；不靠口头承诺“不弄坏东西”，改动后必须走通关键交互路径并执行对应自动化检查。凡修改或删除 UI 文案、i18n 键值、组件结构或 API 字段，必须同步反查并更新关联测试（运行 `make check` 拦截残留旧文案断言，并用 `make test-affected` 或 `make test-affected-desktop` 跑通受影响的测试集）；编写测试时优先断言语义角色与业务状态，不绑定装饰性废话。
- Python 使用 3.12 和 `backend/uv.lock`；Web 与插件运行时使用 Node 22 与对应 `package-lock.json`；Android 使用 JDK 21；macOS / iOS 使用 XcodeGen（`project.yml`）。开发入口统一放入 `Makefile`。
- 初始化用 `make setup`，日常改动自检用 `make check` 与 `make test-affected`（或 `make test-affected-desktop`），全量检查用 `make ci`，按改动范围补充 `make android-ci`、`make macos-test`、`make ios-test` 或 `make test-native-plugin`，容器验证用 `make docker-up docker-smoke`。修改依赖后更新对应锁文件；Gradle 的 `verification-metadata.xml` 在 macOS 上生成时不含 linux 变体（如 aapt2）校验，Android 升级依赖后需从官方 Maven 补齐 linux 条目再推送。
- Python 使用 Ruff 与 Bandit；pre-commit 工具复用 uv 锁文件，不另维护一套 hook 版本。
- 导入源（如 `data/`）只读；导入时复制到应用托管曲库，并整理目录与文件名。播放、整理和未来写回只针对托管副本，不移动或修改导入源；用户修正与 AI 建议先存数据库，显式操作才写回副本标签。
- AI 工具与 MCP 操作真实曲目 ID，遵守与普通 API 相同的权限、库授权和校验。模型不可用不应阻断基础播放。
- Docker 数据放入持久卷，默认只监听宿主机回环地址。停止命令不删除数据卷。
- 凭据仅放在未跟踪的 `.env` 或 CI secrets 中，不打印令牌，不提交本地音乐、运行数据和构建缓存。
- 保留用户已有修改。提交前检查 diff、敏感信息与大文件；推送后核验远程提交和 Actions 结果。
