package com.wildstring.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import com.google.gson.Gson
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import java.io.IOException
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** Complete, explicitly retained originals. Never shares the evictable playback chunk cache. */
data class OfflineEntry(val track: Track, val state: String = "queued", val bytes: Long = 0, val total: Long = 0,
    val etag: String? = null, val error: String? = null)
private data class OfflineIndex(val owner: String?, val entries: List<OfflineEntry>)

@Singleton
class OfflineDownloads @Inject constructor(@ApplicationContext private val context: Context,
    private val session: SessionStore, private val client: OkHttpClient) {
    private val root = File(context.filesDir, "offline-v1").apply { mkdirs() }
    private val gson = Gson()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var owner: String? = null
    private var activation: String? = null
    private val mutable = MutableStateFlow<List<OfflineEntry>>(emptyList())
    val entries = mutable.asStateFlow()
    private var active: Call? = null
    private var activeId: String? = null
    private var generation = 0L
    private val prefs = context.getSharedPreferences("offline-options", Context.MODE_PRIVATE)
    var capacityGb: Int
        get() = prefs.getInt("capacity_gb", 4).coerceIn(1, 64)
        set(value) { require(value in 1..64); prefs.edit().putInt("capacity_gb", value).apply() }
    var wifiOnly: Boolean
        get() = prefs.getBoolean("wifi_only", true)
        set(value) { prefs.edit().putBoolean("wifi_only", value).apply() }
    init {
        synchronized(this) {
            // Old files already live in the owner's UUID directory; only move the index.
            val old = File(root, "index.json")
            runCatching { gson.fromJson(old.readText(), OfflineIndex::class.java) }.getOrNull()?.let { index ->
                index.owner?.let { profile ->
                    if (profile in session.retainedStorageScopes()) {
                        val target = File(directory(profile), "index.json"); target.parentFile!!.mkdirs(); old.renameTo(target)
                    }
                }
            }
            old.delete(); ensureOwner()
        }
        scope.launch { session.profiles.collect { synchronized(this@OfflineDownloads) { ensureOwner() } } }
        scope.launch { session.retainedScopes.collect { synchronized(this@OfflineDownloads) { ensureOwner(); prune() } } }
    }
    private fun directory(profile: String) = File(root, UUID.nameUUIDFromBytes(profile.toByteArray()).toString())
    private fun prune() {
        val keep = session.retainedStorageScopes().map { directory(it).name }.toSet()
        root.listFiles()?.filter { it.name !in keep }?.forEach { it.deleteRecursively() }
    }
    @Synchronized private fun ensureOwner(): String? {
        val snapshot = session.storageState()
        val current = snapshot?.second
        val token = snapshot?.first
        if (current != owner || token != activation) {
            generation++; active?.cancel(); active = null; activeId = null
            mutable.value = mutable.value.map { if (it.state in listOf("queued", "downloading")) it.copy(state = "paused") else it }
            persist()
            owner = current; activation = token
            val saved = current?.let { runCatching { gson.fromJson(File(directory(it), "index.json").readText(), OfflineIndex::class.java) }.getOrNull() }
            mutable.value = saved?.takeIf { it.owner == current }?.entries.orEmpty().map { if (it.state in listOf("queued", "downloading")) it.copy(state = "paused") else it }
            persist(); prune()
        }
        return current
    }
    private fun filename(id: String, part: Boolean = false, profile: String? = owner): File {
        val directory = File(root, UUID.nameUUIDFromBytes(profile.orEmpty().toByteArray()).toString())
        return File(directory, UUID.nameUUIDFromBytes(id.toByteArray()).toString() + if (part) ".part" else ".audio")
    }
    @Synchronized private fun persist() {
        val directory = owner?.let(::directory) ?: return
        directory.mkdirs()
        val temp = File(directory, "index.tmp")
        runCatching {
            temp.writeText(gson.toJson(OfflineIndex(owner, mutable.value)))
            java.io.RandomAccessFile(temp, "rw").use { it.fd.sync() }
            check(temp.renameTo(File(directory, "index.json")))
        }
    }
    @Synchronized private fun update(value: OfflineEntry) {
        mutable.value = mutable.value.map { if (it.track.id == value.track.id) value else it }; persist()
    }
    @Synchronized private fun updateCurrent(value: OfflineEntry, profile: String, epoch: Long, states: Set<String> = setOf("downloading")) {
        if (profile != ensureOwner() || epoch != generation || mutable.value.none { it.track.id == value.track.id && it.state in states }) {
            throw CancellationException("下载或账号状态已变化。")
        }
        update(value)
    }
    @Synchronized fun switchScope() { ensureOwner() }
    @Synchronized fun enqueue(tracks: List<Track>) {
        check(ensureOwner() != null) { "请先登录。" }
        require((tracks.map { it.id } + mutable.value.map { it.track.id }).distinct().size <= 5000) { "离线保存最多 5000 首。" }
        val previous = mutable.value.associateBy { it.track.id }
        val incoming = tracks.associateBy { it.id }
        mutable.value = mutable.value.map { entry -> incoming[entry.track.id]?.let { track ->
            if (entry.state in listOf("paused", "failed")) entry.copy(track = track, state = "queued", error = null) else entry.copy(track = track)
        } ?: entry }
        mutable.value = (mutable.value + tracks.distinctBy { it.id }.filter { it.id !in previous }.map { OfflineEntry(it) })
        persist()
    }
    @Synchronized fun resume(id: String) {
        ensureOwner()
        mutable.value.firstOrNull { it.track.id == id && it.state != "complete" }?.let { update(it.copy(state = "queued", error = null)) }
    }
    @Synchronized fun pause(id: String) {
        ensureOwner()
        mutable.value.firstOrNull { it.track.id == id && it.state in listOf("queued", "downloading") }?.let { update(it.copy(state = "paused")) }
        if (activeId == id) active?.cancel()
    }
    @Synchronized fun pauseAll() {
        ensureOwner(); generation++; active?.cancel()
        mutable.value = mutable.value.map { if (it.state in listOf("queued", "downloading")) it.copy(state = "paused") else it }; persist()
    }
    @Synchronized fun resumeAll() {
        ensureOwner(); mutable.value = mutable.value.map { if (it.state in listOf("paused", "failed")) it.copy(state = "queued", error = null) else it }; persist()
    }
    @Synchronized fun remove(id: String) {
        ensureOwner()
        if (activeId == id) { generation++; active?.cancel() }
        mutable.value = mutable.value.filter { it.track.id != id }; filename(id).delete(); filename(id, true).delete(); persist()
    }
    @Synchronized fun refreshTrack(track: Track) {
        ensureOwner(); mutable.value.firstOrNull { it.track.id == track.id && it.track != track }?.let {
            if (track.status == "available") update(it.copy(track = track)) else remove(track.id)
        }
    }
    @Synchronized fun file(id: String): File? {
        if (ensureOwner() == null) return null
        val entry = mutable.value.firstOrNull { it.track.id == id && it.state == "complete" } ?: return null
        val file = filename(id)
        if (file.isFile && file.length() == entry.bytes) return file
        file.delete(); update(entry.copy(state = "failed", bytes = 0, total = 0, etag = null, error = "本机文件不完整，请重新保存。")); return null
    }
    @Synchronized fun track(id: String): Track? = if (file(id) != null) mutable.value.firstOrNull { it.track.id == id }?.track else null
    fun fileForStream(uri: String): File? {
        val base = session.endpoint ?: return null
        val target = uri.toHttpUrlOrNull() ?: return null
        if (!ServerAddress.contains(base, target) || !target.encodedPath.endsWith("/stream")) return null
        val parts = target.pathSegments
        if (parts.size < 5 || parts[parts.lastIndex - 2] != "tracks") return null
        return file(parts[parts.lastIndex - 1])
    }
    /** Revalidate access and source identity when online. Actual connection failure permits offline use. */
    fun playableFile(uri: String): File? {
        val file = fileForStream(uri) ?: return null
        val profile = session.cacheScope() ?: return null
        val id = uri.toHttpUrlOrNull()?.pathSegments?.dropLast(1)?.lastOrNull() ?: return null
        val expected = synchronized(this) { mutable.value.firstOrNull { it.track.id == id }?.etag }
        try {
            val original = uri.toHttpUrlOrNull()!!.newBuilder().query(null).build()
            client.newCall(Request.Builder().url(original).tag(RequestOwner::class.java, RequestOwner(profile)).head().build()).execute().use { response ->
                if (profile != session.cacheScope()) throw OfflineAccessException("会话已变化。")
                if (response.code in listOf(401, 403, 404, 409) || (response.isSuccessful && expected != null && expected != response.header("ETag"))) {
                    remove(id); throw OfflineAccessException("离线内容已失效，请重新保存。")
                }
                if (!response.isSuccessful) throw OfflineAccessException("服务器暂时拒绝此内容，请稍后重试。")
            }
        } catch (error: IOException) {
            if (error is javax.net.ssl.SSLException || error is OfflineAccessException || profile != session.cacheScope()) throw error
        }
        if (profile != session.cacheScope()) throw OfflineAccessException("会话已失效。")
        return file.takeIf { it.isFile }
    }
    fun formatForStream(uri: String): String? {
        val target = uri.toHttpUrlOrNull() ?: return null
        val id = target.pathSegments.dropLast(1).lastOrNull() ?: return null
        return track(id)?.format
    }
    private fun networkAllowed(): Boolean {
        if (!wifiOnly) return true
        val manager = context.getSystemService(ConnectivityManager::class.java)
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }
    /** Called by the dataSync foreground service. A paused/interrupted file can resume with a validator. */
    suspend fun run(onProgress: (OfflineEntry) -> Unit) = withContext(Dispatchers.IO) {
        while (isActive) {
            val start = synchronized(this@OfflineDownloads) {
                val current = ensureOwner() ?: return@withContext
                val entry = mutable.value.firstOrNull { it.state == "queued" } ?: return@withContext
                Triple(current, generation, entry) to (activation ?: return@withContext)
            }
            val (profile, epoch, entry) = start.first
            val requestToken = start.second
            val id = entry.track.id
            if (!networkAllowed()) {
                synchronized(this@OfflineDownloads) {
                    if (profile == ensureOwner() && epoch == generation && mutable.value.any { it.track.id == id && it.state == "queued" }) update(entry.copy(state = "paused", error = "等待 Wi-Fi；连接后点击继续。"))
                }
                continue
            }
            var progress = entry.copy(state = "downloading", error = null)
            val part = filename(id, true, profile)
            try {
                val base = session.endpoint ?: throw IOException("连接已失效。")
                val target = base.newBuilder().addPathSegments("api/v1/tracks").addPathSegment(id).addPathSegment("stream").build()
                var offset = if (!entry.etag.isNullOrBlank()) part.length() else 0L
                if (offset == 0L) part.delete()
                val request = Request.Builder().url(target).tag(RequestOwner::class.java, RequestOwner(requestToken)).header("Accept-Encoding", "identity").apply {
                    if (offset > 0) { header("Range", "bytes=$offset-"); header("If-Range", entry.etag!!) }
                }.build()
                val call = client.newCall(request)
                synchronized(this@OfflineDownloads) {
                    if (profile != ensureOwner() || epoch != generation) return@withContext
                    updateCurrent(progress, profile, epoch, setOf("queued")); active = call; activeId = id
                }
                call.execute().use { response ->
                    synchronized(this@OfflineDownloads) { if (profile != ensureOwner() || epoch != generation) { throw CancellationException("会话已变化。") } }
                    if (response.code in listOf(401, 403, 404)) { remove(id); throw IOException("内容已不可访问，离线副本已移除。") }
                    if (!response.isSuccessful) {
                        if (response.code == 416) { part.delete(); progress = progress.copy(bytes = 0, etag = null) }
                        throw IOException("下载失败，请重试。")
                    }
                    if (response.code != 206) offset = 0
                    if (response.code == 206 && response.header("ETag") != entry.etag) {
                        part.delete(); progress = progress.copy(bytes = 0, etag = null)
                        throw IOException("文件版本已变化，请重新下载。")
                    }
                    if (response.code == 206 && !response.header("Content-Range").orEmpty().startsWith("bytes $offset-")) {
                        part.delete(); progress = progress.copy(bytes = 0, etag = null)
                        throw IOException("续传响应不一致，请重新下载。")
                    }
                    val body = response.body ?: throw IOException("下载响应为空。")
                    val expected = body.contentLength().takeIf { it >= 0 }?.plus(offset) ?: 0
                    val otherBytes = synchronized(this@OfflineDownloads) { mutable.value.filter { it.track.id != id }.sumOf { it.bytes } }
                    require(expected == 0L || expected + otherBytes <= capacityGb * 1024L * 1024 * 1024) { "超过离线总容量，请删除音乐或提高限额。" }
                    require(expected <= MAX_FILE_BYTES && (expected == 0L || expected - offset + RESERVE < root.usableSpace)) { "离线空间不足或文件超过 2 GiB。" }
                    progress = progress.copy(bytes = offset, total = expected, etag = response.header("ETag"))
                    synchronized(this@OfflineDownloads) { updateCurrent(progress, profile, epoch) }
                    val fileOutput = synchronized(this@OfflineDownloads) {
                        if (profile != ensureOwner() || epoch != generation) { throw CancellationException("会话已变化。") }
                        check(part.parentFile!!.mkdirs() || part.parentFile!!.isDirectory)
                        java.io.FileOutputStream(part, offset > 0)
                    }
                    fileOutput.use { output ->
                        body.byteStream().use { input ->
                            val bytes = ByteArray(64 * 1024)
                            var written = offset
                            var last = 0L
                            while (true) {
                                ensureActive()
                                synchronized(this@OfflineDownloads) {
                                    if (profile != ensureOwner() || epoch != generation || mutable.value.none { it.track.id == id && it.state == "downloading" }) throw CancellationException("下载已暂停。")
                                }
                                val count = input.read(bytes)
                                if (count < 0) break
                                written += count
                                if (written > MAX_FILE_BYTES || written + otherBytes > capacityGb * 1024L * 1024 * 1024 || root.usableSpace < RESERVE) throw IOException("离线空间不足。")
                                synchronized(this@OfflineDownloads) {
                                    if (profile != ensureOwner() || epoch != generation || mutable.value.none { it.track.id == id && it.state == "downloading" }) throw CancellationException("下载已暂停。")
                                    output.write(bytes, 0, count)
                                }
                                if (System.currentTimeMillis() - last > 500) {
                                    if (!networkAllowed()) {
                                        synchronized(this@OfflineDownloads) { updateCurrent(progress.copy(state = "paused", bytes = written, error = "等待 Wi-Fi；连接后点击继续。"), profile, epoch) }
                                        throw CancellationException("等待 Wi-Fi。")
                                    }
                                    progress = progress.copy(bytes = written); synchronized(this@OfflineDownloads) { updateCurrent(progress, profile, epoch) }; onProgress(progress); last = System.currentTimeMillis()
                                }
                            }
                            if (expected > 0 && written != expected) throw IOException("文件尚未下载完整，请继续。")
                            output.fd.sync()
                            progress = progress.copy(bytes = written, total = written)
                        }
                    }
                    synchronized(this@OfflineDownloads) {
                        if (profile != ensureOwner() || epoch != generation || mutable.value.none { it.track.id == id && it.state == "downloading" }) throw CancellationException("下载已暂停。")
                        check(part.renameTo(filename(id, profile = profile))) { "无法保存离线文件。" }
                        update(progress.copy(state = "complete")); onProgress(progress.copy(state = "complete"))
                    }
                }
            } catch (error: Exception) {
                synchronized(this@OfflineDownloads) {
                    val current = mutable.value.firstOrNull { it.track.id == id }
                    if (profile == ensureOwner() && epoch == generation && current?.state == "downloading") {
                        update(progress.copy(state = if (error is CancellationException) "paused" else "failed", bytes = part.length(), error = "下载未完成，可继续或删除后重试。"))
                    }
                }
                if (error is CancellationException && !isActive) throw error
            } finally { synchronized(this@OfflineDownloads) { if (epoch == generation && activeId == id) { active = null; activeId = null } } }
        }
    }
    companion object { private const val MAX_FILE_BYTES = 2L * 1024 * 1024 * 1024; private const val RESERVE = 32L * 1024 * 1024 }
}

class OfflineAccessException(message: String) : IOException(message)
