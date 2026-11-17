状态：已实施

# 固定 Android Dev 签名

## 目标

- 同一仓库后续 Dev APK 使用同一张证书，支持保留本机数据覆盖安装。
- Dev 与正式版维持独立包名和独立签名；签名私钥不进入源码、构建缓存和附件。

## 不碰的边界

- 不改正式版密钥、应用版本、产品 UI、播放逻辑或服务器。
- 普通 PR 不启动模拟器；不使用 `pull_request_target` 给外部分支暴露密钥。
- 已丢失随机签名私钥的旧 Dev 包不能无损换成新签名；迁移需卸载旧 Dev 一次，之后保持签名连续。

## 方案

- 新建独立 Dev 密钥，在主工作区忽略文件与 GitHub Actions 专用 secret 中保存；公开证书 SHA-256 单独纳入源码。
- Gradle 用可选 `ANDROID_DEV_KEYSTORE_PATH` 指定 Debug 与测试 APK 的签名，本地默认调试构建仍可独立执行。
- 同仓库受信任构建恢复固定 Dev 私钥并校验证书；Fork / Dependabot 无 secret 时照常构建和测试，不发布随机签名的可安装 Dev 附件。
- APK 发布到 Actions 附件前验证实际签名；正式 Release 调用 Android 验证工作流时只传入 Dev secret，不传正式私钥。
- 保留既有模拟器触发策略，临时私钥在任务结束时删除。

## 验收

- 按构建／分发的 L3 影响面检查；本轮没有应用 UI 改动，不以签名检查代替正式发版或完整 UI 矩阵验收。
- 构建／签名专项：`make check`、Android CI 构建与检查，Gradle 实际选择签名文件；两份独立构建的 Dev APK 证书一致，`adb install -r` 可覆盖并保留测试数据。
- 错误证书不允许作为稳定 Dev 包上传；Fork 无 secret 的验证路径不发布安装包。
- 仅检查合成模拟器数据，不卸载用户手机上的应用；无 UI 改动，不以本轮签名验证代替完整播放器和全端验收。

## 风险与回滚

- 固定签名一旦使用就需长期备份；不要通过清缓存或轮换 secret 解决构建问题。
- 工作流回滚会恢复随机签名问题；正式签名配置保持独立。

## 验证记录（2026-11-17）

- `actionlint` 与 `make check` 通过，`ANDROID_DEV_KEYSTORE_PATH` 指向专用密钥时 `make android-ci` 通过，包含 JVM、设备源码编译、Debug / Release 构建与 lint。
- `make ci PYTEST_ARGS='-n 4'` 通过：后端 908 项通过、2 项按环境条件跳过，Web 八组实际通过 334 / 160 / 6 / 18 / 2 / 12 / 2 / 4 项，合计 538 项；锁文件检查与依赖审计通过。没有将此记为正式发布门禁或全端真机 UAT 通过。
- 实际执行工作流中的密钥准备代码：正确输入成功并以 0600 写入；缺失、无效 Base64、错误证书指纹均失败且不会输出 `configured=true`。
- 在隔离附件目录实际执行发布前校验步骤，APK 证书与固定指纹一致，APK 和公开证书指纹文件的 `SHA256SUMS` 均匹配。
- 将同一 Dev 密钥复制到不同的临时路径，分别实际构建 APK，证书指纹一致。Phone 上先确认旧签名不能直接替换，再只清理合成模拟器中的旧 Dev 安装；固定签名的第一份 APK 写入应用私有测试标记，第二份 APK 增加验证资产并重新签名后通过 `adb install -r` 覆盖。安装后的 APK 已包含新资产，私有测试标记保持原值，证明更新实际生效且保留数据。
- 公开证书指纹随源码保存，私钥备份仅位于被忽略的 `.env.android-dev.keystore`；验证记录位于本地 `artifacts/android-dev-signing/verification.json`，不提交 APK 或密钥。
- 专用 Actions secret 已按用户授权配置；远端安装包必须在上传前通过固定证书校验，实际构建结果见 [PR #165 的检查记录](https://github.com/qingmuhy744/wildstring/pull/165/checks)。没有触发正式 Release，也未修改或读取正式签名私钥。
