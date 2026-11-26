package com.wildstring.app.playback

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionError
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import com.google.gson.JsonObject
import com.wildstring.app.MainActivity
import com.wildstring.app.data.BookSync
import com.wildstring.app.data.Repository
import dagger.hilt.android.AndroidEntryPoint
import java.util.concurrent.Executors
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

@AndroidEntryPoint
@OptIn(UnstableApi::class)
class BookPlaybackService : MediaSessionService() {
    @Inject lateinit var repository: Repository
    private lateinit var player: ExoPlayer
    private lateinit var session: MediaSession
    private val work = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val executor = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())
    private val progressLock = Mutex()
    private var checkpointKey: Pair<String, String>? = null
    private var checkpointToken: String? = null
    private var checkpoint: BookSync? = null
    private var started: Pair<String, String>? = null
    private var sleep: Job? = null
    private var sleepEndElapsedMs: Long = 0L

    override fun onCreate() {
        super.onCreate()
        val extractors = DefaultExtractorsFactory()
            .setConstantBitrateSeekingEnabled(true)
            .setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING)
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(repository.client), extractors))
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .build().apply {
                setAudioAttributes(
                    AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(),
                    true,
                )
            }
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player)
            .setId("audiobooks")
            .setSessionActivity(activity)
            .setBitmapLoader(AuthenticatedBitmapLoader(repository, executor))
            .setCallback(object : MediaSession.Callback {
                override fun onConnectAsync(
                    session: MediaSession,
                    controller: MediaSession.ControllerInfo,
                ): ListenableFuture<MediaSession.ConnectionResult> {
                    val result = when {
                        controller.uid == Process.myUid() -> MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller)
                            .setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS)
                            .setAvailableSessionCommands(MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS
                                .buildUpon()
                                .add(SessionCommand(SLEEP, Bundle.EMPTY))
                                .add(SessionCommand(SLEEP_STATUS, Bundle.EMPTY))
                                .add(SessionCommand(STOP_CLEAR, Bundle.EMPTY))
                                .build())
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
                    if (customCommand.customAction == SLEEP_STATUS) {
                        val remainingMin = if (sleepEndElapsedMs > 0L) {
                            val remainingMs = (sleepEndElapsedMs - SystemClock.elapsedRealtime()).coerceAtLeast(0L)
                            ((remainingMs + 59_999L) / 60_000L).toInt()
                        } else {
                            0
                        }
                        return Futures.immediateFuture(
                            SessionResult(SessionResult.RESULT_SUCCESS, Bundle().apply { putInt("minutes", remainingMin) }),
                        )
                    }
                    if (customCommand.customAction == STOP_CLEAR) {
                        save(player.currentMediaItem, player.currentPosition)
                        clearSessionPlayback()
                        return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
                    }
                    if (customCommand.customAction != SLEEP) {
                        return super.onCustomCommand(session, controller, customCommand, args)
                    }
                    val minutes = args.getInt("minutes")
                    if (minutes !in 0..60) {
                        return Futures.immediateFuture(SessionResult(SessionError.ERROR_BAD_VALUE))
                    }
                    sleep?.cancel()
                    if (minutes == 0) {
                        sleep = null
                        sleepEndElapsedMs = 0L
                    } else {
                        sleepEndElapsedMs = SystemClock.elapsedRealtime() + minutes * 60_000L
                        sleep = work.launch {
                            delay(minutes * 60_000L)
                            sleepEndElapsedMs = 0L
                            player.pause()
                        }
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
            repository.connectionRoutes.changes.collectLatest {
                val owner = repository.session.cacheScope() ?: return@collectLatest
                val endpoint = repository.session.endpoint ?: return@collectLatest
                if (player.mediaItemCount == 0) return@collectLatest
                val previous = (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }
                if (identity(previous.firstOrNull())?.first != owner) return@collectLatest
                val rebuilt = previous.map { item ->
                    val book = item.mediaMetadata.extras?.getString("bookId") ?: return@collectLatest
                    val file = item.mediaMetadata.extras?.getInt("fileIndex") ?: return@collectLatest
                    val url = endpoint.newBuilder().addPathSegments("api/v1/books").addPathSegment(book)
                        .addPathSegments("audiobook/files/$file/stream").build()
                    item.buildUpon().setUri(url.toString()).build()
                }
                val index = player.currentMediaItemIndex
                val position = player.currentPosition
                val autoplay = player.playWhenReady
                player.setMediaItems(rebuilt, index.coerceIn(rebuilt.indices), position)
                player.prepare()
                player.playWhenReady = autoplay
            }
        }
        work.launch {
            repository.session.invalidations.collect { selection ->
                yield()
                if (selection != repository.session.requestState()?.selection.orEmpty()) return@collect
                clearSessionPlayback()
            }
        }
        work.launch {
            repository.session.profiles.drop(1).collect { owner ->
                yield()
                if (owner != repository.session.cacheScope()) return@collect
                val activeOwner = identity(player.currentMediaItem)?.first
                if (activeOwner != null && activeOwner != owner) {
                    clearSessionPlayback()
                }
            }
        }
    }

    private fun clearSessionPlayback() {
        started = null
        checkpoint = null
        checkpointKey = null
        checkpointToken = null
        sleep?.cancel()
        sleep = null
        sleepEndElapsedMs = 0L
        player.stop()
        player.clearMediaItems()
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
        val initialVersion = extras.getInt("baseVersion", -1).takeIf { it >= 0 }
        val initialIntent = extras.getString("intent") ?: "resume"
        val syncToken = extras.getString("syncToken")
        work.launch {
            progressLock.withLock {
                if (key.first != repository.session.cacheScope()) return@withLock
                try {
                    if (checkpointKey != key || checkpointToken != syncToken) {
                        val sync = BookSync(repository, key.second, "listening", initialVersion, initialIntent)
                        if (initialVersion == null) sync.load()
                        checkpoint = sync
                        checkpointKey = key
                        checkpointToken = syncToken
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
        executor.shutdown()
        super.onDestroy()
    }

    companion object {
        const val SLEEP = "wildstring.book.sleep"
        const val SLEEP_STATUS = "wildstring.book.sleep.status"
        const val STOP_CLEAR = "wildstring.book.stop"
    }
}
