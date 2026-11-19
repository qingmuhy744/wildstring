package com.wildstring.app.playback

import android.os.Bundle
import android.os.SystemClock
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import com.wildstring.app.data.Repository
import com.wildstring.app.data.RequestOwner
import com.wildstring.app.data.Track
import java.io.IOException
import java.util.UUID
import kotlinx.coroutines.*

const val MUSIC_QUEUE_LIMIT = 100

data class HeartBatch(val library: String, val recommended: Boolean = false, val id: String = UUID.randomUUID().toString()) {
    fun write(extras: Bundle) {
        extras.putString("heart_batch", id)
        extras.putString("heart_library", library)
        extras.putBoolean("heart_recommended", recommended)
    }
}

internal fun MediaItem?.heartBatch(): HeartBatch? {
    val extras = this?.mediaMetadata?.extras ?: return null
    val id = extras.getString("heart_batch") ?: return null
    return HeartBatch(extras.getString("heart_library") ?: return null, extras.getBoolean("heart_recommended"), id)
}

/** A music batch can finish while the Activity is closed. Only the service advances it. */
internal class HeartPlayback(private val repository: Repository, private val player: Player,
    private val sleep: SleepTimer, private val scope: CoroutineScope) {
    private var advancing: Job? = null

    fun cancel() { advancing?.cancel() }

    private suspend fun dailyTracks(owner: String): List<Track> {
        val daily = try {
            // The ordinary daily GET can generate a batch. An older server can only use the phone's saved batch.
            val response = repository.api().existingDaily(RequestOwner(owner))
            response.errorBody()?.close()
            when {
                response.code() == 204 || response.code() == 404 || response.code() >= 500 -> repository.cachedDaily()
                response.isSuccessful -> response.body()
                else -> null
            }
        } catch (_: IOException) {
            repository.cachedDaily()
        }
        return daily?.items.orEmpty().map { it.track }.filter { it.isAvailable && !it.isPodcast }.distinctBy { it.id }
    }

    fun ended() {
        val current = player.currentMediaItem ?: return
        val finished = current.heartBatch() ?: return
        val owner = current.mediaMetadata.extras?.getString("profile") ?: return
        val timer = sleep.state.value
        if (timer.entryId == current.mediaId || timer.expired(SystemClock.elapsedRealtime())) {
            player.pause()
            sleep.cancel()
            return
        }
        if (!player.playWhenReady || player.repeatMode != Player.REPEAT_MODE_OFF || advancing?.isActive == true) return
        if (repository.session.cacheScope() != owner || repository.selectedLibraryId != finished.library) return
        advancing = scope.launch {
            val batch = HeartBatch(finished.library, recommended = true)
            val candidates = withContext(Dispatchers.IO) { dailyTracks(owner) }
            val currentIds = (0 until player.mediaItemCount).mapNotNull {
                player.getMediaItemAt(it).mediaMetadata.extras?.getString("track_id")
            }.toSet()
            val last = current.mediaMetadata.extras?.getString("track_id")
            val fresh = if (finished.recommended) candidates else candidates.filterNot { it.id in currentIds }
            val tracks = fresh.ifEmpty { candidates }.shuffled().take(MUSIC_QUEUE_LIMIT).toMutableList()
            if (tracks.isEmpty()) return@launch
            if (tracks.first().id == last) {
                if (tracks.size == 1) return@launch
                java.util.Collections.swap(tracks, 0, 1)
            }
            val items = try {
                withContext(Dispatchers.IO) { tracks.mediaItems(repository, batch) }
            } catch (_: IOException) {
                return@launch
            }
            if (player.playbackState != Player.STATE_ENDED || !player.playWhenReady || player.repeatMode != Player.REPEAT_MODE_OFF ||
                player.currentMediaItem?.mediaId != current.mediaId || player.currentMediaItem.heartBatch() != finished ||
                repository.session.cacheScope() != owner || repository.selectedLibraryId != finished.library) return@launch
            val latestTimer = sleep.state.value
            if (latestTimer.entryId == current.mediaId || latestTimer.expired(SystemClock.elapsedRealtime())) return@launch
            tracks.forEach(repository::rememberPlaybackTrack)
            player.setMediaItems(items, 0, 0)
            player.prepare()
            player.play()
        }
    }
}
