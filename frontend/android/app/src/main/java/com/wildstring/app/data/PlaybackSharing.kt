package com.wildstring.app.data

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import retrofit2.HttpException
import java.util.UUID

@Singleton
class PlaybackSharing @Inject constructor(@ApplicationContext context: Context, private val repository: Repository) {
    private val prefs = context.getSharedPreferences("playback-device", Context.MODE_PRIVATE)
    val deviceId: String = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).apply() }
    private val lock = Mutex()
    private var owner: String? = null
    private var supportsPausedHandoff = false
    private var revision: Int? = null
    private var enabled = false
    private var lastAt = 0L
    private var lastSnapshot: SharedPlayback? = null
    private var claimedGeneration = -1L
    private val mutableMode = MutableStateFlow(prefs.getString("sync_mode", "ask").takeIf { it in listOf("off", "ask", "auto") } ?: "ask")
    val mode = mutableMode.asStateFlow()
    @Volatile private var automaticOwner: String? = null
    @Volatile private var automaticGeneration = 0L
    fun mode(value: String) { require(value in listOf("off", "ask", "auto")); prefs.edit().putString("sync_mode", value).apply(); mutableMode.value = value; if (value == "off") automaticOwner = null }
    fun localPlaybackStarted() { automaticOwner = repository.session.cacheScope(); automaticGeneration++ }
    fun seen(version: Int) { repository.session.cacheScope()?.let { prefs.edit().putInt("seen:$it", maxOf(prefs.getInt("seen:$it", 0), version)).apply() } }
    fun lastSeen(): Int = repository.session.cacheScope()?.let { prefs.getInt("seen:$it", 0) } ?: 0
    fun lastOfferedPause(): String? = repository.session.cacheScope()?.let { prefs.getString("offered-pause:$it", null) }
    fun pauseOffered(snapshot: SharedPlayback) { repository.session.cacheScope()?.let { owner -> snapshot.pauseEvent()?.let { prefs.edit().putString("offered-pause:$owner", it).apply() } } }
    suspend fun acceptRemote(version: Int) = lock.withLock { automaticOwner = null; enabled = false; revision = version; seen(version) }
    suspend fun publish(snapshot: SharedPlayback, claim: Boolean = false, claimVersion: Int? = null, force: Boolean = false): SharedPlayback? = lock.withLock {
        if (snapshot.trackIds.any { podcastEpisodeId(it) != null }) return@withLock null
        val profile = repository.session.cacheScope() ?: return@withLock null
        if (profile != owner) { owner = profile; revision = null; supportsPausedHandoff = false; enabled = false; lastAt = 0; lastSnapshot = null; claimedGeneration = -1 }
        if (!claim && (mutableMode.value == "off" || automaticOwner != profile)) return@withLock null
        val generation = automaticGeneration
        val automaticClaim = automaticOwner == profile && (!enabled || claimedGeneration != generation)
        val content = snapshot.copy(version = 0, deviceId = "", updatedAt = null, pausedAt = null, handoffSupported = false, handoffEligible = false)
        if (!claim && !automaticClaim && content == lastSnapshot) return@withLock null
        if (claim || automaticClaim) {
            val remote = repository.api().sharedPlayback(RequestOwner(profile))
            supportsPausedHandoff = remote.handoffSupported
            revision = claimVersion ?: remote.version
            if (profile != repository.session.cacheScope()) throw kotlinx.coroutines.CancellationException("会话已变化。")
            enabled = true; claimedGeneration = generation
        }
        if (!enabled || snapshot.trackIds.isEmpty()) return@withLock null
        if (!claim && !automaticClaim && !force && android.os.SystemClock.elapsedRealtime() - lastAt < 15_000) return@withLock null
        try {
            val saved = repository.api().saveSharedPlayback(snapshot.copy(version = revision ?: 0, deviceId = deviceId, updatedAt = null).writeBody(includePlaybackState = supportsPausedHandoff), RequestOwner(profile))
            if (profile != repository.session.cacheScope()) return@withLock null
            revision = saved.version; lastSnapshot = content; seen(saved.version); lastAt = android.os.SystemClock.elapsedRealtime(); saved
        } catch (error: HttpException) {
            if (error.code() == 409) { enabled = false; if (generation == automaticGeneration) automaticOwner = null }
            throw error
        }
    }
}
