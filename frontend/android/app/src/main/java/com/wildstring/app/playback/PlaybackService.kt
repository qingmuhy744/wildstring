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
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.mp3.Mp3Extractor
import com.wildstring.app.AppLanguage
import com.wildstring.app.R
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
import kotlin.math.pow
import java.util.concurrent.Executors
import javax.inject.Inject
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

fun List<Track>.mediaItems(repository: Repository, heart: HeartBatch? = null): List<MediaItem> {
    if (isEmpty()) return emptyList()
    val endpoint = repository.requireEndpoint()
    val network = if (any { it.podcastEpisodeId != null }) repository.podcastNetwork() else null
    return map { it.mediaItem(repository, podcastNetwork = network, endpoint = endpoint, heart = heart) }
}

fun Track.mediaItem(repository: Repository, entryId: String = UUID.randomUUID().toString(), podcastNetwork: String? = null, endpoint: HttpUrl = repository.requireEndpoint(), heart: HeartBatch? = null): MediaItem {
    val original = repository.originalStream(id, podcastNetwork, endpoint)
    return MediaItem.Builder().setMediaId(entryId).setUri(repository.stream(id, original))
        .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setArtist(artist).setAlbumTitle(album)
            .setDurationMs(durationMs.takeIf { it > 0 })
            .setArtworkUri(if (mayHaveCover) Uri.parse(repository.cover(id, endpoint)) else null)
            .setExtras(Bundle().apply {
                heart?.write(this)
                putString("profile", repository.session.cacheScope())
                putString("track_id", id)
                podcast?.let { putString("podcast_id", it.podcastId) }
                putLong("duration_ms", durationMs)
                putString("format", format)
                putString("original_stream", original)
                podcast?.resumePositionMs?.takeIf { it > 0L }?.let { putLong("podcast_fallback_position", it) }
            }).build()).build()
}

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
    private var podcastAdvance: Job? = null
    private var preparingPodcast = false
    private var preparingPodcastEntry: String? = null
    private var automaticPodcastEntry: String? = null
    private var pendingPodcastAutoplay = false
    private var applyingPodcast = false
    private var progressEntry: String? = null
    private var restoredPodcastEntry: String? = null
    private var resumeSeekMs: Long? = null
    private var podcastGeneration = 0L
    private val consumedPodcastIntents = mutableSetOf<String>()
    private fun checkpointPodcast(event: String, force: Boolean = false) {
        if (restoring || preparingPodcast || applyingPodcast) return
        val item = player.currentMediaItem ?: return
        if (item.mediaId != progressEntry || item.mediaMetadata.extras?.getString("profile") != repository.session.cacheScope()) return
        val id = podcastEpisodeId(item.mediaMetadata.extras?.getString("track_id")) ?: return
        podcastProgress.checkpoint(id, player.currentPosition, player.duration, event, force)
    }
    private fun preparePodcast(automatic: Boolean = false, requestedMs: Long? = null, autoplay: Boolean = true,
        start: PodcastStart = if (automatic) PodcastStart.AUTOMATIC else PodcastStart.SELECT) {
        if (restoring || applyingPodcast || (preparingPodcast && requestedMs == null)) return
        val item = player.currentMediaItem ?: return
        val extras = item.mediaMetadata.extras ?: return
        val id = podcastEpisodeId(extras.getString("track_id")) ?: return
        val owner = extras.getString("profile") ?: return
        if (owner != repository.session.cacheScope()) return
        if (!preparingPodcast) {
            checkpointPodcast(if (player.playbackState == Player.STATE_ENDED) "ended" else "pause", true)
            pendingPodcastAutoplay = autoplay
        } else {
            podcastStart?.cancel()
            pendingPodcastAutoplay = pendingPodcastAutoplay || autoplay
        }
        val generation = ++podcastGeneration
        preparingPodcast = true
        preparingPodcastEntry = item.mediaId
        engine.pause()
        val explicitIntent = consumedPodcastIntents.add(item.mediaId) && extras.containsKey("podcast_requested_position")
        val explicit = requestedMs ?: if (explicitIntent) extras.getLong("podcast_requested_position") else null
        val fallback = player.currentPosition.coerceAtLeast(0L).takeIf { it > 0L }
            ?: extras.getLong("podcast_fallback_position", 0L).takeIf { it > 0L }
        podcastStart = scope.launch {
            var completed = false
            var completedAutoplay = false
            try {
                val automaticNext = podcastProgress.consumeAutomaticNext(id)
                val preparation = podcastProgress.prepare(id, item.mediaMetadata.title?.toString().orEmpty(), extras.getLong("duration_ms"), explicit, automatic || automaticNext, fallback, explicitRestart = explicitIntent && explicit == 0L,
                    start = if (automatic || automaticNext) PodcastStart.AUTOMATIC else start) ?: return@launch
                if (owner != repository.session.cacheScope() || player.currentMediaItem?.mediaId != item.mediaId) return@launch
                if (preparation == PodcastPreparation.Completed) {
                    completed = true
                    completedAutoplay = pendingPodcastAutoplay && start != PodcastStart.RESUME
                } else {
                    applyingPodcast = true
                    // Podcast streams use the original timeline. The controller-facing wrapper
                    // can omit SEEK until the source is ready; ExoPlayer retains an early seek.
                    engine.seekTo((preparation as PodcastPreparation.Play).positionMs)
                    progressEntry = item.mediaId
                    restoredPodcastEntry = null
                    resumeSeekMs = null
                    if (pendingPodcastAutoplay) player.play()
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { podcastProgress.playbackProblem() }
            finally { if (generation == podcastGeneration) { applyingPodcast = false; preparingPodcast = false; preparingPodcastEntry = null; pendingPodcastAutoplay = false } }
            if (completed) {
                if (completedAutoplay) advancePodcast(completedRead = true) else podcastProgress.completed()
            }
        }
    }

    /** The service owns episode boundaries even when there is no Activity or ViewModel. */
    private fun advancePodcast(completedRead: Boolean) {
        if (podcastAdvance?.isActive == true) return
        val item = player.currentMediaItem ?: return
        val extras = item.mediaMetadata.extras ?: return
        val id = podcastEpisodeId(extras.getString("track_id")) ?: return
        val owner = repository.session.cacheScope() ?: return
        if (extras.getString("profile") != owner) return
        engine.pause()
        if (sleep.state.value.entryId == item.mediaId || sleep.state.value.expired(SystemClock.elapsedRealtime())) {
            sleep.cancel()
            return
        }
        podcastAdvance = scope.launch {
            try {
                if (!completedRead) {
                    if (!podcastProgress.finish(id, player.currentPosition, player.duration)) return@launch
                    if (owner != repository.session.cacheScope() || player.currentMediaItem?.mediaId != item.mediaId) return@launch
                    try {
                        val queue = repository.podcastQueue()
                        if (queue.items.any { it.episodeId == id }) {
                            repository.replacePodcastQueue(queue.version, podcastProgress.deviceId(), podcastQueueRemoveEpisode(queue.items, id))
                            podcastProgress.queueChanged()
                        }
                    } catch (error: CancellationException) { throw error }
                    catch (_: Exception) { podcastProgress.syncProblem() }
                }
                if (owner != repository.session.cacheScope() || player.currentMediaItem?.mediaId != item.mediaId) return@launch
                if (extras.getBoolean("podcast_queue_context")) {
                    if (player.hasNextMediaItem()) {
                        automaticPodcastEntry = player.getMediaItemAt(player.nextMediaItemIndex).mediaId
                        player.seekToNextMediaItem()
                    } else if (completedRead) podcastProgress.completed()
                    return@launch
                }
                val episode = repository.cachedPodcastEpisode(id) ?: repository.podcastEpisode(id)
                val detail = repository.cachedPodcastDetail(episode.podcastId) ?: repository.podcastDetail(episode.podcastId)
                val preferences = try { repository.podcastQueuePreferences() }
                    catch (error: CancellationException) { throw error }
                    catch (_: Exception) { null }
                val preference = podcastContinuePreferenceFor(preferences, episode.podcastId, settings.podcastContinuePreference())
                val next = if (completedRead) podcastManualNeighbor(episode, detail, preference, 1, podcastProgress.positions.value)
                    else nextEpisode(episode, detail, podcastProgress.positions.value, preference)
                if (owner != repository.session.cacheScope() || player.currentMediaItem?.mediaId != item.mediaId) return@launch
                if (next == null) {
                    if (completedRead) podcastProgress.completed()
                    return@launch
                }
                val index = (0 until player.mediaItemCount).firstOrNull {
                    podcastEpisodeId(player.getMediaItemAt(it).mediaMetadata.extras?.getString("track_id")) == next.id
                }
                if (index != null) {
                    automaticPodcastEntry = player.getMediaItemAt(index).mediaId
                    player.seekTo(index, 0)
                } else {
                    val target = repository.rememberPodcastEpisode(next, detail.podcast).mediaItem(repository)
                    automaticPodcastEntry = target.mediaId
                    player.setMediaItem(target)
                    player.prepare()
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { podcastProgress.playbackProblem() }
        }
    }

    private fun refreshGain() {
        gainRequest?.cancel()
        gainProcessor.factor = 1f
        val item = engine.currentMediaItem ?: return
        val track = item.mediaMetadata.extras?.getString("track_id") ?: return
        val owner = repository.session.cacheScope() ?: return
        if (item.mediaMetadata.extras?.getString("profile") != owner) { gainProcessor.factor = 1f; return }
        if (podcastEpisodeId(track) != null) {
            item.mediaMetadata.extras?.getString("podcast_id")?.let { podcastId ->
                gainProcessor.factor = 10.0.pow(settings.podcastGainDb(podcastId) / 20.0).toFloat()
            }
            return
        }
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
    private val heart by lazy { HeartPlayback(repository, player, sleep, scope) }
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
    private val playbackContextPrefs by lazy { getSharedPreferences("playback-context", MODE_PRIVATE) }

    override fun onCreate() {
        super.onCreate()
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: android.content.Context, enableFloatOutput: Boolean, enableAudioOutputPlaybackParameters: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(gainProcessor)).setEnableFloatOutput(false)
                    .setEnableAudioOutputPlaybackParameters(enableAudioOutputPlaybackParameters).build()
        }
        val extractors = DefaultExtractorsFactory()
            .setConstantBitrateSeekingEnabled(true)
            .setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_CONSTANT_BITRATE_SEEKING)
        val loadControl = DefaultLoadControl.Builder()
            .setBackBuffer(180_000, false)
            .setBufferDurationsMs(30_000, 180_000, 1_500, 3_000)
            .build()
        engine = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(resolver.factory(audioCache.factory(repository.client)), extractors))
            .setLoadControl(loadControl)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_NETWORK).build()
        player = AbsolutePlayer(engine, resolver)
        player.onPlayWhenReadyRequested = { playWhenReady ->
            val item = player.currentMediaItem
            val podcast = podcastEpisodeId(item?.mediaMetadata?.extras?.getString("track_id")) != null
            if (podcast && !applyingPodcast) {
                if (playWhenReady) {
                    podcastAdvance?.cancel(); podcastAdvance = null
                    if (restoring) pendingPodcastAutoplay = true
                    else if (preparingPodcast) pendingPodcastAutoplay = true
                    else if (!player.playWhenReady) preparePodcast(requestedMs = resumeSeekMs,
                        start = if (progressEntry == item?.mediaId || restoredPodcastEntry == item?.mediaId) PodcastStart.RESUME else PodcastStart.SELECT)
                    restoring || preparingPodcast
                } else {
                    podcastAdvance?.cancel(); podcastAdvance = null
                    pendingPodcastAutoplay = false
                    automaticPodcastEntry = null
                    if (preparingPodcast) {
                        podcastGeneration++; podcastStart?.cancel(); preparingPodcast = false; preparingPodcastEntry = null
                    }
                    false
                }
            } else false
        }
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
                    else com.google.common.util.concurrent.Futures.immediateFailedFuture(SecurityException(AppLanguage.string(R.string.pb_svc_server_or_account_changed)))
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
            override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
                if (error.errorCode in listOf(androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, androidx.media3.common.PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT)) {
                    val address = repository.session.activeRouteUrl
                    scope.launch { repository.connectionRoutes.playbackConnectionFailed(address) }
                }
            }
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                heart.cancel()
                engine.setPauseAtEndOfMediaItems(podcastEpisodeId(mediaItem?.mediaMetadata?.extras?.getString("track_id")) != null)
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
                val automatic = automaticPodcastEntry == mediaItem?.mediaId
                if (automatic) automaticPodcastEntry = null
                if (!preparingPodcast || preparingPodcastEntry != mediaItem?.mediaId) {
                    podcastGeneration++; podcastStart?.cancel(); preparingPodcast = false; preparingPodcastEntry = null
                    if (!restoring) pendingPodcastAutoplay = false
                    applyingPodcast = false; progressEntry = null; resumeSeekMs = null
                    restoredPodcastEntry = restoredPodcastEntry?.takeIf { it == mediaItem?.mediaId }
                }
                if (podcastEpisodeId(mediaItem?.mediaMetadata?.extras?.getString("track_id")) == null) podcastProgress.leave()
                listeningEntry = mediaItem?.mediaId
                report()
                clock = ListeningClock(); sentMs = 0; listeningId = UUID.randomUUID().toString(); listeningStarted = System.currentTimeMillis() / 1000.0
                listeningOwner = mediaItem?.mediaMetadata?.extras?.getString("profile")
                listeningTrack = mediaItem?.mediaMetadata?.extras?.getString("track_id")
                clock.reset(SystemClock.elapsedRealtime(), player.currentPosition, player.isPlaying)
                persist()
                if (automatic || player.playWhenReady) preparePodcast(automatic = automatic || reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO)
            }
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState != Player.STATE_ENDED) heart.cancel()
                if (playbackState == Player.STATE_IDLE) checkpointPodcast("stop", true)
                else if (playbackState == Player.STATE_ENDED) {
                    clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, false)
                    checkpointPodcast("ended", true)
                    completeFeedback(); report()
                    if (player.currentMediaItem.heartBatch() != null) heart.ended() else advancePodcast(completedRead = false)
                }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                clock.sample(SystemClock.elapsedRealtime(), player.currentPosition, isPlaying)
                // Buffering and transient audio-focus suppression also stop audible playback.
                // Pause/stop/ended checkpoints belong to their actual transport callbacks.
                if (isPlaying) checkpointPodcast("progress")
                report(); persist(force = !isPlaying)
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady) heart.cancel()
                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM) {
                    checkpointPodcast("ended", true)
                    advancePodcast(completedRead = false)
                    return
                }
                val podcast = podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id")) != null
                if (playWhenReady && !podcast) sharing.localPlaybackStarted()
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
                if (reason == Player.DISCONTINUITY_REASON_SEEK && oldPosition.mediaItem?.mediaId == newPosition.mediaItem?.mediaId && !applyingPodcast && !restoring) {
                    if (!player.playWhenReady || preparingPodcast) resumeSeekMs = newPosition.positionMs
                    if (!preparingPodcast && player.currentMediaItem?.mediaId == progressEntry && podcastEpisodeId(player.currentMediaItem?.mediaMetadata?.extras?.getString("track_id"))?.let(podcastProgress::owns) == true) checkpointPodcast("seek", true)
                    else if (preparingPodcast || player.playWhenReady) preparePodcast(requestedMs = newPosition.positionMs,
                        autoplay = if (preparingPodcast) pendingPodcastAutoplay else player.playWhenReady, start = PodcastStart.RESUME)
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
        scope.launch { repository.connectionRoutes.changes.collectLatest {
            val owner = repository.session.cacheScope()
            if (owner == null || queueOwner != owner) return@collectLatest
            val previous = (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }
            val pause = repository.downloads.schedulePause(owner)
            val items = withContext(Dispatchers.IO) {
                pause.join()
                if (owner != repository.session.cacheScope()) return@withContext null
                previous.map { old ->
                    val id = old.mediaMetadata.extras?.getString("track_id").orEmpty()
                    val original = repository.originalStream(id)
                    val extras = Bundle(old.mediaMetadata.extras).apply { putString("original_stream", original) }
                    old.buildUpon().setUri(repository.stream(id, original))
                        .setMediaMetadata(old.mediaMetadata.buildUpon().setExtras(extras).build()).build()
                }
            } ?: return@collectLatest
            if (owner != repository.session.cacheScope() || queueOwner != owner ||
                previous != (0 until player.mediaItemCount).map { player.getMediaItemAt(it) }) return@collectLatest
            if (items.isNotEmpty()) {
                val index = player.currentMediaItemIndex
                val position = player.currentPosition
                val autoplay = player.playWhenReady
                player.setMediaItems(items, index.coerceIn(items.indices), position)
                player.prepare(); player.playWhenReady = autoplay
            }
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
                if (player.isPlaying) checkpointPodcast("progress")
                podcastProgress.retry()
                report(); persist()
            }
        }
        scope.launch { try { restore() } finally {
            restoring = false
            val requested = pendingPodcastAutoplay
            pendingPodcastAutoplay = false
            if (requested) preparePodcast(start = if (restoredPodcastEntry == player.currentMediaItem?.mediaId) PodcastStart.RESUME else PodcastStart.SELECT)
            persist()
        } }
    }

    private fun discardPlaybackOwner() {
        podcastGeneration++; podcastStart?.cancel(); podcastAdvance?.cancel(); podcastProgress.leave(); progressEntry = null
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
        val endpoint = repository.session.servers.value.firstOrNull { it.id == repository.session.activeServerId }?.url ?: return
        val profile = queueOwner ?: return
        if (profile != repository.session.cacheScope()) return
        val storageOwner = repository.session.withStorageScope(profile) { it } ?: return
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
        val firstItem = if (player.mediaItemCount > 0) player.getMediaItemAt(0) else null
        val heartBatch = firstItem.heartBatch()
        val position = SavedPosition(endpoint = endpoint, entryId = player.currentMediaItem?.mediaId, positionMs = player.currentPosition.coerceAtLeast(0))
        val podcastQueueEntries = (0 until player.mediaItemCount).mapNotNull { index ->
            player.getMediaItemAt(index).takeIf { it.mediaMetadata.extras?.getBoolean("podcast_queue_context") == true }?.mediaId
        }.toSet()
        scope.launch { saveMutex.withLock {
            if (profile != repository.session.cacheScope() || endpoint != repository.session.servers.value.firstOrNull { it.id == repository.session.activeServerId }?.url) return@withLock
            withContext(Dispatchers.IO) {
                if (lastSavedQueue == entries) repository.database.queue().insertPosition(position)
                else repository.database.queue().save(entries, position)
            }
            playbackContextPrefs.edit().putStringSet(storageOwner, podcastQueueEntries)
                .putString("heart-anchor:$storageOwner", firstItem?.mediaId.takeIf { heartBatch != null })
                .putString("heart-library:$storageOwner", heartBatch?.library)
                .putBoolean("heart-active:$storageOwner", heartBatch?.recommended == true).apply()
            lastSavedQueue = entries
        } }
    }

    private suspend fun restore() {
        try {
            val profile = repository.session.cacheScope() ?: return
            val storageOwner = repository.session.withStorageScope(profile) { it } ?: return
            val dao = repository.database.queue()
            val (saved, entries) = withContext(Dispatchers.IO) { dao.position() to dao.entries() }
            if (saved == null || saved.endpoint != repository.session.servers.value.firstOrNull { it.id == repository.session.activeServerId }?.url || entries.isEmpty()) return
            val offline = try { if (!repository.api().status().authenticated) return; false }
            catch (error: IOException) { if (error is javax.net.ssl.SSLException || repository.session.cacheScope() != profile) return; true }
            val items = mutableListOf<MediaItem>()
            val podcastQueueEntries = playbackContextPrefs.getStringSet(storageOwner, emptySet()).orEmpty()
            val legacyLong = entries.size > MUSIC_QUEUE_LIMIT && entries.none { podcastEpisodeId(it.trackId) != null }
            val restored = if (legacyLong) entries.drop(entries.indexOfFirst { it.entryId == saved.entryId }.coerceAtLeast(0)).take(MUSIC_QUEUE_LIMIT) else entries.take(5000)
            val heartLibrary = playbackContextPrefs.getString("heart-library:$storageOwner", null)
            val heartBatch = when {
                legacyLong -> HeartBatch(repository.selectedLibraryId)
                heartLibrary != null && playbackContextPrefs.getString("heart-anchor:$storageOwner", null) == entries.first().entryId ->
                    HeartBatch(heartLibrary, recommended = playbackContextPrefs.getBoolean("heart-active:$storageOwner", false))
                else -> null
            }
            for (entry in restored) {
                if (player.mediaItemCount != 0) { return }
                try {
                    val track = (if (offline) repository.cachedTrack(entry.trackId) else repository.track(entry.trackId)) ?: continue
                    if (track.status == "available") {
                        val item = track.mediaItem(repository, entry.entryId, heart = heartBatch)
                        val extras = Bundle(item.mediaMetadata.extras).apply { putBoolean("podcast_queue_context", entry.entryId in podcastQueueEntries) }
                        items += item.buildUpon().setMediaMetadata(item.mediaMetadata.buildUpon().setExtras(extras).build()).build()
                    }
                } catch (error: retrofit2.HttpException) {
                    if (error.code() != 404 && error.code() != 409) throw error
                }
            }
            if (items.isEmpty() || player.mediaItemCount != 0 || saved.endpoint != repository.session.servers.value.firstOrNull { it.id == repository.session.activeServerId }?.url || repository.session.cacheScope() != profile) return
            val index = items.indexOfFirst { it.mediaId == saved.entryId }.coerceAtLeast(0)
            restoredPodcastEntry = items[index].mediaId
            player.setMediaItems(items, index, saved.positionMs)
            player.prepare()
            player.playWhenReady = false
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { /* A failed restore never prevents browsing or fresh playback. */ }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? =
        if (controllerInfo.uid == Process.myUid() || controllerInfo.isTrusted) session else null

    override fun onTaskRemoved(rootIntent: Intent?) {
        checkpointPodcast(if (player.playbackState == Player.STATE_ENDED) "ended" else if (player.playWhenReady) "progress" else "pause", true)
        persist(force = true)
        super.onTaskRemoved(rootIntent)
    }

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
internal class AuthenticatedBitmapLoader(private val repository: Repository, private val executor: ListeningExecutorService) : BitmapLoader {
    override fun supportsMimeType(mimeType: String): Boolean = mimeType.startsWith("image/")
    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Invalid cover")
    }
    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        fetchBitmap(uri.toString())
    }
    private fun fetchBitmap(uri: String): Bitmap =
        repository.client.newCall(Request.Builder().url(uri).build()).execute().use { response ->
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
