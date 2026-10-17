package com.wildstring.app.data

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import retrofit2.HttpException
import java.util.UUID

@Singleton
class PlaybackSharing @Inject constructor(@ApplicationContext context: Context, private val repository: Repository) {
    private val prefs = context.getSharedPreferences("playback-device", Context.MODE_PRIVATE)
    val deviceId: String = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).apply() }
    private val lock = Mutex()
    private var owner: String? = null
    private var revision: Int? = null
    private var enabled = false
    private var lastAt = 0L
    suspend fun publish(snapshot: SharedPlayback, claim: Boolean = false, claimVersion: Int? = null): SharedPlayback? = lock.withLock {
        val profile = repository.session.cacheScope() ?: return@withLock null
        if (profile != owner) { owner = profile; revision = null; enabled = false; lastAt = 0 }
        if (claim) {
            revision = claimVersion ?: repository.api().sharedPlayback(RequestOwner(profile)).version
            if (profile != repository.session.cacheScope()) throw kotlinx.coroutines.CancellationException("会话已变化。")
            enabled = true
        }
        if (!enabled || snapshot.trackIds.isEmpty()) return@withLock null
        if (!claim && android.os.SystemClock.elapsedRealtime() - lastAt < 15_000) return@withLock null
        try {
            val saved = repository.api().saveSharedPlayback(snapshot.copy(version = revision ?: 0, deviceId = deviceId, updatedAt = null).writeBody(), RequestOwner(profile))
            if (profile != repository.session.cacheScope()) return@withLock null
            revision = saved.version; lastAt = android.os.SystemClock.elapsedRealtime(); saved
        } catch (error: HttpException) {
            if (error.code() == 409) enabled = false
            throw error
        }
    }
}
