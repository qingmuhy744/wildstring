package com.wildstring.app.ui

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
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.Velocity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
        ArtworkBackdrop(vm, track, false)
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = if (wide) 24.dp else 20.dp)) {
            Row(Modifier.fillMaxWidth().then(swipeModifier), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onBack) { Icon(Icons.Default.KeyboardArrowDown, "返回单集列表") }
                Text(track.album ?: "播客", Modifier.weight(1f).padding(horizontal = 8.dp), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(onSleep) { Icon(Icons.Default.Bedtime, "睡眠定时") }
            }
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp).then(swipeModifier), horizontalArrangement = Arrangement.Center) {
                SingleChoiceSegmentedButtonRow(Modifier.width(176.dp)) {
                    SegmentedButton(selected = !article, onClick = { article = false }, shape = SegmentedButtonDefaults.itemShape(0, 2), icon = {}, modifier = Modifier.weight(1f).testTag("podcast-cover-tab")) { Text("封面") }
                    SegmentedButton(selected = article, onClick = { article = true }, shape = SegmentedButtonDefaults.itemShape(1, 2), icon = {}, modifier = Modifier.weight(1f).testTag("podcast-article-tab")) { Text("文章") }
                }
            }
            val content: @Composable (Modifier) -> Unit = { modifier ->
                if (article) Surface(modifier, shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surface.copy(alpha = .93f)) {
                    Column(Modifier.fillMaxSize().verticalScroll(articleScroll, overscrollEffect = null).padding(20.dp).testTag("podcast-article"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Text("本期节目", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        Text(track.title, style = MaterialTheme.typography.headlineSmall, fontFamily = FontFamily.Serif, fontWeight = FontWeight.SemiBold)
                        episode?.pubDate?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        HorizontalDivider()
                        val description = episode?.description.orEmpty()
                        if (description.isNotBlank()) PodcastArticleText(description, Modifier.fillMaxWidth(), duration) { vm.seek(it) }
                        else if (loading) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text("正在加载文章…") }
                        else if (error == null) Text("这期节目暂未提供文章。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        error?.let { message ->
                            Text(if (episode != null) "当前显示已保存的文章。" else message, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            TextButton({ reload++ }) { Text("重新加载") }
                        }
                    }
                } else BoxWithConstraints(modifier, contentAlignment = Alignment.TopCenter) {
                    val coverSize = minOf(maxWidth, maxHeight * .65f, 440.dp)
                    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState(), overscrollEffect = null).padding(top = 8.dp, bottom = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Column(Modifier.width(coverSize)) {
                            Cover(vm, track.id, track.album ?: track.title, Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(20.dp)).combinedClickable(onClick = { article = true }, onLongClick = { preview = true }))
                            Spacer(Modifier.height(20.dp))
                            Text(track.title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.fillMaxWidth(), maxLines = 4, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.height(8.dp))
                            Text(track.artist, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
                        }
                    }
                }
            }
            if (wide) Row(Modifier.weight(1f).fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                content(Modifier.weight(1.5f).fillMaxHeight())
                PodcastPlayerControls(vm, state, duration, onQueue, Modifier.weight(1f).then(swipeModifier))
            } else {
                content(Modifier.weight(1f).fillMaxWidth())
                PodcastPlayerControls(vm, state, duration, onQueue, Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp).then(swipeModifier))
            }
        }
    }
    if (preview) ArtworkPreview(vm, track) { preview = false }
}

/** Let the article scroll first; only a downward pull past its top moves the player. */
@Composable
private fun rememberPodcastDismissScroll(
    enabled: Boolean, onDismiss: () -> Unit, onDragOffset: (Float, Boolean) -> Unit,
    onThresholdCrossed: () -> Unit,
): NestedScrollConnection {
    val threshold = with(LocalDensity.current) { 52.dp.toPx() }
    val dismiss by rememberUpdatedState(onDismiss)
    val dragOffset by rememberUpdatedState(onDragOffset)
    val thresholdCrossed by rememberUpdatedState(onThresholdCrossed)
    return remember(enabled, threshold) {
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
                val shouldDismiss = distance >= threshold
                distance = 0f
                crossed = false
                if (shouldDismiss) dismiss() else if (active) dragOffset(0f, false)
                return if (active) Velocity(0f, available.y) else Velocity.Zero
            }
        }
    }
}

@Composable
private fun PodcastPlayerControls(vm: MusicViewModel, state: MusicState, duration: Long, onQueue: () -> Unit, modifier: Modifier) {
    val position by vm.position.collectAsStateWithLifecycle()
    var speedMenu by remember { mutableStateOf(false) }
    var speed by remember(vm.controller) { mutableFloatStateOf(vm.controller?.playbackParameters?.speed ?: 1f) }
    Column(modifier) {
        PlaybackSeekSection(vm, duration)
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Box {
                TextButton({ speedMenu = true }, contentPadding = PaddingValues(4.dp), modifier = Modifier.widthIn(min = 48.dp)) { Text("${speed}×") }
                DropdownMenu(speedMenu, { speedMenu = false }) {
                    listOf(.75f, 1f, 1.25f, 1.5f, 1.75f, 2f).forEach { rate ->
                        DropdownMenuItem(text = { Text("${rate}×") }, onClick = { vm.controller?.setPlaybackSpeed(rate); speed = rate; speedMenu = false })
                    }
                }
            }
            IconButton({ vm.seek((position - 15_000).coerceAtLeast(0)) }) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(Icons.Default.Replay, "后退 15 秒", Modifier.size(28.dp))
                    Text("15", fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 3.dp))
                }
            }
            FilledIconButton(vm::toggle, modifier = Modifier.size(64.dp), shape = CircleShape) {
                if (state.buffering) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                else Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "暂停" else "播放", Modifier.size(34.dp))
            }
            IconButton({ vm.seek((position + 30_000).let { if (duration > 0) it.coerceAtMost(duration) else it }) }) { Icon(Icons.Default.Forward30, "前进 30 秒") }
            IconButton(onQueue) { Icon(Icons.AutoMirrored.Filled.QueueMusic, "播放队列") }
        }
        state.playbackError?.let { message ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                TextButton(vm::toggle) { Text("重试") }
            }
        }
    }
}
