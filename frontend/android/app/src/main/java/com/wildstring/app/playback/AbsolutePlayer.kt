@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
package com.wildstring.app.playback

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.*
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ForwardingTimeline
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.wildstring.app.data.PlaybackRequest

/** Exposes a whole-song timeline to both the app and lock-screen controllers. */
internal class AbsolutePlayer(private val engine: ExoPlayer, private val resolver: PlaybackResolver) : ForwardingSimpleBasePlayer(engine) {
    private var refreshing = false
    init {
        engine.addListener(object : Player.Listener {
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                if (reason in listOf(Player.MEDIA_ITEM_TRANSITION_REASON_AUTO, Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) &&
                    mediaItem != null && offset(mediaItem) > 0) rebase(engine.currentMediaItemIndex, 0)
            }
        })
    }
    private fun uri(item: MediaItem) = item.localConfiguration?.uri?.toString().orEmpty()
    private fun requested(item: MediaItem) = uri(item).takeIf { it.isNotEmpty() }?.let(PlaybackRequest::isAac) == true
    private fun offset(item: MediaItem): Long = if (!requested(item)) 0 else resolver.plan(uri(item))?.startMs ?: PlaybackRequest.offset(uri(item))
    private fun duration(item: MediaItem): Long = resolver.plan(uri(item))?.durationMs?.takeIf { it > 0 }
        ?: item.mediaMetadata.durationMs?.takeIf { it > 0 }
        ?: item.mediaMetadata.extras?.getLong("duration_ms") ?: 0L
    private fun transcode(item: MediaItem) = requested(item) && resolver.plan(uri(item))?.mode != "original"

    fun refreshResolution() {
        val item = engine.currentMediaItem ?: return
        val plan = resolver.plan(uri(item))
        val wanted = if (requested(item)) PlaybackRequest.offset(uri(item)) else 0
        if (!refreshing && plan?.mode == "original" && wanted > 0 && engine.currentPosition < wanted) {
            refreshing = true
            engine.seekTo(wanted)
            refreshing = false
        }
        invalidateState()
    }
    override fun getState(): State {
        val state = super.getState()
        if (state.timeline.isEmpty) return state
        val item = engine.currentMediaItem ?: return state
        val offset = offset(item)
        val total = duration(item)
        val plan = resolver.plan(uri(item))
        val label = if (plan?.mode == "transcode") "AAC · ${plan.output.bitrateKbps} kbps"
            else "原音" + (plan?.output?.codec ?: item.mediaMetadata.extras?.getString("format"))?.takeIf { it.isNotBlank() }?.let { " · ${it.uppercase()}" }.orEmpty()
        // A chunked AAC response has no container duration until encoding finishes.
        // SystemUI reads standard metadata; our private duration_ms extra is invisible there.
        val metadata = state.currentMetadata.buildUpon().setDurationMs(total.takeIf { it > 0 }
            ?: state.currentMetadata.durationMs).setDescription(label)
            .setExtras(Bundle(state.currentMetadata.extras ?: Bundle()).apply { putString("playback_label", label) }).build()
        if (!transcode(item)) return state.buildUpon().setPlaylist(state.timeline, state.currentTracks, metadata).build()
        val timeline = object : ForwardingTimeline(state.timeline) {
            override fun getWindow(index: Int, window: Timeline.Window, defaultPositionProjectionUs: Long): Timeline.Window {
                super.getWindow(index, window, defaultPositionProjectionUs)
                if (transcode(window.mediaItem)) {
                    duration(window.mediaItem).takeIf { it > 0 }?.let { window.durationUs = it * 1000 }
                    window.isSeekable = true; window.isDynamic = false
                    // These are finite songs even while the encoder streams without Content-Length.
                    // isDynamic=false alone does not clear Timeline.Window.isLive.
                    window.liveConfiguration = null
                }
                return window
            }
            override fun getPeriod(index: Int, period: Timeline.Period, setIds: Boolean): Timeline.Period {
                super.getPeriod(index, period, setIds)
                val window = state.timeline.getWindow(period.windowIndex, Timeline.Window())
                if (transcode(window.mediaItem)) duration(window.mediaItem).takeIf { it > 0 }?.let { period.durationUs = it * 1000 }
                return period
            }
        }
        val builder = state.buildUpon().setPlaylist(timeline, state.currentTracks, metadata)
            .setContentPositionMs(PositionSupplier { (offset + state.contentPositionMsSupplier.get()).let { if (total > 0) it.coerceAtMost(total) else it } })
            .setContentBufferedPositionMs(PositionSupplier { (offset + state.contentBufferedPositionMsSupplier.get()).let { if (total > 0) it.coerceAtMost(total) else it } })
        if (transcode(item)) builder.setAvailableCommands(state.availableCommands.buildUpon()
            .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM).add(Player.COMMAND_SEEK_BACK).add(Player.COMMAND_SEEK_FORWARD).build())
        if (state.hasPositionDiscontinuity) builder.setPositionDiscontinuity(state.positionDiscontinuityReason, state.discontinuityPositionMs + offset)
        return builder.build()
    }
    private fun rebase(index: Int, position: Long) {
        if (index !in 0 until engine.mediaItemCount) return
        val item = engine.getMediaItemAt(index)
        val current = uri(item)
        val bitrate = Uri.parse(current).getQueryParameter("bitrate_kbps")?.toIntOrNull() ?: return
        val target = duration(item).takeIf { it > 0 }?.let { position.coerceIn(0, it - 1) } ?: position.coerceAtLeast(0)
        val next = item.buildUpon().setUri(PlaybackRequest.url(current, bitrate, target)).build()
        engine.replaceMediaItem(index, next)
        engine.seekTo(index, 0)
        if (engine.playbackState == Player.STATE_IDLE || engine.playbackState == Player.STATE_ENDED) engine.prepare()
    }
    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
        if (mediaItemIndex in 0 until engine.mediaItemCount && transcode(engine.getMediaItemAt(mediaItemIndex))) {
            rebase(mediaItemIndex, if (positionMs == C.TIME_UNSET) 0 else positionMs)
            return Futures.immediateVoidFuture()
        }
        return super.handleSeek(mediaItemIndex, positionMs, seekCommand)
    }
    override fun handleSetMediaItems(mediaItems: List<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
        val index = startIndex.takeIf { it in mediaItems.indices } ?: 0
        val position = startPositionMs.takeIf { it > 0 } ?: 0
        val items = mediaItems.toMutableList()
        if (index in items.indices && requested(items[index]) && position > 0) {
            val item = items[index]
            val bitrate = Uri.parse(uri(item)).getQueryParameter("bitrate_kbps")!!.toInt()
            items[index] = item.buildUpon().setUri(PlaybackRequest.url(uri(item), bitrate, position)).build()
            return super.handleSetMediaItems(items, index, 0)
        }
        return super.handleSetMediaItems(mediaItems, startIndex, startPositionMs)
    }
    fun quality(bitrate: Int) {
        if (engine.mediaItemCount == 0) return
        val index = engine.currentMediaItemIndex
        val position = currentPosition.coerceAtLeast(0)
        val autoplay = engine.playWhenReady
        val items = (0 until engine.mediaItemCount).map { i ->
            val item = engine.getMediaItemAt(i)
            val original = item.mediaMetadata.extras?.getString("original_stream") ?: uri(item)
            item.buildUpon().setUri(PlaybackRequest.url(original, bitrate, if (i == index) position else 0)).build()
        }
        engine.setMediaItems(items, index, if (bitrate == 0) position else 0)
        engine.prepare(); engine.playWhenReady = autoplay
    }
}
