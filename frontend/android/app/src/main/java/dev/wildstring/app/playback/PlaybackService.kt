package dev.wildstring.app.playback

import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import dagger.hilt.android.AndroidEntryPoint
import dev.wildstring.app.MainActivity
import dev.wildstring.app.data.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request

fun Track.mediaItem(repository: Repository, entryId: String = UUID.randomUUID().toString()): MediaItem =
    MediaItem.Builder().setMediaId(entryId).setUri(repository.stream(id))
        .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album)
            .setArtworkUri(if (hasCover) Uri.parse(repository.cover(id)) else null)
            .setExtras(Bundle().apply { putString("track_id", id) }).build()).build()

@OptIn(UnstableApi::class)
@AndroidEntryPoint
class PlaybackService : MediaSessionService() {
    @Inject lateinit var repository: Repository
    private lateinit var player: ExoPlayer
    private var session: MediaSession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val saveMutex = Mutex()
    private val executor = MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(2))
    private var clock = ListeningClock()
    private var listeningId = UUID.randomUUID().toString()
    private var listeningTrack: String? = null
    private var sentMs = 0L
    private var restoring = true
    private var lastSavedQueue: List<QueueEntry>? = null

    override fun onCreate() {
        super.onCreate()
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(repository.client)))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_NETWORK).build()
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player).setSessionActivity(activity)
            .setBitmapLoader(AuthenticatedBitmapLoader(repository.client, executor))
            .setCallback(object : MediaSession.Callback {
                override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                    if (controller.uid == Process.myUid()) return super.onConnect(session, controller)
                    if (!controller.isTrusted) return MediaSession.ConnectionResult.reject()
                    val commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                        .remove(Player.COMMAND_SET_MEDIA_ITEM).remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).build()
                    return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailablePlayerCommands(commands).build()
                }
            }).build()
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                report()
                clock = ListeningClock(); sentMs = 0; listeningId = UUID.randomUUID().toString()
                listeningTrack = mediaItem?.mediaMetadata?.extras?.getString("track_id")
                clock.reset(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                persist()
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, isPlaying)
                report(); persist()
            }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                if (oldPosition.mediaItem?.mediaMetadata?.extras?.getString("track_id") == listeningTrack) {
                    clock.sample(SystemClock.elapsedRealtime(), oldPosition.positionMs, false)
                    report()
                }
                clock.reset(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                persist()
            }
            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) { persist() }
        })
        scope.launch { repository.session.invalidations.collect {
            player.stop(); player.clearMediaItems()
            withContext(Dispatchers.IO) { repository.database.queue().clear() }
        } }
        scope.launch {
            while (isActive) {
                delay(5_000)
                clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                report(); persist()
            }
        }
        scope.launch { try { restore() } finally { restoring = false; persist() } }
    }

    private fun report() {
        val id = listeningTrack ?: return
        val value = clock.totalMs
        if (value <= sentMs) return
        val report = ListeningRequest(listeningId, id, value)
        sentMs = value
        scope.launch {
            try { repository.api().listening(report).close() }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (listeningId == report.sessionId) sentMs = 0 }
        }
    }

    private fun persist() {
        if (restoring) return
        val endpoint = repository.session.endpoint?.toString() ?: return
        val entries = (0 until player.mediaItemCount).map { index ->
            val item = player.getMediaItemAt(index)
            QueueEntry(item.mediaId, item.mediaMetadata.extras?.getString("track_id") ?: "", index)
        }.filter { it.trackId.isNotBlank() }
        val position = SavedPosition(endpoint = endpoint, entryId = player.currentMediaItem?.mediaId, positionMs = player.currentPosition.coerceAtLeast(0))
        scope.launch { saveMutex.withLock {
            withContext(Dispatchers.IO) {
                if (lastSavedQueue == entries) repository.database.queue().insertPosition(position)
                else repository.database.queue().save(entries, position)
            }
            lastSavedQueue = entries
        } }
    }

    private suspend fun restore() {
        try {
            val dao = repository.database.queue()
            val (saved, entries) = withContext(Dispatchers.IO) { dao.position() to dao.entries() }
            if (saved == null || saved.endpoint != repository.session.endpoint?.toString() || entries.isEmpty()) return
            if (!repository.api().status().authenticated) return
            val items = mutableListOf<MediaItem>()
            for (entry in entries.take(5000)) {
                if (player.mediaItemCount != 0) return
                try {
                    val track = repository.track(entry.trackId)
                    if (track.status == "available") items += track.mediaItem(repository, entry.entryId)
                } catch (error: retrofit2.HttpException) {
                    if (error.code() != 404 && error.code() != 409) throw error
                }
            }
            if (items.isEmpty() || player.mediaItemCount != 0 || saved.endpoint != repository.session.endpoint?.toString()) return
            val index = items.indexOfFirst { it.mediaId == saved.entryId }.coerceAtLeast(0)
            player.setMediaItems(items, index, saved.positionMs)
            player.prepare()
            player.playWhenReady = false
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* A failed restore never prevents browsing or fresh playback. */ }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        if (controllerInfo.uid == Process.myUid() || controllerInfo.isTrusted) session else null

    override fun onDestroy() {
        scope.cancel()
        session?.release(); session = null
        player.release(); executor.shutdown()
        super.onDestroy()
    }
}

@OptIn(UnstableApi::class)
private class AuthenticatedBitmapLoader(private val client: OkHttpClient, private val executor: ListeningExecutorService) : BitmapLoader {
    override fun supportsMimeType(mimeType: String): Boolean = mimeType.startsWith("image/")
    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Invalid cover")
    }
    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        client.newCall(Request.Builder().url(uri.toString()).build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Cover unavailable")
            val body = response.body ?: throw IOException("Cover unavailable")
            if (body.contentLength() > 2 * 1024 * 1024) throw IOException("Cover too large")
            val source = body.source()
            source.request(2 * 1024 * 1024L + 1)
            if (source.buffer.size > 2 * 1024 * 1024) throw IOException("Cover too large")
            val bytes = source.readByteArray()
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IOException("Invalid cover")
        }
    }
}
