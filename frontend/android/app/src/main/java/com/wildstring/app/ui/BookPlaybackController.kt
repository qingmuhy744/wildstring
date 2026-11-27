package com.wildstring.app.ui

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.gson.Gson
import com.wildstring.app.data.BookAudioChapter
import com.wildstring.app.data.BookAudiobookChapterEntity
import com.wildstring.app.data.BookSummary
import com.wildstring.app.data.BookSync
import com.wildstring.app.data.Repository
import com.wildstring.app.data.friendlyError
import com.wildstring.app.playback.BookPlaybackService
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine

internal val BOOK_PLAYBACK_RATES = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f, 2.5f)

data class BookPlaybackState(
    val book: BookSummary? = null,
    val chapters: List<BookAudioChapter> = emptyList(),
    val index: Int = 0,
    val durationMs: Long = 0L,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val loading: Boolean = false,
    val attached: Boolean = false,
    val speed: Float = 1f,
    val sleepMinutes: Int = 0,
    val error: String? = null,
    val syncConflict: Boolean = false,
) {
    val activeChapter: BookAudioChapter? get() = chapters.getOrNull(index)
}

internal interface BookMediaTransport {
    val isConnected: Boolean
    val hasActiveSession: Boolean get() = isConnected
    val currentMediaItem: MediaItem?
    val currentMediaItemIndex: Int
    val currentPosition: Long
    val duration: Long
    val playbackSpeed: Float
    val isPlaying: Boolean
    val playWhenReady: Boolean
    val playbackState: Int
    val playerError: androidx.media3.common.PlaybackException?

    fun connect(onResolved: (Boolean) -> Unit)
    fun addListener(listener: Player.Listener)
    fun removeListener(listener: Player.Listener)
    fun setMediaItems(items: List<MediaItem>, startIndex: Int, startPositionMs: Long)
    fun setPlaybackSpeed(speed: Float)
    fun prepare()
    fun play()
    fun pause()
    fun seekTo(positionMs: Long)
    fun seekTo(mediaItemIndex: Int, positionMs: Long)
    fun requestSleepMinutes(onResult: (Int) -> Unit)
    fun setSleepMinutes(minutes: Int)
    fun stopAndClear()
    fun release()
}

private class MediaControllerBookTransport(private val context: Context) : BookMediaTransport {
    private val token = SessionToken(context, ComponentName(context, BookPlaybackService::class.java))
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var connecting = false
    private val callbacks = mutableListOf<(Boolean) -> Unit>()
    private val listeners = mutableListOf<Player.Listener>()

    override val isConnected: Boolean get() = controller != null
    override val hasActiveSession: Boolean get() = controller != null || BookPlaybackService.isActive
    override val currentMediaItem: MediaItem? get() = controller?.currentMediaItem
    override val currentMediaItemIndex: Int get() = controller?.currentMediaItemIndex ?: 0
    override val currentPosition: Long get() = controller?.currentPosition ?: 0L
    override val duration: Long get() = controller?.duration ?: 0L
    override val playbackSpeed: Float get() = controller?.playbackParameters?.speed ?: 1f
    override val isPlaying: Boolean get() = controller?.isPlaying == true
    override val playWhenReady: Boolean get() = controller?.playWhenReady == true
    override val playbackState: Int get() = controller?.playbackState ?: Player.STATE_IDLE
    override val playerError: androidx.media3.common.PlaybackException? get() = controller?.playerError

    override fun connect(onResolved: (Boolean) -> Unit) {
        if (controller != null) {
            onResolved(true)
            return
        }
        callbacks.add(onResolved)
        if (connecting) return
        connecting = true
        val future = MediaController.Builder(context, token).buildAsync()
        controllerFuture = future
        future.addListener({
            if (controllerFuture !== future) {
                MediaController.releaseFuture(future)
                return@addListener
            }
            val next = runCatching { future.get() }.getOrNull()
            connecting = false
            if (next != null) {
                controller = next
                listeners.forEach { next.addListener(it) }
            } else {
                controllerFuture = null
            }
            val pending = callbacks.toList()
            callbacks.clear()
            pending.forEach { it(next != null) }
        }, ContextCompat.getMainExecutor(context))
    }

