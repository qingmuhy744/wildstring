package com.wildstring.app.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.R
import com.wildstring.app.data.PodcastEpisode
import com.wildstring.app.data.friendlyError
import kotlinx.coroutines.CancellationException

@Composable
internal fun PodcastPlayerScreen(
    vm: MusicViewModel, state: MusicState, wide: Boolean, dragEnabled: Boolean,
    onBack: () -> Unit, onDismiss: () -> Unit, onDragOffset: (Float, Boolean) -> Unit,
    onQueue: () -> Unit, onSleep: () -> Unit,
) {
    val track = state.current ?: return
    val sleep by vm.sleep.state.collectAsStateWithLifecycle()
    var article by rememberSaveable(track.id) { mutableStateOf(false) }
    var preview by rememberSaveable(track.id) { mutableStateOf(false) }
    var episode by remember(track.id, state.serverSelection) { mutableStateOf<PodcastEpisode?>(null) }
    var loading by remember(track.id) { mutableStateOf(true) }
    var error by remember(track.id) { mutableStateOf<String?>(null) }
    var reload by remember(track.id) { mutableIntStateOf(0) }
    val duration = state.duration.takeIf { it > 0 } ?: track.durationMs
    LaunchedEffect(track.id, state.serverSelection, reload) {
        val id = track.podcastEpisodeId ?: return@LaunchedEffect
        loading = true; error = null
        try {
            episode = vm.repository.cachedPodcastEpisode(id)
            episode = vm.repository.podcastEpisode(id)
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = friendlyError(e) }
        finally { loading = false }
    }
    val articleScroll = rememberScrollState()
    LaunchedEffect(track.id) { articleScroll.scrollTo(0) }
    val feedback = LocalTactileFeedback.current
    val thresholdTick = { feedback(TactileKind.Tap) }
    val swipeModifier = Modifier.dismissPlayerSwipe(dragEnabled, onDismiss, onDragOffset, thresholdTick)
    val dismissScroll = rememberPodcastDismissScroll(dragEnabled, onDismiss, onDragOffset, thresholdTick)
    Box(Modifier.fillMaxSize().testTag("podcast-player").nestedScroll(dismissScroll)) {
        ArtworkBackdrop(vm, track)
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(horizontal = if (wide) 24.dp else if (article) 12.dp else 20.dp),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 2.dp)
                    .then(swipeModifier),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                IconButton(tactile(onBack)) {
                    Icon(Icons.Default.KeyboardArrowDown, "返回单集列表")
                }
                Surface(
                    shape = RoundedCornerShape(18.dp),
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f),
                ) {
                    Row(
                        modifier = Modifier.padding(3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        PodcastModeTab(
                            selected = !article,
                            label = "封面",
                            tag = "podcast-cover-tab",
                            onClick = tactile { article = false },
                        )
                        PodcastModeTab(
                            selected = article,
                            label = "文章",
                            tag = "podcast-article-tab",
                            onClick = tactile { article = true },
                        )
                    }
                }
                IconButton(tactile(onSleep)) {
                    Icon(
                        Icons.Default.Bedtime,
                        "睡眠定时",
                        tint = if (sleep.deadline != null || sleep.entryId != null) MaterialTheme.colorScheme.primary else LocalContentColor.current,
                    )
                }
            }
            val content: @Composable (Modifier) -> Unit = { modifier ->
                if (article) Surface(
                    modifier,
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surface.copy(alpha = .94f),
                ) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(articleScroll, overscrollEffect = null)
                            .padding(horizontal = 16.dp, vertical = 14.dp)
                            .testTag("podcast-article"),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            track.title,
                            style = MaterialTheme.typography.titleLarge,
                            fontFamily = FontFamily.Serif,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                (track.album ?: track.artist).ifBlank { "播客" },
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.primary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            episode?.pubDate?.takeIf { it.isNotBlank() }?.let { pub ->
                                Text(
                                    pub.take(16),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f))
                        val description = episode?.description.orEmpty()
                        if (description.isNotBlank()) PodcastArticleText(description, Modifier.fillMaxWidth(), duration) { vm.seek(it) }
                        else if (loading) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("正在加载文章…") }
                        else if (error == null) Text("这期节目暂未提供文章。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        error?.let { message ->
                            Text(if (episode != null) "当前显示已保存的文章。" else message, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton({ reload++ }) { Text("重新加载") }
                        }
                    }
                } else BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
                    val coverSize = minOf(maxWidth, maxHeight * .64f, 400.dp)
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState(), overscrollEffect = null)
                            .padding(top = 6.dp, bottom = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Column(Modifier.width(coverSize)) {
                            Cover(
                                vm,
                                track.id,
                                track.album ?: track.title,
                                Modifier
                                    .fillMaxWidth()
                                    .aspectRatio(1f)
                                    .clip(RoundedCornerShape(20.dp))
                                    .combinedClickable(
                                        onClick = tactile { article = true },
                                        onLongClick = { preview = true },
                                    ),
                            )
                            Spacer(Modifier.height(18.dp))
                            Text(
                                track.title,
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.fillMaxWidth(),
                                maxLines = 3,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Spacer(Modifier.height(6.dp))
                            Text(
                                listOfNotNull(
                                    track.album?.takeIf { it.isNotBlank() },
                                    track.artist.takeIf { it.isNotBlank() && it != track.album },
                                ).joinToString(" · ").ifBlank { track.artist },
                                Modifier.fillMaxWidth(),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
            if (wide) Row(
                Modifier.weight(1f).fillMaxWidth().padding(bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                content(Modifier.weight(1.5f).fillMaxHeight())
                PodcastPlayerControls(vm, state, duration, onQueue, compact = false, Modifier.weight(1f).then(swipeModifier))
            } else {
                content(Modifier.weight(1f).fillMaxWidth())
                PodcastPlayerControls(
                    vm,
                    state,
                    duration,
                    onQueue,
                    compact = article,
                    Modifier.fillMaxWidth().padding(top = if (article) 4.dp else 8.dp, bottom = 6.dp).then(swipeModifier),
                )
            }
        }
    }
    if (preview) ArtworkPreview(vm, track) { preview = false }
}

@Composable
private fun PodcastModeTab(
    selected: Boolean,
    label: String,
    tag: String,
    onClick: () -> Unit,
) {
    val bg = if (selected) MaterialTheme.colorScheme.surface.copy(alpha = 0.92f) else Color.Transparent
    val fg = if (selected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(15.dp))
            .background(bg)
            .clickable(onClick = onClick)
            .semantics {
                role = Role.Tab
                this.selected = selected
            }
            .padding(horizontal = 18.dp, vertical = 6.dp)
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = 13.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = fg,
            maxLines = 1,
        )
    }
}

