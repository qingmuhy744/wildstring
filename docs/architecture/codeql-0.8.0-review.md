# 0.8.0 CodeQL 告警逐条审查

审查基线：`feat/podcast-player-0.8.0` 的 `72a6e42ed7f5270de5abe6d0736e8a58f59dc1b2`，48 条 open 告警。下表记录原始位置与处理决定；是否已由复扫关闭、单条处置成功，以及 CI 是否通过，必须与对应提交的远程结果分别核对。

本轮通过代码调整处理 31 条；6 条路径提示按业务与权限边界判定误报；11 条 Dagger/Hilt 自动生成代码提示无需手工改写，采用单条 `won't fix` 并说明生成器约束。保留 `security-and-quality` 查询集和现有扫描范围，不新增规则排除，不编辑构建生成文件，也不将“告警已处置”称作“原始 SARIF 无结果”。

## 代码调整（31 条）

库上下文、权限计算和设置解析移至 `library/scope.py`，schema 36 的 SQL 移至 `library/catalog_schema.py`。移动前后定义的 AST 核对一致；数据库、仓储、扫描和存储不再反向导入目录管理服务。数据库保持 schema 37，无新增数据迁移。

| 告警 | 规则 | 原始位置 | 调整与核对 |
| --- | --- | --- | --- |
| [#113](https://github.com/qingmuhy744/wildstring/security/code-scanning/113) | `js/unused-local-variable` | `frontend/web/src/now-playing.tsx:2` | 移除未使用的 artist 导入，播放信息仍使用现有展示组件。 |
| [#115](https://github.com/qingmuhy744/wildstring/security/code-scanning/115) | `java/local-variable-is-never-read` | `frontend/android/app/src/main/java/com/wildstring/app/ui/LyricViewport.kt:59` | 移除未使用的 CoroutineScope 与 launch 导入；歌词跟随和手势协程保留。 |
| [#116](https://github.com/qingmuhy744/wildstring/security/code-scanning/116) | `js/unused-local-variable` | `frontend/web/src/metadata-review.tsx:291` | 移除未被任何控件调用的 nextAlbum 函数；实际逐项/专辑处理流程保留。 |
| [#152](https://github.com/qingmuhy744/wildstring/security/code-scanning/152) | `js/missing-await` | `frontend/web/src/podcast-progress.ts:205` | 原比较用于判断同一个 Promise 的身份，发送操作本身已 await。改为比较任务记录身份，并 await 记录中的 promise，保留串行与防重语义。 |
| [#159](https://github.com/qingmuhy744/wildstring/security/code-scanning/159) | `py/cyclic-import` | `backend/src/wildstring/library/catalog.py:437` | 目录管理依赖存储；其反向上下文依赖移至 scope，迁移 SQL 移至 catalog_schema，调用链改为单向。 |
| [#160](https://github.com/qingmuhy744/wildstring/security/code-scanning/160) | `py/cyclic-import` | `backend/src/wildstring/library/catalog.py:548` | 迁移路由复用同一单向依赖链；Storage/输入模型改为明确的模块导入。 |
| [#161](https://github.com/qingmuhy744/wildstring/security/code-scanning/161) | `py/cyclic-import` | `backend/src/wildstring/database.py:372` | 数据库连接的 configure_scope 改为依赖独立 scope 模块。 |
| [#162](https://github.com/qingmuhy744/wildstring/security/code-scanning/162) | `py/cyclic-import` | `backend/src/wildstring/library/import_files.py:12` | 安全复制继续依赖扫描的文件访问原语；扫描不再反向导入目录管理。 |
| [#163](https://github.com/qingmuhy744/wildstring/security/code-scanning/163) | `py/cyclic-import` | `backend/src/wildstring/library/repository.py:9` | 仓储继续使用 Database；Database 的迁移/上下文不再反向依赖目录管理服务。 |
| [#164](https://github.com/qingmuhy744/wildstring/security/code-scanning/164) | `py/cyclic-import` | `backend/src/wildstring/library/repository.py:13` | current_library 改为从独立 scope 导入，保留同一个请求上下文。 |
| [#165](https://github.com/qingmuhy744/wildstring/security/code-scanning/165) | `py/cyclic-import` | `backend/src/wildstring/library/repository.py:102` | allowed_ids 改为从独立 scope 导入，库授权逻辑原样移动。 |
| [#166](https://github.com/qingmuhy744/wildstring/security/code-scanning/166) | `py/cyclic-import` | `backend/src/wildstring/library/repository.py:106` | library_for_root 改为依赖 scope，保留迁移后的旧根目录映射。 |
| [#167](https://github.com/qingmuhy744/wildstring/security/code-scanning/167) | `py/cyclic-import` | `backend/src/wildstring/library/repository.py:124` | 仓储创建/查找库身份改用 scope 中的同一映射函数。 |
| [#168](https://github.com/qingmuhy744/wildstring/security/code-scanning/168) | `py/cyclic-import` | `backend/src/wildstring/library/scanner.py:12` | 扫描继续依赖数据库；数据库迁移改为依赖纯 SQL 模块。 |
| [#169](https://github.com/qingmuhy744/wildstring/security/code-scanning/169) | `py/cyclic-import` | `backend/src/wildstring/library/scanner.py:14` | 扫描继续依赖仓储；仓储授权和身份查询不再导入目录管理服务。 |
| [#170](https://github.com/qingmuhy744/wildstring/security/code-scanning/170) | `py/cyclic-import` | `backend/src/wildstring/library/scanner.py:83` | 扫描设置解析改从 scope 导入，保留选择库与来源的逻辑。 |
| [#171](https://github.com/qingmuhy744/wildstring/security/code-scanning/171) | `py/cyclic-import` | `backend/src/wildstring/library/scanner.py:123` | 逐文件权限复核改从 scope 导入，保留撤权后的拒绝行为。 |
| [#172](https://github.com/qingmuhy744/wildstring/security/code-scanning/172) | `py/cyclic-import` | `backend/src/wildstring/library/storage.py:15` | 存储仍复用独占复制逻辑；复制/扫描/仓储的反向目录依赖已拆除。 |
| [#173](https://github.com/qingmuhy744/wildstring/security/code-scanning/173) | `py/cyclic-import` | `backend/src/wildstring/library/storage.py:16` | 存储仍复用无符号链接跟随的读取函数；扫描的上下文依赖已拆除。 |
| [#174](https://github.com/qingmuhy744/wildstring/security/code-scanning/174) | `py/mixed-returns` | `backend/src/wildstring/management.py:755` | 管理任务执行器显式声明返回 None，调用 execute_scoped 后正常结束；异常分支行为保持一致。 |
| [#175](https://github.com/qingmuhy744/wildstring/security/code-scanning/175) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:75` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#176](https://github.com/qingmuhy744/wildstring/security/code-scanning/176) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:76` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#177](https://github.com/qingmuhy744/wildstring/security/code-scanning/177) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:127` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#178](https://github.com/qingmuhy744/wildstring/security/code-scanning/178) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:139` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#179](https://github.com/qingmuhy744/wildstring/security/code-scanning/179) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:165` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#180](https://github.com/qingmuhy744/wildstring/security/code-scanning/180) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:228` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#181](https://github.com/qingmuhy744/wildstring/security/code-scanning/181) | `py/side-effect-in-assert` | `backend/tests/test_podcast_progress.py:287` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#182](https://github.com/qingmuhy744/wildstring/security/code-scanning/182) | `py/side-effect-in-assert` | `backend/tests/test_storage_resources.py:68` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#183](https://github.com/qingmuhy744/wildstring/security/code-scanning/183) | `py/side-effect-in-assert` | `backend/tests/test_storage_resources.py:72` | 先执行 HTTP 写入并保存响应，再断言结果；同文件中的其他写入/清理也移出 assert，优化模式不会跳过操作。 |
| [#184](https://github.com/qingmuhy744/wildstring/security/code-scanning/184) | `py/empty-except` | `backend/src/wildstring/podcast_resources.py:70` | 缓存文件失效或不可读时明确返回 None，并注明按缓存未命中处理、允许重新下载的原因。 |
| [#185](https://github.com/qingmuhy744/wildstring/security/code-scanning/185) | `java/confusing-method-name` | `frontend/android/app/src/main/java/com/wildstring/app/ui/PodcastArticle.kt:55` | 区分 Compose 组件与文本构建函数：后者改名为 buildPodcastArticleText，并同步文章安全/时间码测试。 |

## 受控托管目录（6 条误报）

已检查 Python SARIF analysis `2022020151` 的全部 6 个结果及其数据流：均从 `POST /api/v1/libraries/{identity}/migrations` 的 `MigrationInput` 进入 `LibraryStorage.destination`，终点是路径规范化、存在性、目录类型或可写性检查。它们不是把普通用户提供的媒体文件名拼到固定根目录的场景。

产品明确允许**实例所有者选择容器内已挂载的绝对托管目录**，因此不能把所有目标限制在默认运行目录内。误报判断依赖以下实际约束，而非仅依赖 `resolve()`：

- 新建库与提交/重试迁移均要求已认证的 `owner`，写入同时要求客户端标识；听众、编辑员和曲库管理员即使有该库权限，也不能进入目标目录探测。
- 路径先要求绝对路径并规范化，再排除运行数据的非托管区域、播客缓存、网页目录、其他库、导入来源以及迁移保留/预留路径的交叉；目标须为空且可写。符号链接别名会按真实目标校验。
- 执行迁移时再次检查创建者仍启用且仍为所有者；POSIX 复制沿用目录描述符、`O_NOFOLLOW`、独占发布、内容哈希校验与原副本保留。
- `test_storage_routes_authorize_before_probing_owner_selected_paths` 覆盖匿名、3 种非所有者档案、缺少客户端标识；拒绝时不得调用目标探测，也不得创建目标或迁移任务。`test_storage_resolves_aliases_before_rejecting_reserved_roots` 覆盖 5 类保留目录的符号链接别名。`test_migration_rechecks_owner_before_touching_files` 覆盖账号降权和禁用。
- 既有 `test_custom_storage_watch_pause_and_verified_migration` 验证运行目录外的合法托管根、完整复制、稳定 ID 和重启；`test_storage_rejects_overlap_nonempty_paths_and_direct_root_changes` 验证相对路径、交叉目录、非空目录与直接改根被拒绝。

逐条以 `false positive` 记录以上授权/用途依据，保持路径规则启用。如果未来向非所有者开放此入口、将任意来源的路径送入该函数，或改变保留目录和复制约束，必须重新审查这些处置。

| 告警 | 原始位置 | 实际探测 | 处置原因 |
| --- | --- | --- | --- |
| [#153](https://github.com/qingmuhy744/wildstring/security/code-scanning/153) | `backend/src/wildstring/library/storage.py:71:22` | `Path(value).resolve()` | 仅所有者选择服务端托管根；由前述权限、规范化、保留目录和安全复制约束保护。 |
| [#154](https://github.com/qingmuhy744/wildstring/security/code-scanning/154) | `backend/src/wildstring/library/storage.py:86:16` | `target.exists()` | 仅所有者选择服务端托管根；由前述权限、规范化、保留目录和安全复制约束保护。 |
| [#155](https://github.com/qingmuhy744/wildstring/security/code-scanning/155) | `backend/src/wildstring/library/storage.py:86:41` | `target.is_dir()` | 仅所有者选择服务端托管根；由前述权限、规范化、保留目录和安全复制约束保护。 |
| [#156](https://github.com/qingmuhy744/wildstring/security/code-scanning/156) | `backend/src/wildstring/library/storage.py:89:23` | `parent.exists()` | 仅所有者选择服务端托管根；由前述权限、规范化、保留目录和安全复制约束保护。 |
| [#157](https://github.com/qingmuhy744/wildstring/security/code-scanning/157) | `backend/src/wildstring/library/storage.py:91:20` | `parent.is_dir()` | 仅所有者选择服务端托管根；由前述权限、规范化、保留目录和安全复制约束保护。 |
| [#158](https://github.com/qingmuhy744/wildstring/security/code-scanning/158) | `backend/src/wildstring/library/storage.py:91:53` | `os.access(parent, W_OK | X_OK)` | 仅所有者选择服务端托管根；由前述权限、规范化、保留目录和安全复制约束保护。 |

## Dagger/Hilt 生成代码（11 条无需手改）

原始位置均在未跟踪的 `frontend/android/app/build/generated/ksp/debug/java/com/wildstring/app/`。已检查 `@DaggerGenerated`、`@Generated` 标记、组件构造器/初始化函数和生成注入接口：参数由 Hilt 组件/工厂协议和代码生成器定义，某些组件无对应绑定或字段注入时会不使用这些参数。手工删除参数既不持久，也会脱离生成器的接口约束；无需新增无意义绑定或升级整套工具链来改变生成代码。

本轮保留手写代码的未使用参数检查，对这些具体告警用 `won't fix` 写明生成来源、参数与接口约束。重建、Lint、DI 启动和模拟器回归负责验证实际注入行为；若同类告警出现在手写源代码，不能套用此处的生成代码理由。

| 告警 | 生成文件 | 参数 | 处置依据 |
| --- | --- | --- | --- |
| [#141](https://github.com/qingmuhy744/wildstring/security/code-scanning/141) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:373` | `activityParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#142](https://github.com/qingmuhy744/wildstring/security/code-scanning/142) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:327` | `fragmentParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#143](https://github.com/qingmuhy744/wildstring/security/code-scanning/143) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:536` | `serviceParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#144](https://github.com/qingmuhy744/wildstring/security/code-scanning/144) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:356` | `viewParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#145](https://github.com/qingmuhy744/wildstring/security/code-scanning/145) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:307` | `viewParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#146](https://github.com/qingmuhy744/wildstring/security/code-scanning/146) | `MainActivity_GeneratedInjector.java:16` | `mainActivity` | 生成的注入接口，参数属于实现方法签名。 |
| [#147](https://github.com/qingmuhy744/wildstring/security/code-scanning/147) | `WildStringApplication_GeneratedInjector.java:16` | `wildStringApplication` | 生成的注入接口，参数属于实现方法签名。 |
| [#148](https://github.com/qingmuhy744/wildstring/security/code-scanning/148) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:429` | `savedStateHandleParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#149](https://github.com/qingmuhy744/wildstring/security/code-scanning/149) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:430` | `viewModelLifecycleParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#150](https://github.com/qingmuhy744/wildstring/security/code-scanning/150) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:490` | `savedStateHandleHolderParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |
| [#151](https://github.com/qingmuhy744/wildstring/security/code-scanning/151) | `DaggerWildStringApplication_HiltComponents_SingletonC.java:612` | `applicationContextModuleParam` | 生成器统一的组件构造/初始化参数，该组件没有使用此绑定。 |

## 验证与远程处置

提交前本地后端 584 项通过、1 项因缺少 Chromaprint 跳过；8 项新增权限/别名/执行复核全部通过。播客进度的桌面/手机 10 项专项、Android 单元/测试编译及 Debug/Release 构建与 Lint 通过。独立容器冒烟和既有 Postman 集合的 35 个请求、54 个断言通过；未绑定或发布云端工作区，测试容器停止后保留其隔离卷。完整网页套件与远程验证分别核对。

改动后执行项目检查、库授权/进度/迁移专项、完整后端与网页回归、Android 单元/编译/构建/Lint；远程继续核对 CI、Android 模拟器与四语言 CodeQL。误报及生成代码原因同步写入相应 GitHub 告警的单条处置评论。默认分支的修复状态不能从本开发分支推断；本轮不合并、不部署。

核对依据包括[循环依赖规则说明](https://codeql.github.com/codeql-query-help/python/py-cyclic-import/)、[路径访问规则说明](https://codeql.github.com/codeql-query-help/python/py-path-injection/)和[单条告警处置接口](https://docs.github.com/en/rest/code-scanning/code-scanning#update-a-code-scanning-alert)。路径误报结论来自本项目的调用链、权限测试和产品契约，属于本轮代码审查判断。
