package com.wildstring.app.playback

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
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import dagger.hilt.android.AndroidEntryPoint
import com.wildstring.app.MainActivity
import com.wildstring.app.data.*
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient
import okhttp3.Request

fun Track.mediaItem(repository: Repository, entryId: String = UUID.randomUUID().toString()): MediaItem =
    MediaItem.Builder().setMediaId(entryId).setUri(repository.stream(id))
        .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album)
            .setDurationMs(durationMs.takeIf { it > 0 })
            .setArtworkUri(if (hasCover) Uri.parse(repository.cover(id)) else null)
            .setExtras(Bundle().apply { putString("profile", repository.session.cacheScope()); putString("track_id", id); putLong("duration_ms", durationMs); putString("format", format); putString("original_stream", repository.originalStream(id)) }).build()).build()

@OptIn(UnstableApi::class)
@AndroidEntryPoint
class PlaybackService : MediaSessionService() {
    @Inject lateinit var repository: Repository
    @Inject lateinit var audioCache: AudioCache
    @Inject lateinit var health: PlaybackHealth
    @Inject lateinit var resolver: PlaybackResolver
    @Inject lateinit var sharing: PlaybackSharing
    @Inject lateinit var podcastProgress: PodcastProgress
    @Inject lateinit var sleep: SleepTimer
    @Inject lateinit var settings: AppSettings
    private lateinit var player: AbsolutePlayer
    private lateinit var engine: ExoPlayer
    private val gainProcessor = GainAudioProcessor()
    private var gainRequest: Job? = null
    private var podcastStart: Job? = null
    private var preparingPodcast = false
    private var applyingPodcast = false
    private var progressEntry: String? = null
    private var podcastGeneration = 0L
    private val consumedPodcastIntents = mutableSetOf<String>()
    private fun checkpointPodcast(event: String, force: Boolean = false) {
        if (restoring || preparingPodcast || applyingPodcast) return
        val item = player.currentMediaItem ?: return
        if (item.mediaId != progressEntry || item.mediaMetadata.extras?.getString("profile") != repository.session.cacheScope()) return
        val id = podcastEpisodeId(item.mediaMetadata.extras?.getString("track_id")) ?: return
        podcastProgress.checkpoint(id, player.currentPosition, player.duration, event, force)
    }
    private fun preparePodcast(automatic: Boolean = false, requestedMs: Long? = null, autoplay: Boolean = true) {
        if (restoring || preparingPodcast || applyingPodcast) return
        val item = player.currentMediaItem ?: return
        val extras = item.mediaMetadata.extras ?: return
        val id = podcastEpisodeId(extras.getString("track_id")) ?: return
        val owner = extras.getString("profile") ?: return
        if (owner != repository.session.cacheScope()) return
        checkpointPodcast(if (player.playbackState == Player.STATE_ENDED) "ended" else "pause", true)
        val generation = ++podcastGeneration
        preparingPodcast = true
        player.pause()
        val explicit = requestedMs ?: if (consumedPodcastIntents.add(item.mediaId) && extras.containsKey("podcast_requested_position")) extras.getLong("podcast_requested_position") else null
        podcastStart = scope.launch {
            try {
                val position = podcastProgress.prepare(id, item.mediaMetadata.title?.toString().orEmpty(), extras.getLong("duration_ms"), explicit, automatic) ?: return@launch
                if (owner != repository.session.cacheScope() || player.currentMediaItem?.mediaId != item.mediaId) return@launch
                applyingPodcast = true
                player.seekTo(position)
                progressEntry = item.mediaId
                if (autoplay) player.play()
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { podcastProgress.playbackProblem() }
            finally { if (generation == podcastGeneration) { applyingPodcast = false; preparingPodcast = false } }
        }
    }

    private fun refreshGain() {
        gainRequest?.cancel()
        val item = engine.currentMediaItem ?: return
        val track = item.mediaMetadata.extras?.getString("track_id") ?: return
        if (podcastEpisodeId(track) != null) { gainProcessor.factor = 1f; return }
        val owner = repository.session.cacheScope() ?: return
        if (item.mediaMetadata.extras?.getString("profile") != owner) { gainProcessor.factor = 1f; return }
        gainRequest = scope.launch {
            fun apply(value: com.google.gson.JsonObject?) {
                if (owner == repository.session.cacheScope() && engine.currentMediaItem?.mediaId == item.mediaId)
                    gainProcessor.factor = value?.get("factor")?.takeUnless { it.isJsonNull }?.asFloat?.takeIf { it.isFinite() }?.coerceIn(0.001f, 32f) ?: 1f
            }
            runCatching { repository.cachedPlaybackGain(track) }.getOrNull()?.let(::apply)
            try { apply(repository.playbackGain(track)) }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { /* Original playback and cached gain survive network failure. */ }
        }
    }
    private var session: MediaSession? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val saveMutex = Mutex()
    private val executor = MoreExecutors.listeningDecorator(Executors.newFixedThreadPool(2))
    private var clock = ListeningClock()
    private var listeningStarted = System.currentTimeMillis() / 1000.0
    private var listeningId = UUID.randomUUID().toString()
    private var listeningOwner: String? = null
    private var queueOwner: String? = null
    private var listeningTrack: String? = null
    private var listeningEntry: String? = null
    private var sentMs = 0L
    private var restoring = true
    private var lastSavedQueue: List<QueueEntry>? = null
    private var queueEntries: List<QueueEntry> = emptyList()

    override fun onCreate() {
        super.onCreate()
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParameters: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(gainProcessor)).setEnableFloatOutput(false)
                    .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParameters).build()
        }
        engine = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(resolver.factory(audioCache.factory(repository.client))))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_NETWORK).build()
        player = AbsolutePlayer(engine, resolver)
        engine.addAnalyticsListener(object : AnalyticsListener {
            override fun onAudioUnderrun(eventTime: AnalyticsListener.EventTime, bufferSize: Int, bufferSizeMs: Long, elapsedSinceLastFeedMs: Long) { health.audioUnderruns.incrementAndGet() }
        })
        val activity = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        session = MediaSession.Builder(this, player).setSessionActivity(activity)
            .setBitmapLoader(AuthenticatedBitmapLoader(repository, executor))
            .setCallback(object : MediaSession.Callback {
                override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> {
                    val owner = repository.session.cacheScope()
                    return if (owner != null && mediaItems.all { it.mediaMetadata.extras?.getString("profile") == owner })
                        com.google.common.util.concurrent.Futures.immediateFuture(mediaItems)
                    else com.google.common.util.concurrent.Futures.immediateFailedFuture(SecurityException("服务器或账号已变化。"))
                }
                override fun onConnectAsync(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.ConnectionResult> {
                    val result = if (controller.uid == Process.myUid()) {
                        MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller).build()
                    } else if (!controller.isTrusted) {
                        MediaSession.ConnectionResult.reject()
                    } else {
                        val commands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                            .remove(Player.COMMAND_SET_MEDIA_ITEM).remove(Player.COMMAND_CHANGE_MEDIA_ITEMS).build()
                        MediaSession.ConnectionResult.AcceptedResultBuilder(session, controller).setAvailablePlayerCommands(commands).build()
                    }
                    return com.google.common.util.concurrent.Futures.immediateFuture(result)
                }
            }).build()
        val platform = android.media.session.MediaController(this, checkNotNull(session).platformToken)
        health.diagnostics = {
            val metadata = platform.metadata
            val state = platform.playbackState
            val current = engine.currentMediaItem?.localConfiguration?.uri?.toString()
            val plan = current?.let(resolver::plan)
            PlaybackDiagnosticSnapshot(com.wildstring.app.BuildConfig.VERSION_NAME, android.os.Build.MANUFACTURER,
                android.os.Build.MODEL, android.os.Build.VERSION.SDK_INT, SystemClock.elapsedRealtime(), settings.state.value.aacBitrate,
                plan?.mode?.takeIf { it in listOf("original", "transcode") } ?: if (current?.let(PlaybackRequest::isAac) == true) "unresolved" else "original",
                (plan?.output?.codec ?: engine.currentMediaItem?.mediaMetadata?.extras?.getString("format"))
                    ?.takeIf { it.matches(Regex("[a-zA-Z0-9_-]{1,20}")) } ?: "unknown",
                metadata?.takeIf { it.containsKey(android.media.MediaMetadata.METADATA_KEY_DURATION) }
                    ?.getLong(android.media.MediaMetadata.METADATA_KEY_DURATION)?.takeIf { it >= 0 },
                state?.position?.takeIf { it >= 0 }, state?.playbackSpeed, state?.state, state?.actions,
                state?.actions?.and(android.media.session.PlaybackState.ACTION_SEEK_TO) != 0L && state != null,
                state?.lastPositionUpdateTime, player.duration.takeIf { it >= 0 }, player.currentPosition,
                player.isCurrentMediaItemLive, player.isCurrentMediaItemSeekable,
                engine.duration.takeIf { it >= 0 }, engine.isCurrentMediaItemLive, engine.isCurrentMediaItemSeekable)
        }
        player.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                gainProcessor.factor = 1f; refreshGain()
                if (mediaItem?.mediaId == listeningEntry && reason == Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) return
                if (reason in listOf(Player.MEDIA_ITEM_TRANSITION_REASON_AUTO, Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)) completeFeedback()
                if (sleep.state.value.endsOnTransition(listeningEntry, mediaItem?.mediaId,
                    reason in listOf(Player.MEDIA_ITEM_TRANSITION_REASON_AUTO, Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT))) {
                    player.pause(); sleep.cancel()
                } else if (sleep.state.value.entryId == listeningEntry && mediaItem?.mediaId != listeningEntry &&
                    reason !in listOf(Player.MEDIA_ITEM_TRANSITION_REASON_AUTO, Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT)) {
                    sleep.cancel()
                }
                podcastGeneration++; podcastStart?.cancel(); preparingPodcast = false; applyingPodcast = false; progressEntry = null
                if (podcastEpisodeId(mediaItem?.mediaMetadata?.extras?.getString("track_id")) == null) podcastProgress.leave()
                listeningEntry = mediaItem?.mediaId
                report()
                clock = ListeningClock(); sentMs = 0; listeningId = UUID.randomUUID().toString(); listeningStarted = System.currentTimeMillis() / 1000.0
                listeningOwner = mediaItem?.mediaMetadata?.extras?.getString("profile")
                listeningTrack = mediaItem?.mediaMetadata?.extras?.getString("track_id")
                clock.reset(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                persist()
                if (player.playWhenReady) preparePodcast(automatic = reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
            }
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, false)
                    checkpointPodcast("ended", true)
                    completeFeedback(); report()
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, isPlaying)
                checkpointPodcast(if (player.playbackState == Player.STATE_ENDED) "ended" else if (isPlaying) "progress" else "pause", !isPlaying)
                report(); persist(force = !isPlaying)
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (playWhenReady && preparingPodcast && !applyingPodcast) { player.pause(); return }
                val podcast = podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) != null
                if (playWhenReady && podcast && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST) preparePodcast()
                else if (playWhenReady && !podcast) sharing.localPlaybackStarted()
                else if (!playWhenReady) { checkpointPodcast(if (player.playbackState == Player.STATE_ENDED) "ended" else "pause", true); persist(force = true) }
            }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) {
                val oldItem = oldPosition.mediaItem
                if (!restoring && !preparingPodcast && !applyingPodcast && oldItem?.mediaId == progressEntry) {
                    val oldExtras = oldItem?.mediaMetadata?.extras
                    if (oldExtras?.getString("profile") == repository.session.cacheScope()) podcastEpisodeId(oldExtras?.getString("track_id"))?.let { id ->
                        if (oldItem?.mediaId != newPosition.mediaItem?.mediaId) podcastProgress.checkpoint(id, oldPosition.positionMs,
                            oldExtras?.getLong("duration_ms") ?: 0, if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION) "ended" else "stop", true)
                    }
                }
                if (reason == Player.DISCONTINUITY_REASON_SEEK && oldPosition.mediaItem?.mediaId == newPosition.mediaItem?.mediaId && !preparingPodcast && !applyingPodcast && !restoring) {
                    if (player.currentMediaItem?.mediaId == progressEntry && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id"))?.let(podcastProgress::owns) == true) checkpointPodcast("seek", true)
                    else preparePodcast(requestedMs = newPosition.positionMs, autoplay = player.playWhenReady)
                }
                if (oldPosition.mediaItem?.mediaMetadata?.extras?.getString("track_id") == listeningTrack && oldPosition.mediaItem?.mediaMetadata?.extras?.getString("profile") == listeningOwner) {
                    clock.sample(SystemClock.elapsedRealtime(), oldPosition.positionMs, false)
                    report()
                }
                clock.reset(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                persist()
            }
            override fun onTimelineChanged(timeline: androidx.media3.common.Timeline, reason: Int) {
                if (player.mediaItemCount > 0) queueOwner = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaMetadata.extras?.getString("profile") }.distinct().singleOrNull()
                queueEntries = (0 until player.mediaItemCount).map { index ->
                    val item = player.getMediaItemAt(index)
                    QueueEntry(item.mediaId, item.mediaMetadata.extras?.getString("track_id") ?: "", index)
                }.filter { it.trackId.isNotBlank() }
                persist()
            }
        })
        scope.launch {
            while (isActive) {
                delay(500)
                val timer = sleep.state.value
                if (timer.expired(SystemClock.elapsedRealtime()) || (timer.entryId != null && player.playbackState == Player.STATE_ENDED)) {
                    player.pause(); sleep.cancel()
                }
            }
        }
        scope.launch { resolver.changes.collect { player.refreshResolution() } }
        scope.launch { settings.gainRevision.collect { refreshGain() } }
        scope.launch { settings.state.map { it.aacBitrate }.distinctUntilChanged().drop(1).collect { player.quality(it) } }
        scope.launch { repository.session.invalidations.collect { selection ->
            // StateFlow/SharedFlow can resume Main.immediate inline while SessionStore holds its monitor.
            yield()
            if (selection != repository.session.requestState()?.selection.orEmpty()) return@collect
            discardPlaybackOwner()
            sleep.cancel(); player.stop(); player.clearMediaItems()
            saveMutex.withLock { withContext(Dispatchers.IO) { repository.database.queue().clear() }; lastSavedQueue = null }
        } }
        scope.launch { repository.session.profiles.drop(1).collect { owner ->
            yield()
            if (owner != repository.session.cacheScope()) return@collect
            if (owner != null && queueOwner == owner) return@collect
            discardPlaybackOwner()
            sleep.cancel(); player.stop(); player.clearMediaItems()
            saveMutex.withLock { withContext(Dispatchers.IO) { repository.database.queue().clear() }; lastSavedQueue = null }
        } }
        scope.launch {
            while (isActive) {
                delay(5_000)
                clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                checkpointPodcast("progress")
                podcastProgress.retry()
                report(); persist()
            }
        }
        scope.launch { try { restore() } finally { restoring = false; persist() } }
    }

    private fun discardPlaybackOwner() {
        podcastGeneration++; podcastStart?.cancel(); podcastProgress.leave(); progressEntry = null
        gainRequest?.cancel(); gainProcessor.factor = 1f
        listeningOwner = null; queueOwner = null; listeningTrack = null; listeningEntry = null
        queueEntries = emptyList(); clock = ListeningClock(); sentMs = 0
    }
    private fun completeFeedback() {
        val id = listeningTrack ?: return
        if (podcastEpisodeId(id) != null) return
        val profile = listeningOwner ?: return
        if (profile != repository.session.cacheScope()) return
        if (clock.totalMs < 5_000) return
        val event = RecommendationFeedback(eventId = listeningId, trackId = id, action = "complete")
        scope.launch {
            if (profile != repository.session.cacheScope()) return@launch
            runCatching { repository.api().recommendationFeedback(event, RequestOwner(profile)).close() }
        }
    }
    private fun report() {
        val id = listeningTrack ?: return
        if (podcastEpisodeId(id) != null) return
        val profile = listeningOwner ?: return
        if (profile != repository.session.cacheScope()) return
        val value = clock.totalMs
        if (value <= sentMs) return
        val report = ListeningRequest(listeningId, id, value, listeningStarted, if (player.playbackState == Player.STATE_ENDED) "ended" else if (player.isPlaying) "playing" else "paused")
        sentMs = value
        scope.launch {
            if (profile != repository.session.cacheScope()) return@launch
            try { repository.api().listening(report, RequestOwner(profile)).close() }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { if (listeningId == report.sessionId) sentMs = 0 }
        }
    }

    private fun persist(force: Boolean = false) {
        if (restoring) return
        val endpoint = repository.session.endpoint?.toString() ?: return
        val profile = queueOwner ?: return
        if (profile != repository.session.cacheScope()) return
        val entries = queueEntries
        val shared = SharedPlayback(trackIds = entries.map { it.trackId }, index = player.currentMediaItemIndex.coerceAtLeast(0),
            positionMs = player.currentPosition.coerceAtLeast(0), playbackState = if (player.playbackState == Player.STATE_ENDED) "ended" else if (player.playWhenReady) "playing" else "paused", mode = if (player.shuffleModeEnabled) "shuffle" else when (player.repeatMode) {
                Player.REPEAT_MODE_ONE -> "repeat_one"; Player.REPEAT_MODE_ALL -> "repeat_all"; else -> "sequential"
            })
        if (shared.trackIds.isNotEmpty()) scope.launch {
            try { if (profile == repository.session.cacheScope()) sharing.publish(shared, force = force) }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { /* Sharing failure never interrupts the local queue. */ }
        }
        val position = SavedPosition(endpoint = endpoint, entryId = player.currentMediaItem?.mediaId, positionMs = player.currentPosition.coerceAtLeast(0))
        scope.launch { saveMutex.withLock {
            if (profile != repository.session.cacheScope() || endpoint != repository.session.endpoint?.toString()) return@withLock
            withContext(Dispatchers.IO) {
                if (lastSavedQueue == entries) repository.database.queue().insertPosition(position)
                else repository.database.queue().save(entries, position)
            }
            lastSavedQueue = entries
        } }
    }

    private suspend fun restore() {
        try {
            val profile = repository.session.cacheScope() ?: return
            val dao = repository.database.queue()
            val (saved, entries) = withContext(Dispatchers.IO) { dao.position() to dao.entries() }
            if (saved == null || saved.endpoint != repository.session.endpoint?.toString() || entries.isEmpty()) return
            val offline = try { if (!repository.api().status().authenticated) return; false }
            catch (error: IOException) { if (error is javax.net.ssl.SSLException || repository.session.cacheScope() != profile) return; true }
            val items = mutableListOf<MediaItem>()
            for (entry in entries.take(5000)) {
                if (player.mediaItemCount != 0) { return }
                try {
                    val track = (if (offline) repository.cachedTrack(entry.trackId) else repository.track(entry.trackId)) ?: continue
                    if (track.status == "available") items += track.mediaItem(repository, entry.entryId)
                } catch (error: retrofit2.HttpException) {
                    if (error.code() != 404 && error.code() != 409) throw error
                }
            }
            if (items.isEmpty() || player.mediaItemCount != 0 || saved.endpoint != repository.session.endpoint?.toString() || repository.session.cacheScope() != profile) return
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
        checkpointPodcast(if (player.playbackState == Player.STATE_ENDED) "ended" else "stop", true)
        scope.cancel()
        health.diagnostics = null
        session?.release(); session = null
        player.release(); executor.shutdown()
        super.onDestroy()
    }
}

@OptIn(UnstableApi::class)
private class AuthenticatedBitmapLoader(private val repository: Repository, private val executor: ListeningExecutorService) : BitmapLoader {
    override fun supportsMimeType(mimeType: String): Boolean = mimeType.startsWith("image/")
    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Invalid cover")
    }
    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        repository.imageClient(uri.toString()).newCall(Request.Builder().url(uri.toString()).build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Cover unavailable")
            val body = response.body
            if (body.contentLength() > 2 * 1024 * 1024) throw IOException("Cover too large")
            val source = body.source()
            source.request(2 * 1024 * 1024L + 1)
            if (source.buffer.size > 2 * 1024 * 1024) throw IOException("Cover too large")
            val bytes = source.readByteArray()
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw IOException("Invalid cover")
        }
    }
}