/** Let the article scroll first; only a downward pull past its top moves the player. */
@Composable
private fun rememberPodcastDismissScroll(
    enabled: Boolean, onDismiss: () -> Unit, onDragOffset: (Float, Boolean) -> Unit,
    onThresholdCrossed: () -> Unit,
): NestedScrollConnection {
    val threshold = with(LocalDensity.current) { 52.dp.toPx() }
    val flingDistance = with(LocalDensity.current) { 16.dp.toPx() }
    val flingVelocity = with(LocalDensity.current) { PlayerFlingVelocity.toPx() }
    val dismiss by rememberUpdatedState(onDismiss)
    val dragOffset by rememberUpdatedState(onDragOffset)
    val thresholdCrossed by rememberUpdatedState(onThresholdCrossed)
    return remember(enabled, threshold, flingDistance, flingVelocity) {
        object : NestedScrollConnection {
            private var distance = 0f
            private var crossed = false

            private fun drag(amount: Float): Offset {
                val previous = distance
                distance = (distance + amount).coerceAtLeast(0f)
                dragOffset(distance, distance > 0f)
                if (distance >= threshold && !crossed) {
                    crossed = true
                    thresholdCrossed()
                }
                return Offset(0f, distance - previous)
            }

            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset =
                if (enabled && source == NestedScrollSource.UserInput && distance > 0f) drag(available.y) else Offset.Zero

            override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
                if (enabled && source == NestedScrollSource.UserInput && available.y > 0f) drag(available.y) else Offset.Zero

            override suspend fun onPreFling(available: Velocity): Velocity {
                val active = distance > 0f
                val shouldDismiss = distance >= threshold || (distance >= flingDistance && available.y >= flingVelocity)
                distance = 0f
                crossed = false
                if (shouldDismiss) dismiss() else if (active) dragOffset(0f, false)
                return if (active) Velocity(0f, available.y) else Velocity.Zero
            }
        }
    }
}

