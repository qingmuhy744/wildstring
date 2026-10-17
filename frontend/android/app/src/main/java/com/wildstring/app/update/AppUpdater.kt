package com.wildstring.app.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.wildstring.app.BuildConfig
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class UpdatePhase { Idle, Checking, Available, Latest, Downloading, Verifying, Ready, Error, Cancelled }
data class UpdateState(val phase: UpdatePhase = UpdatePhase.Idle, val release: AppRelease? = null, val message: String? = null,
    val downloaded: Long = 0, val total: Long = 0, val checkedAt: Long = 0, val prompt: Boolean = false)

object ApkVerifier {
    @Suppress("DEPRECATION")
    private fun identity(info: PackageInfo): PackageIdentity {
        val certificates = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners?.toList().orEmpty() else info.signatures?.toList().orEmpty()
        return PackageIdentity(info.packageName, if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong(), info.versionName.orEmpty(),
            certificates.map { signature -> MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) } }.toSet())
    }
    @Suppress("DEPRECATION")
    fun installed(context: Context): PackageIdentity = identity(context.packageManager.getPackageInfo(context.packageName,
        if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES))
    @Suppress("DEPRECATION")
    fun archive(context: Context, apk: File): PackageIdentity {
        val info = context.packageManager.getPackageArchiveInfo(apk.absolutePath,
            if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES) ?: throw UpdateFailure("apk_invalid")
        return identity(info)
    }
}

