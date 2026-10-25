# 库存储、迁移与播客共享资源

本轮契约，schema 37；验证状态单独记录在 0.8.0 发布说明。重管理只在网页开放，Android 保留消费、库选择和有权限的轻量资料修改。

## 库配置

原有 `source_roots` 保持兼容；新增 `paused_source_roots`（省略则保留原状态）和新建库可选的 `managed_root`。源为现存的只读绝对目录；托管目录可写且独立，禁止库间、与来源及运行数据目录交叉。更新已存在库的托管路径返回 409 `library_migration_required`。

所有者通过 `POST /api/v1/libraries/{id}/migrations` 提交 `{version,managed_root}`，GET 同一路径查看进度。任务持久化，复制全部文件、校验内容和源文件稳定性后，原子切换库根目录与导入清单；保留库、曲目、歌单和进度 ID，并保留旧文件。失败保留原库与已复制文件，支持 `POST /migrations/{job_id}/retry`。目标目录须为空或属于该任务，不能覆盖已有不同内容。迁移与导入/扫描共用锁，重启恢复未完成任务。

网页集中配置每库自动导入开关、检查间隔和文件稳定等待时间；每个来源可单独暂停自动监听，手动导入仍可使用。审批和重试保留实际来源；当前导入忙碌时，显式审批的后续任务持久排队，按顺序执行。

## 播客保存和复用

`POST /api/v1/podcasts/episodes/{id}/download` 改为登录用户保存共享音频；重复保存幂等。现存有效文件返回 `{id,status:"reused",saved:true,reused:true}`；否则建立个人引用并复用/创建单一下载任务。普通听众也可保存。`DELETE` 同路径只释放本人引用，不直接删文件。单集响应增加 `resource_saved`。关注、进度和手动保存彼此独立，听完/取关不释放手动引用。

引用数从唯一的 `(user_id,episode_id)` 关系计算。旧音频加历史保护标记，清理默认关闭；不自动为所有用户建立引用。

## 共享音频管理

仅所有者通过 `/api/v1/podcasts/resources` 分页查看资源、引用数、磁盘占用和保护状态；`GET/PUT /resources/settings` 采用版本校验，配置是否自动清理和零引用保留天数。`PUT /resources/{id}/protection` 显式修改历史保护。

`POST /resources/cleanup` 接收 `{dry_run:true|false,podcast_id?:id}`，默认只预览；自动清理遵守保留期限，显式手动清理允许立即清零引用文件。清理在事务内重新核对引用、保护、下载状态和播放/传输租约；共享同一路径的其他资源也受保护。新增保存与清理串行化，不能把他人新建立的引用对应文件删掉。文件实际删除失败不清空登记。进行中的下载与播放不回收。

安卓个人保存使用同一接口，复用时提示“已复用服务器已有音频，无需重复下载”。手机离线副本仍需独立传输。网页保留全量下载、共享节目删除、资源清理和存储策略；安卓移除上述重管理入口。

本地接口回归另保留 [Postman 集合](checks/storage-resources.postman_collection.json)，仅允许访问本机隔离服务，并在执行写入前校验 `Storage Resource Fixture` 标记；需要预置 `storage-resource-shared` 与受保护的 `storage-resource-legacy` 测试音频。使用临时测试凭据、`--report-events=false` 执行，不绑定或发布云端工作区。