    override fun addListener(listener: Player.Listener) {
        if (listener !in listeners) {
            listeners.add(listener)
            controller?.addListener(listener)
        }
    }

    override fun removeListener(listener: Player.Listener) {
        listeners.remove(listener)
        controller?.removeListener(listener)
    }

    override fun setMediaItems(items: List<MediaItem>, startIndex: Int, startPositionMs: Long) {
        controller?.setMediaItems(items, startIndex, startPositionMs)
    }

    override fun setPlaybackSpeed(speed: Float) {
        controller?.setPlaybackSpeed(speed)
    }

    override fun prepare() {
        controller?.prepare()
    }

    override fun play() {
        controller?.play()
    }

    override fun pause() {
        controller?.pause()
    }

    override fun seekTo(positionMs: Long) {
        controller?.seekTo(positionMs)
    }

    override fun seekTo(mediaItemIndex: Int, positionMs: Long) {
        controller?.seekTo(mediaItemIndex, positionMs)
    }

    override fun requestSleepMinutes(onResult: (Int) -> Unit) {
        val c = controller ?: return
        val future = runCatching {
            c.sendCustomCommand(SessionCommand(BookPlaybackService.SLEEP_STATUS, Bundle.EMPTY), Bundle.EMPTY)
        }.getOrNull() ?: return
        future.addListener({
            runCatching { future.get().extras.getInt("minutes", 0) }.onSuccess(onResult)
        }, ContextCompat.getMainExecutor(context))
    }

    override fun setSleepMinutes(minutes: Int) {
        val c = controller ?: return
        c.sendCustomCommand(
            SessionCommand(BookPlaybackService.SLEEP, Bundle.EMPTY),
            Bundle().apply { putInt("minutes", minutes) },
        )
    }

    override fun stopAndClear() {
        val c = controller
        val oldFuture = controllerFuture
        listeners.forEach { c?.removeListener(it) }
        controller = null
        controllerFuture = null
        connecting = false
        val pending = callbacks.toList()
        callbacks.clear()
        pending.forEach { it(false) }
        if (c == null) {
            if (oldFuture != null) MediaController.releaseFuture(oldFuture)
            return
        }
        val commandFuture = runCatching {
            c.sendCustomCommand(SessionCommand(BookPlaybackService.STOP_CLEAR, Bundle.EMPTY), Bundle.EMPTY)
        }.getOrNull()
        if (commandFuture != null && oldFuture != null) {
            commandFuture.addListener({
                MediaController.releaseFuture(oldFuture)
            }, ContextCompat.getMainExecutor(context))
        } else if (oldFuture != null) {
            MediaController.releaseFuture(oldFuture)
        }
    }

    override fun release() {
        val c = controller
        val oldFuture = controllerFuture
        listeners.forEach { c?.removeListener(it) }
        listeners.clear()
        controller = null
        controllerFuture = null
        connecting = false
        val pending = callbacks.toList()
        callbacks.clear()
        pending.forEach { it(false) }
        if (oldFuture != null) MediaController.releaseFuture(oldFuture)
    }
}

