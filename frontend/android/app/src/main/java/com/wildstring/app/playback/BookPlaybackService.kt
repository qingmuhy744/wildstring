package com.wildstring.app.playback

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.os.Process
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.gson.JsonObject
import com.wildstring.app.MainActivity
import com.wildstring.app.data.BookSync
import com.wildstring.app.data.Repository
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

@AndroidEntryPoint
@OptIn(UnstableApi::class)
class BookPlaybackService : MediaSessionService() {
    @Inject lateinit var repository: Repository
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val progressLock = Mutex()
    private var checkpointKey: Pair<String, String>? = null
    private var checkpoint: BookSync? = null
    private var started: Pair<String, String>? = null
    private var sleep: Job? = null

    override fun onCreate() {
        super.onCreate()
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(repository.client)))
            .build().apply { setAudioAttributes(AudioAttributes.DEFAULT, true) }
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player)
            .setId("audiobooks")
            .setSessionActivity(activity)
            .setCallback(object : MediaSession.Callback {
                override fun onConnectAsync(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                ): ListenableFuture<MediaSession.ConnectionResult> {
                    val result = when {
                        controller.uid == Process.myUid() -> MediaSession.ConnectionResult.AcceptedResultBuilder()
                            .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS)
                            .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                                .buildUpon().add(SessionCommand(SLEEP, Bundle.EMPTY)).build())
                            .build()
                        controller.isTrusted -> MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                            .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                                .remove(Player.COMMAND_SET_MEDIA_ITEM).remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).build())
                            .build()
                        else -> MediaSession.ConnectionResult.reject()
                    }
                    return Futures.immediateFuture(result)
                }

                override fun onAddMediaItems(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    mediaItems: List<MediaItem>,
                ): ListenableFuture<List<MediaItem>> {
                    val endpoint = repository.session.endpoint
                    return Futures.immediateFuture(mediaItems.mapNotNull { item ->
                        val (owner, book) = identity(item) ?: return@mapNotNull null
                        val details = item.mediaMetadata.extras ?: return@mapNotNull null
                        if (owner != repository.session.cacheScope() || endpoint == null) return@mapNotNull null
                        val file = details.getInt("fileIndex")
                        val start = details.getLong("start")
                        val end = details.getLong("end")
                        if (file < 0 || start < 0 || end <= start) return@mapNotNull null
                        val url = endpoint.newBuilder().addPathSegments("api/v1/books").addPathSegment(book)
                            .addPathSegments("audiobook/files/$file/stream").build()
                        item.buildUpon()
                            .setUri(url.toString())
                            .setClippingConfiguration(MediaItem.ClippingConfiguration.Builder()
                                .setStartPositionMs(start).setEndPositionMs(end).build())
                            .build()
                    })
                }

                override fun onCustomCommand(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                    customCommand: SessionCommand,
                    args: Bundle,
                ): ListenableFuture<SessionResult> {
                    if (customCommand.customAction != SLEEP) {
                        return super.onCustomCommand(session, controller, customCommand, args)
                    }
                    val minutes = args.getInt("minutes")
                    if (minutes !in 0..60) {
                        return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                    }
                    sleep?.cancel()
                    sleep = if (minutes == 0) null else work.launch {
                        delay(minutes * 60_000L)
                        player.pause()
                    }
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                }
            })
            .build()
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (isPlaying) started = identity(player.currentMediaItem)
                save(player.currentMediaItem, player.currentPosition)
            }

            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    save(player.currentMediaItem, player.currentPosition, completed = true)
                }
            }

            override fun onPositionDiscontinuity(
                oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int,
            ) {
                if (oldPosition.mediaItemIndex != newPosition.mediaItemIndex) {
                    save(oldPosition.mediaItem, oldPosition.positionMs)
                }
                if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION) {
                    save(newPosition.mediaItem, newPosition.positionMs)
                }
            }
        })
        work.launch {
            while (isActive) {
                delay(10_000)
                if (player.isPlaying) save(player.currentMediaItem, player.currentPosition)
            }
        }
        work.launch {
            repository.session.profiles.collect {
                if (identity(player.currentMediaItem)?.first?.let { it != repository.session.cacheScope() } == true) {
                    started = null
                    player.stop()
                    player.clearMediaItems()
                    sleep?.cancel()
                }
            }
        }
    }

    private fun identity(item: MediaItem?): Pair<String, String>? {
        val extras = item?.mediaMetadata?.extras ?: return null
        val owner = extras.getString("owner") ?: return null
        val book = extras.getString("bookId") ?: return null
        return owner to book
    }

    private fun save(item: MediaItem?, position: Long, completed: Boolean = false) {
        val key = identity(item) ?: return
        if (key != started || key.first != repository.session.cacheScope()) return
        val extras = item?.mediaMetadata?.extras ?: return
        val fields = JsonObject().apply {
            addProperty("chapter_index", extras.getInt("chapter"))
            addProperty("chapter_position_ms", position.coerceIn(0, extras.getLong("duration")))
            addProperty("playback_rate", player.playbackParameters.speed)
            addProperty("completed", completed)
        }
        work.launch {
            progressLock.withLock {
                if (key.first != repository.session.cacheScope()) return@withLock
                try {
                    if (checkpointKey != key) {
                        checkpoint = BookSync(repository, key.second, "listening").also { it.load() }
                        checkpointKey = key
                    }
                    checkpoint?.save(fields)
                } catch (cause: CancellationException) {
                    throw cause
                } catch (_: Exception) {
                    // Keep offline playback running when the server cannot accept a checkpoint.
                }
            }
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

    override fun onDestroy() {
        work.cancel()
        session.release()
        player.release()
        super.onDestroy()
    }

    companion object { const val SLEEP = "wildstring.book.sleep" }
}