@Composable
private fun PodcastPlayerControls(
    vm: MusicViewModel,
    state: MusicState,
    duration: Long,
    onQueue: () -> Unit,
    compact: Boolean,
    modifier: Modifier,
) {
    val position by vm.position.collectAsStateWithLifecycle()
    val feedback = LocalTactileFeedback.current
    var scrub by remember { mutableStateOf<Float?>(null) }
    var speedMenu by remember { mutableStateOf(false) }
    var speed by remember(vm.controller) { mutableFloatStateOf(vm.controller?.playbackParameters?.speed ?: 1f) }
    Column(modifier) {
        Slider(
            value = scrub ?: position.coerceAtMost(duration).toFloat(),
            onValueChange = { scrub = it },
            onValueChangeFinished = {
                scrub?.let {
                    feedback(TactileKind.Tap)
                    vm.seek(it.toLong())
                }
                scrub = null
            },
            valueRange = 0f..duration.coerceAtLeast(1).toFloat(),
            enabled = duration > 0,
            colors = SliderDefaults.colors(
                thumbColor = MaterialTheme.colorScheme.primary,
                activeTrackColor = MaterialTheme.colorScheme.primary,
                inactiveTrackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = .14f),
                activeTickColor = Color.Transparent,
                inactiveTickColor = Color.Transparent,
            ),
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                formatPodcastTime(scrub?.toLong() ?: position),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box {
                    Surface(
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
                        modifier = Modifier
                            .clip(RoundedCornerShape(12.dp))
                            .clickable(onClick = tactile { speedMenu = true }),
                    ) {
                        Text(
                            text = "${speed}×",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (speed != 1f) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                    }
                    DropdownMenu(speedMenu, { speedMenu = false }) {
                        listOf(.75f, 1f, 1.25f, 1.5f, 1.75f, 2f).forEach { rate ->
                            DropdownMenuItem(
                                text = { Text("${rate}×") },
                                onClick = tactile {
                                    vm.controller?.setPlaybackSpeed(rate)
                                    speed = rate
                                    speedMenu = false
                                },
                            )
                        }
                    }
                }
                Surface(
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f),
                    modifier = Modifier
                        .clip(RoundedCornerShape(12.dp))
                        .clickable(onClick = tactile(onQueue)),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.QueueMusic,
                            contentDescription = "播放队列",
                            modifier = Modifier.size(15.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            text = "队列",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                }
            }
            Text(
                formatPodcastTime(duration),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = if (compact) 4.dp else 8.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(tactile { vm.skipPodcastEpisode(-1) }) {
                Icon(
                    Icons.Default.SkipPrevious,
                    stringResource(R.string.podcast_previous_episode),
                    Modifier.size(if (compact) 24.dp else 28.dp),
                )
            }
            IconButton(tactile { vm.seek((position - 15_000).coerceAtLeast(0)) }) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Replay, "后退 15 秒", Modifier.size(if (compact) 26.dp else 28.dp))
                    Text("15", fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 3.dp))
                }
            }
            FilledIconButton(
                onClick = tactile(vm::toggle),
                modifier = Modifier.size(if (compact) 52.dp else 64.dp),
                shape = CircleShape,
            ) {
                if (state.buffering) {
                    CircularProgressIndicator(
                        Modifier.size(if (compact) 24.dp else 28.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Crossfade(state.playing, animationSpec = tween(130), label = "podcast-play-pause") { playing ->
                        Icon(
                            if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                            if (playing) "暂停" else "播放",
                            Modifier.size(if (compact) 28.dp else 34.dp),
                        )
                    }
                }
            }
            IconButton(tactile { vm.seek((position + 30_000).let { if (duration > 0) it.coerceAtMost(duration) else it }) }) {
                Icon(Icons.Default.Forward30, "前进 30 秒", Modifier.size(if (compact) 26.dp else 28.dp))
            }
            IconButton(tactile { vm.skipPodcastEpisode(1) }) {
                Icon(
                    Icons.Default.SkipNext,
                    stringResource(R.string.podcast_next_episode),
                    Modifier.size(if (compact) 24.dp else 28.dp),
                )
            }
        }
        val progressMessage by vm.podcastProgress.message.collectAsStateWithLifecycle()
        val displayMessage = state.playbackError ?: progressMessage
        displayMessage?.let { message ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = if (state.playbackError != null) MaterialTheme.colorScheme.error else Color(0xFFE98A6D))
                if (state.playbackError != null) {
                    TextButton(tactile(vm::toggle)) { Text("重试") }
                }
            }
        }
    }
}

private fun formatPodcastTime(ms: Long): String {
    val totalSeconds = (ms / 1000L).coerceAtLeast(0L)
    val h = totalSeconds / 3600L
    val m = (totalSeconds % 3600L) / 60L
    val s = totalSeconds % 60L
    return if (h > 0L) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}
