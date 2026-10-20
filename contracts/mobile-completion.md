# 0.3.0 手机使用闭环（开发契约）

用户已确认 Android＋Web 完成此前清单中除上传外的能力，并包含每日推荐；版本为 0.3.0。iOS 原生、车载、小组件不在本批。现有 0.2.3 未发布内容一并进入本版。本文描述验收目标，实际实现与验证逐项记录在产品说明中。

## 新增接口约定

以下路径相对 `/api/v1`；登录、账号隔离、曲库权限和 `X-Wildstring-Client` 与现有接口一致。普通用户不能调用 `/manage`。离线保存不改变导入源或托管音频。

- `GET /playback/state`：本用户最近共享播放快照。初始 version=0，空 track_ids，index=0、position_ms=0、mode=sequential。响应包含 version、device_id、track_ids、index、position_ms、mode、updated_at；不返回其他用户状态。
- `PUT /playback/state`：`{version, device_id, track_ids, index, position_ms, mode, playback_state?}`；mode 为 sequential/repeat_all/repeat_one/shuffle；playback_state 为 playing/paused/ended/unknown，省略时为 unknown。只允许真实、可用、本曲库 ID；最多 10000 首，版本冲突 409。服务器管理 `paused_at`，拒绝客户端发送该字段以及 handoff_eligible/handoff_supported 等只读字段。响应额外提供 `playback_state, paused_at, handoff_supported:true, handoff_eligible`；仅服务器最近 30 分钟内的 paused 记录和非空可用队列返回 handoff_eligible=true。同设备连续暂停保存保留 paused_at，恢复播放则清空，不能用普通更新时间推断暂停。旧记录迁移为 unknown；旧快照可手动载入。新客户端对旧服务端省略新增写入字段，且不根据旧协议记录触发提示；两端不自动控制另一台设备。
- `GET /recommendations/daily`：当前用户以 Asia/Shanghai（UTC+8）日界计算的当日推荐，返回 `{id,date,items:[{track,reason}],engine}`。同日缓存稳定，曲目仅来自本曲库，可用 ID 去重；小曲库自动减少数量。
- `POST /recommendations/daily/refresh`：主动换一批，与普通变更请求校验一致。请求可为空对象。
- `GET/PUT /recommendations/preferences`：`{version,use_ai,use_lastfm,count}`，默认 AI 和外部相似查询关闭、count=20（范围 1–50）、初始 version=1。修改偏好保留已生成的当日集合，主动换批才重新生成；读取时剔除失效或明确不感兴趣的歌曲。engine 为 local、ai、local+lastfm 或 ai+lastfm。外部增强失效时继续提供本地推荐；密钥只由管理员在现有设置中配置。
- `POST /recommendations/feedback`：`{event_id,track_id,action}`；action 为 dismiss_track/less_artist/accept/skip/complete。UUID 事件幂等，网络失败不当作主动跳过。不修改歌曲文件、收藏或其他用户偏好。
- `POST /ai/discover`：`{prompt,limit}`，返回 `{title,items:[{track,reason}],mode,warning?}`，mode=ai/local。大模型最多接收 80 个本地候选的标题、艺人、专辑、日期、词曲编角色、类型、时长、收藏与播放次数；不发送路径、歌词、音频或账号身份。大模型仅从有界本地候选中选择，服务端校验 ID；无法使用模型时明确返回本地回退。预览不会建立歌单，保存复用现有普通歌单接口。

接口字段确需调整时，先通知其他实现者并更新本文，避免各端自行猜测。

- `GET /manage/providers/suggestions/{id}/cover-preview`：管理员同源预览 CAA 候选封面，复用服务端代理与 URL 白名单，返回有尺寸限制的 JPEG；`private,no-store`，不应用建议、不修改音频、封面选择或元数据版本。

## 客户端验收范围

- Android：普通歌单改名、删除、移除与拖动排序，规则歌单创建与编辑；元数据编辑、联网刷新与建议确认、封面候选；歌词编辑与逐行打点；导入/扫描/待整理/任务入口；创作人角色浏览、收听统计及排序。
- Web：播放队列与位置恢复，循环和随机；与 Android 一致的整集合连续播放、睡眠定时、离线保存、AI 找歌与歌单预览、每日推荐及反馈、跨设备继续。
- 播放整个歌单／专辑时包含分页后的完整集合；大曲库有显式上限或继续补页，不能以“全部”名义悄悄只播放本页。失败保留当前播放与队列。
- 睡眠定时支持分钟数和播完本曲停止；重置、取消及后台暂停行为明确。
- 完整离线保存与最近播放片段缓存分开；显示下载状态、容量与失败，可暂停/继续或重试和删除；断网可浏览及播放已完成内容；退出或换账号清除私密内容；在线遇到权限撤销时失效处理。浏览器离线壳仅缓存静态资源，不让 Service Worker 缓存通用认证 API。
- 所有变更先即时反馈，失败恢复或明确保留待重试状态，重复点击不重复提交。元数据建议确认后应用，管理入口只向管理员展示。