internal class BookPlaybackController(
    private val repository: Repository,
    private val scope: CoroutineScope,
    private val context: Context,
    private val onPlayStarted: () -> Unit,
    private val onSessionCleared: () -> Unit,
    private val transport: BookMediaTransport = MediaControllerBookTransport(context),
) {
    private val gson = Gson()
    private val mutableState = MutableStateFlow(BookPlaybackState())
    val state = mutableState.asStateFlow()

    private val mutablePositionMs = MutableStateFlow(0L)
    val positionMs = mutablePositionMs.asStateFlow()

    private var preparedItems: List<MediaItem> = emptyList()
    private var loadJob: Job? = null
    private var pollJob: Job? = null
    private var conflictJob: Job? = null
    private var sleepTick = 0
    private var loadEpoch = 0L

    private val listener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) onPlayStarted()
            syncFromController()
        }

        override fun onPlaybackStateChanged(playbackState: Int) {
            syncFromController()
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            syncFromController()
        }

        override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) {
            syncFromController()
        }

        override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
            syncFromController()
        }
    }

    init {
        if (transport.hasActiveSession) {
            transport.connect { connected ->
                if (connected) {
                    transport.addListener(listener)
                    syncFromController(reconcileService = true)
                }
            }
        }

        conflictJob = scope.launch {
            repository.bookSyncConflict.collect { conflictedId ->
                mutableState.update { prev ->
                    val activeId = prev.book?.id
                    val hasConflict = activeId != null && conflictedId == activeId
                    if (prev.syncConflict == hasConflict) prev else prev.copy(syncConflict = hasConflict)
                }
            }
        }

        pollJob = scope.launch {
            while (isActive) {
                syncFromController()
                delay(350)
            }
        }
    }

    private suspend fun awaitTransport(): BookMediaTransport? {
        if (transport.isConnected) {
            transport.addListener(listener)
            return transport
        }
        return suspendCancellableCoroutine { cont ->
            transport.connect { ok ->
                if (ok) transport.addListener(listener)
                if (cont.isActive) cont.resume(if (ok) transport else null)
            }
        }
    }

    private fun syncFromController(reconcileService: Boolean = false) {
        if (!transport.isConnected) return
        val item = transport.currentMediaItem
        val extras = item?.mediaMetadata?.extras
        val itemBookId = extras?.getString("bookId")
        val itemOwner = extras?.getString("owner")
        val profile = repository.session.cacheScope()
        val currentBook = mutableState.value.book

        if (itemBookId == null || itemOwner == null || itemOwner != profile) {
            if (mutableState.value.attached && !mutableState.value.loading) {
                mutableState.update { it.copy(playing = false, buffering = false, attached = false) }
            }
            return
        }

        if (currentBook == null || (reconcileService && currentBook.id != itemBookId)) {
            if (loadJob?.isActive != true) {
                restoreAttachedSession(itemBookId)
            }
            return
        }

        if (currentBook.id != itemBookId) {
            mutableState.update { it.copy(playing = false, buffering = false, attached = false) }
            return
        }

        val activeIndex = transport.currentMediaItemIndex.coerceIn(0, (mutableState.value.chapters.lastIndex).coerceAtLeast(0))
        val chapterDuration = mutableState.value.chapters.getOrNull(activeIndex)?.resolvedDurationMs
            ?: extras.getLong("duration", 0L).coerceAtLeast(0L)
        val rawPos = transport.currentPosition.coerceAtLeast(0L)
        val playerDuration = transport.duration.takeIf { it > 0L } ?: chapterDuration
        val speed = BOOK_PLAYBACK_RATES.minByOrNull { abs(it - transport.playbackSpeed) } ?: transport.playbackSpeed
        val isPlaying = transport.isPlaying
        val isBuffering = transport.playbackState == Player.STATE_BUFFERING
        val playerError = transport.playerError?.let { friendlyError(it) }

        if (isPlaying) {
            onPlayStarted()
        }

        mutablePositionMs.value = if (chapterDuration > 0L) rawPos.coerceAtMost(chapterDuration) else rawPos
        mutableState.update { prev ->
            prev.copy(
                index = activeIndex,
                durationMs = playerDuration,
                playing = isPlaying,
                buffering = isBuffering,
                attached = true,
                speed = speed,
                error = playerError ?: prev.error,
            )
        }
        sleepTick = (sleepTick + 1) % 6
        if (sleepTick == 0 || reconcileService) {
            refreshSleepStatus()
        }
    }

    private fun refreshSleepStatus() {
        transport.requestSleepMinutes { mins ->
            mutableState.update { if (it.book != null) it.copy(sleepMinutes = mins) else it }
        }
    }

    private fun restoreAttachedSession(bookId: String) {
        val owner = repository.session.storageScope()
        val profile = repository.session.cacheScope() ?: return
        val epoch = ++loadEpoch
        loadJob?.cancel()
        loadJob = scope.launch {
            try {
                val summary = repository.api().book(bookId)
                val chapters = loadChapters(summary.id, owner)
                if (epoch != loadEpoch || profile != repository.session.cacheScope()) return@launch
                preparedItems = buildMediaItems(summary, profile, chapters, 0, "resume")
                val activeIdx = transport.currentMediaItemIndex.coerceIn(0, chapters.lastIndex.coerceAtLeast(0))
                mutableState.value = BookPlaybackState(
                    book = summary,
                    chapters = chapters,
                    index = activeIdx,
                    durationMs = chapters.getOrNull(transport.currentMediaItemIndex)?.resolvedDurationMs ?: 0L,
                    playing = transport.isPlaying,
                    buffering = transport.playbackState == Player.STATE_BUFFERING,
                    loading = false,
                    attached = true,
                    speed = BOOK_PLAYBACK_RATES.minByOrNull { abs(it - transport.playbackSpeed) } ?: 1f,
                    syncConflict = repository.bookSyncConflict.value == summary.id,
                )
                refreshSleepStatus()
                if (transport.isPlaying) onPlayStarted()
            } catch (_: Exception) {
                // Best-effort restore from lingering background service.
            }
        }
    }

    private suspend fun loadChapters(bookId: String, owner: String?): List<BookAudioChapter> = try {
        repository.api().bookAudio(bookId).chapters.also { fresh ->
            if (owner != null) {
                repository.database.books().saveAudioChapters(
                    fresh.map { BookAudiobookChapterEntity(owner, bookId, it.index, gson.toJson(it)) },
                )
            }
        }
    } catch (cause: IOException) {
        val cached = owner?.let { repository.database.books().audioChapters(it, bookId) }.orEmpty()
        if (cached.isEmpty()) throw cause
        cached.map { gson.fromJson(it.payload, BookAudioChapter::class.java) }
    }

    private fun buildMediaItems(
        book: BookSummary,
        profile: String,
        chapters: List<BookAudioChapter>,
        baseVersion: Int,
        intent: String,
        syncToken: String = java.util.UUID.randomUUID().toString(),
    ): List<MediaItem> {
        val coverUri = if (book.hasCover) Uri.parse(repository.url("api", "v1", "books", book.id, "cover")) else null
        return chapters.map { entry ->
            val extras = Bundle().apply {
                putString("bookId", book.id)
                putString("owner", profile)
                putInt("chapter", entry.index)
                putLong("duration", entry.resolvedDurationMs)
                putInt("fileIndex", entry.fileIndex)
                putLong("start", entry.start)
                putLong("end", entry.end)
                putInt("baseVersion", baseVersion)
                putString("intent", intent)
                putString("syncToken", syncToken)
            }
            MediaItem.Builder()
                .setMediaId("book:${book.id}:${entry.index}")
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(entry.title)
                        .setAlbumTitle(book.title)
                        .setArtworkUri(coverUri)
                        .setExtras(extras)
                        .build(),
                )
                .build()
        }
    }

    fun open(
        book: BookSummary,
        autoplay: Boolean = true,
        targetChapterIndex: Int? = null,
        forceReload: Boolean = false,
    ) {
        if (!book.hasAudiobook) return
        val current = mutableState.value
        if (
            !forceReload &&
            !current.syncConflict &&
            current.book?.id == book.id &&
            !current.loading &&
            current.error == null &&
            preparedItems.isNotEmpty()
        ) {
            if (targetChapterIndex != null) {
                selectChapter(targetChapterIndex, autoplay)
            } else if (autoplay && !current.playing) {
                togglePlay()
            } else {
                onPlayStarted()
            }
            return
        }

        val owner = repository.session.storageScope()
        val profile = repository.session.cacheScope() ?: return
        val epoch = ++loadEpoch
        loadJob?.cancel()
        loadJob = scope.launch {
            mutablePositionMs.value = 0L
            mutableState.value = BookPlaybackState(
                book = book,
                loading = true,
                speed = current.speed,
                syncConflict = !forceReload && repository.bookSyncConflict.value == book.id,
            )
            onPlayStarted()
            try {
                val t = awaitTransport() ?: throw IOException("Audiobook service unavailable")
                val chapters = loadChapters(book.id, owner)
                if (epoch != loadEpoch || profile != repository.session.cacheScope()) return@launch
                if (chapters.isEmpty()) throw IOException("No audiobook chapters")

                val intent = if (book.progressStatus == "finished") "restart" else "resume"
                val sync = BookSync(repository, book.id, "listening", initialIntent = intent)
                val checkpoint = sync.load()
                if (epoch != loadEpoch || profile != repository.session.cacheScope()) return@launch
                if (!sync.conflict && repository.bookSyncConflict.value == book.id) {
                    repository.bookSyncConflict.value = null
                }

                val startIndex = (targetChapterIndex ?: checkpoint.chapter).coerceIn(0, chapters.lastIndex)
                val startChapter = chapters[startIndex]
                val maxDur = startChapter.resolvedDurationMs
                val startPosMs = if (targetChapterIndex != null) 0L else checkpoint.position.coerceIn(0L, maxDur)
                val resolvedSpeed = BOOK_PLAYBACK_RATES.minByOrNull {
                    abs(it - (if (checkpoint.speed > 0f) checkpoint.speed else 1f))
                } ?: 1f

                val items = buildMediaItems(book, profile, chapters, sync.currentVersion(), intent)
                preparedItems = items
                mutablePositionMs.value = startPosMs

                val shouldAttach = forceReload || autoplay || !t.isPlaying
                if (shouldAttach) {
                    t.setMediaItems(items, startIndex, startPosMs)
                    t.setPlaybackSpeed(resolvedSpeed)
                    if (autoplay) {
                        onPlayStarted()
                        if (t.playbackState == Player.STATE_IDLE) t.prepare()
                        t.play()
                    }
                }
                mutableState.value = BookPlaybackState(
                    book = book,
                    chapters = chapters,
                    index = startIndex,
                    durationMs = maxDur,
                    playing = autoplay,
                    buffering = false,
                    loading = false,
                    attached = shouldAttach,
                    speed = resolvedSpeed,
                    syncConflict = sync.conflict || repository.bookSyncConflict.value == book.id,
                )
                refreshSleepStatus()
            } catch (cause: CancellationException) {
                throw cause
            } catch (cause: Exception) {
                if (epoch == loadEpoch && profile == repository.session.cacheScope()) {
                    mutableState.update {
                        it.copy(loading = false, playing = false, error = friendlyError(cause))
                    }
                }
            }
        }
    }

    fun reloadFromServer(autoplay: Boolean? = null) {
        val current = mutableState.value
        val book = current.book ?: return
        if (repository.bookSyncConflict.value == book.id) {
            repository.bookSyncConflict.value = null
        }
        open(
            book = book,
            autoplay = autoplay ?: current.playing,
            targetChapterIndex = null,
            forceReload = true,
        )
    }

    fun togglePlay() {
        if (!transport.isConnected) return
        val s = mutableState.value
        val book = s.book ?: return
        if (s.error != null && s.chapters.isEmpty()) {
            open(book, autoplay = true)
            return
        }
        val activeBookId = transport.currentMediaItem?.mediaMetadata?.extras?.getString("bookId")
        val attached = activeBookId == book.id
        if (attached && (transport.isPlaying || transport.playWhenReady)) {
            transport.pause()
        } else {
            onPlayStarted()
            if (!attached && preparedItems.isNotEmpty()) {
                val targetIndex = s.index.coerceIn(preparedItems.indices)
                transport.setMediaItems(preparedItems, targetIndex, mutablePositionMs.value)
                transport.setPlaybackSpeed(s.speed)
            }
            if (transport.playbackState == Player.STATE_IDLE) transport.prepare()
            transport.play()
        }
        syncFromController()
    }

    fun selectChapter(chapterIndex: Int, autoplay: Boolean = true) {
        if (!transport.isConnected) return
        val s = mutableState.value
        val book = s.book ?: return
        val chapter = s.chapters.getOrNull(chapterIndex) ?: return
        val activeBookId = transport.currentMediaItem?.mediaMetadata?.extras?.getString("bookId")
        val attached = activeBookId == book.id
        if (autoplay) onPlayStarted()
        if (attached) {
            transport.seekTo(chapterIndex, 0L)
            if (autoplay) {
                if (transport.playbackState == Player.STATE_IDLE) transport.prepare()
                transport.play()
            }
        } else if (preparedItems.isNotEmpty()) {
            transport.setMediaItems(preparedItems, chapterIndex.coerceIn(preparedItems.indices), 0L)
            transport.setPlaybackSpeed(s.speed)
            if (autoplay) {
                transport.prepare()
                transport.play()
            }
        }
        mutablePositionMs.value = 0L
        mutableState.update {
            it.copy(
                index = chapterIndex,
                durationMs = chapter.resolvedDurationMs,
                attached = true,
                playing = autoplay || it.playing,
                error = null,
            )
        }
    }

    fun seekTo(positionMs: Long) {
        if (!transport.isConnected) return
        val s = mutableState.value
        val book = s.book ?: return
        val duration = s.durationMs.takeIf { it > 0L } ?: s.activeChapter?.resolvedDurationMs ?: Long.MAX_VALUE
        val target = positionMs.coerceIn(0L, duration)
        mutablePositionMs.value = target
        val activeBookId = transport.currentMediaItem?.mediaMetadata?.extras?.getString("bookId")
        if (activeBookId == book.id) {
            transport.seekTo(target)
        } else if (preparedItems.isNotEmpty()) {
            transport.setMediaItems(preparedItems, s.index.coerceIn(preparedItems.indices), target)
            transport.setPlaybackSpeed(s.speed)
        }
    }

    fun seekBy(deltaMs: Long) {
        seekTo(mutablePositionMs.value + deltaMs)
    }

    fun setSpeed(rate: Float) {
        if (!transport.isConnected) return
        val s = mutableState.value
        val book = s.book ?: return
        if (transport.currentMediaItem?.mediaMetadata?.extras?.getString("bookId") == book.id) {
            transport.setPlaybackSpeed(rate)
        }
        mutableState.update { it.copy(speed = rate) }
    }

    fun cycleSpeed() {
        val current = mutableState.value.speed
        val next = BOOK_PLAYBACK_RATES.firstOrNull { it > current + 0.01f } ?: BOOK_PLAYBACK_RATES.first()
        setSpeed(next)
    }

    fun setSleep(minutes: Int) {
        if (!transport.isConnected) return
        val clamped = minutes.coerceIn(0, 60)
        transport.setSleepMinutes(clamped)
        mutableState.update { it.copy(sleepMinutes = clamped) }
    }

    fun renameChapter(chapterIndex: Int, title: String) {
        mutableState.update { prev ->
            prev.copy(
                chapters = prev.chapters.map { ch ->
                    if (ch.index == chapterIndex) ch.copy(title = title) else ch
                },
            )
        }
    }

    fun refreshBookSummary(updated: BookSummary) {
        if (mutableState.value.book?.id == updated.id) {
            mutableState.update { it.copy(book = updated) }
        }
    }

    fun pause() {
        if (!transport.isConnected) return
        val book = mutableState.value.book ?: return
        if (transport.currentMediaItem?.mediaMetadata?.extras?.getString("bookId") == book.id && (transport.isPlaying || transport.playWhenReady)) {
            transport.pause()
        }
        mutableState.update { it.copy(playing = false, buffering = false) }
    }

    fun stopAndClose() {
        loadEpoch++
        loadJob?.cancel()
        preparedItems = emptyList()
        mutablePositionMs.value = 0L
        transport.stopAndClear()
        mutableState.value = BookPlaybackState()
        onSessionCleared()
    }

    fun release() {
        conflictJob?.cancel()
        pollJob?.cancel()
        loadJob?.cancel()
        transport.removeListener(listener)
        transport.release()
    }
}