/** Application-scoped and independent from music servers and user accounts. */
class AppUpdater private constructor(private val context: Context) {
    private val preferences = context.getSharedPreferences("app-updates", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val checkClient = ReleaseClient()
    private val downloadClient = ReleaseClient()
    private val mutable = MutableStateFlow(UpdateState())
    val state = mutable.asStateFlow()
    private var checking: Job? = null
    @Volatile private var downloading = false
    @Volatile private var requested: AppRelease? = null
    private val directory = File(context.cacheDir, "updates")
    private val ready = File(directory, "verified.apk")
    private var readyHash: String? = null
    init {
        // Incomplete or old APKs are not automatically installed or resumed after process death.
        directory.mkdirs(); directory.listFiles()?.forEach { it.delete() }
        val saved = preferences.getString("metadata", null)
        if (saved != null && System.currentTimeMillis() - preferences.getLong("checked", 0) < CACHE_TTL) runCatching { UpdatePolicy.release(saved) }.getOrNull()?.let { release ->
            if (runCatching { UpdatePolicy.isNewer(release.version, BuildConfig.VERSION_NAME) }.getOrDefault(false)) mutable.value = UpdateState(UpdatePhase.Available, release, checkedAt = preferences.getLong("checked", 0))
        }
    }
    fun checkAutomatically() { if (!BuildConfig.DEBUG) check(false) }
    @Synchronized fun check(manual: Boolean = true) {
        if (checking?.isActive == true || downloading || requested != null) return
        val now = System.currentTimeMillis()
        if (!manual && now - preferences.getLong("attempted", 0) in 0 until CHECK_INTERVAL) return
        preferences.edit().putLong("attempted", now).apply()
        val before = mutable.value
        mutable.value = before.copy(phase = UpdatePhase.Checking, message = null)
        checking = scope.launch {
            try {
                checkClient.begin()
                val metadata = checkClient.latest(preferences.getString("etag", null))
                val text = metadata.body ?: preferences.getString("metadata", null) ?: throw UpdateFailure("release_invalid")
                val release = UpdatePolicy.release(text)
                val checkedAt = System.currentTimeMillis()
                preferences.edit().putString("metadata", text).putString("etag", metadata.etag).putLong("checked", checkedAt).apply()
                val newer = UpdatePolicy.isNewer(release.version, BuildConfig.VERSION_NAME)
                mutable.value = UpdateState(if (newer) UpdatePhase.Available else UpdatePhase.Latest, if (newer) release else null,
                    if (!newer) "已经是最新稳定版本。" else null, checkedAt = checkedAt,
                    prompt = !manual && newer && preferences.getString("dismissed", null) != release.tag)
            } catch (_: CancellationException) { throw CancellationException() }
            catch (error: Exception) { mutable.value = before.copy(phase = UpdatePhase.Error, message = updateMessage(error)) }
        }
    }
    fun dismissPrompt() {
        mutable.value.release?.let { preferences.edit().putString("dismissed", it.tag).apply() }
        mutable.value = mutable.value.copy(prompt = false)
    }
    @Synchronized fun requestDownload() {
        val release = mutable.value.release ?: return
        if (downloading || requested != null || mutable.value.phase == UpdatePhase.Checking) return
        if (context.packageName != "com.wildstring.app") { mutable.value = mutable.value.copy(message = "调试包与正式包相互隔离，请从 GitHub Releases 安装正式版本。"); return }
        requested = release
        mutable.value = mutable.value.copy(phase = UpdatePhase.Downloading, message = null, downloaded = 0, total = release.apk.size, prompt = false)
        try { ContextCompat.startForegroundService(context, Intent(context, UpdateDownloadService::class.java)) }
        catch (_: Exception) { requested = null; mutable.value = mutable.value.copy(phase = UpdatePhase.Error, message = "无法启动更新下载，请回到前台后重试。") }
    }
    suspend fun download(progress: (Long, Long) -> Unit) = withContext(Dispatchers.IO) {
        // Claiming a download and resetting its client must be atomic with cancellation.
        val release = synchronized(this@AppUpdater) { if (downloading) null else requested?.also { downloading = true; requested = null; downloadClient.begin() } } ?: return@withContext
        val partial = File(directory, "download.part")
        try {
            directory.mkdirs(); partial.delete(); ready.delete(); readyHash = null
            val checksums = downloadClient.checksums(release.checksums)
            release.checksums.digest?.let { expected -> val actual = MessageDigest.getInstance("SHA-256").digest(checksums.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }; if (actual != expected) throw UpdateFailure("checksum_mismatch") }
            val expected = UpdatePolicy.checksum(checksums, release.apk.name)
            if (release.apk.digest != null && release.apk.digest != expected) throw UpdateFailure("checksum_mismatch")
            var lastProgress = 0L
            downloadClient.download(release.apk, partial) { bytes, total ->
                val now = System.currentTimeMillis()
                if (now - lastProgress > 200 || bytes == total) { lastProgress = now; mutable.value = mutable.value.copy(downloaded = bytes, total = total); progress(bytes, total) }
            }
            downloadClient.ensureActive(); mutable.value = mutable.value.copy(phase = UpdatePhase.Verifying)
            if (UpdatePolicy.hash(partial) != expected) throw UpdateFailure("checksum_mismatch")
            UpdatePolicy.verifyPackage(ApkVerifier.archive(context, partial), ApkVerifier.installed(context), release)
            downloadClient.ensureActive()
            if (!partial.renameTo(ready)) throw UpdateFailure("storage_failed")
            readyHash = expected; mutable.value = mutable.value.copy(phase = UpdatePhase.Ready, message = "安装包已校验。点击安装后，仍需在系统界面确认。")
        } catch (_: CancellationException) { partial.delete(); mutable.value = mutable.value.copy(phase = UpdatePhase.Cancelled, message = "下载已取消，可重新下载。"); throw CancellationException() }
        catch (error: Exception) { partial.delete(); ready.delete(); readyHash = null
            val cancelled = downloadClient.wasCancelled() || error is UpdateFailure && error.reason == "cancelled"
            mutable.value = mutable.value.copy(phase = if (cancelled) UpdatePhase.Cancelled else UpdatePhase.Error, message = if (cancelled) "下载已取消，可重新下载。" else updateMessage(error))
        }
        finally { downloading = false }
    }
    @Synchronized fun cancelDownload() {
        if (requested == null && !downloading) return
        requested = null; downloadClient.cancel()
        mutable.value = mutable.value.copy(phase = if (downloading) mutable.value.phase else UpdatePhase.Cancelled,
            message = if (downloading) "正在取消下载…" else "下载已取消，可重新下载。", prompt = false)
    }
    suspend fun installationFile(): File = withContext(Dispatchers.IO) {
        val release = mutable.value.release ?: throw UpdateFailure("download_invalid")
        if (mutable.value.phase != UpdatePhase.Ready || !ready.isFile || readyHash == null || UpdatePolicy.hash(ready) != readyHash) throw UpdateFailure("checksum_mismatch")
        UpdatePolicy.verifyPackage(ApkVerifier.archive(context, ready), ApkVerifier.installed(context), release)
        ready
    }
    fun report(error: Exception) { mutable.value = mutable.value.copy(message = updateMessage(error)) }
    companion object {
        private const val CHECK_INTERVAL = 12L * 60 * 60 * 1000
        private const val CACHE_TTL = 7L * 24 * 60 * 60 * 1000
        @Volatile private var instance: AppUpdater? = null
        fun get(context: Context): AppUpdater = instance ?: synchronized(this) { instance ?: AppUpdater(context.applicationContext).also { instance = it } }
    }
}
fun updateMessage(error: Exception): String = if (error is java.io.IOException) "下载或保存更新失败，请检查网络与剩余空间后重试。" else when ((error as? UpdateFailure)?.reason) {
    "cancelled" -> "下载已取消，可重新下载。"
    "github_rate_limit" -> "GitHub 暂时限制了检查请求，请稍后重试。"
    "network_failed", "github_unavailable" -> "无法连接 GitHub，请检查手机网络后重试；音乐服务仍可使用。"
    "asset_missing" -> "最新版本暂未提供完整 Android 安装包，请稍后重试。"
    "checksum_missing", "checksum_mismatch" -> "安装包校验失败，已停止更新，请重新检查版本并下载。"
    "package_mismatch", "signature_mismatch" -> "安装包与当前应用的包名或签名不一致，已阻止安装。"
    "version_not_newer", "version_mismatch" -> "安装包版本不符合更新要求，已阻止安装。"
    "unsafe_download_url" -> "下载地址不是受信任的 GitHub Release 资产，已停止下载。"
    "storage_failed" -> "无法保存安装包，请检查手机剩余空间后重试。"
    else -> "更新未完成或安装包无效，请重新检查版本后重试。"
}
