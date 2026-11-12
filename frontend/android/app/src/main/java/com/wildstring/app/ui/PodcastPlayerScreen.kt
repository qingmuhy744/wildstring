package com.wildstring.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
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
import androidx.compose.ui.input.pointer.pointerInput
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
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
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val motionAllowed = preferences.interfaceAnimations && playbackMotionAllowed()
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
                .padding(horizontal = if (wide) 24.dp else 20.dp),
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
                    Icon(Icons.Default.KeyboardArrowDown, stringResource(R.string.pod_player_back_to_episodes))
                }
                val aiComingSoon = stringResource(R.string.pod_player_ai_notes_coming_soon)
                if (wide) Spacer(Modifier.weight(1f)) else Surface(
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
                            label = stringResource(R.string.pod_player_tab_cover),
                            tag = "podcast-cover-tab",
                            onClick = tactile { article = false },
                        )
                        PodcastModeTab(
                            selected = article,
                            label = stringResource(R.string.pod_player_tab_article),
                            tag = "podcast-article-tab",
                            onClick = tactile { article = true },
                        )
                        PodcastModeTab(
                            selected = false,
                            label = stringResource(R.string.pod_player_tab_ai_notes),
                            tag = "podcast-ai-tab",
                            muted = true,
                            onClick = tactile { vm.notify(aiComingSoon) },
                        )
                    }
                }
                IconButton(tactile(onSleep)) {
                    Icon(
                        Icons.Default.Bedtime,
                        stringResource(R.string.pod_player_sleep_timer),
                        tint = if (sleep.deadline != null || sleep.entryId != null) MaterialTheme.colorScheme.primary else LocalContentColor.current,
                    )
                }
            }
            val articlePane: @Composable () -> Unit = {
Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Surface(
                        Modifier
                            .fillMaxHeight()
                            .then(if (wide) Modifier.widthIn(max = 760.dp).fillMaxWidth() else Modifier.fillMaxWidth())
                            .testTag("podcast-article-surface"),
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
                                    (track.album ?: track.artist).ifBlank { stringResource(R.string.pod_player_fallback_album) },
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
                            else if (loading) { LinearProgressIndicator(Modifier.fillMaxWidth()); Text(stringResource(R.string.pod_player_loading_article)) }
                            else if (error == null) Text(stringResource(R.string.pod_player_no_article), color = MaterialTheme.colorScheme.onSurfaceVariant)
                            error?.let { message ->
                                Text(if (episode != null) stringResource(R.string.pod_player_saved_article) else message, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                TextButton({ reload++ }) { Text(stringResource(R.string.pod_player_reload)) }
                            }
                        }
                    }
                }
            }
            val coverPane: @Composable () -> Unit = {
                BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
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
            val content: @Composable (Modifier) -> Unit = { modifier ->
                val ms = if (motionAllowed) 240 else 0
                AnimatedContent(
                    targetState = article,
                    modifier = modifier,
                    transitionSpec = {
                        // Same duration and curve as the control bar so both areas settle together.
                        val curve = FastOutSlowInEasing
                        if (targetState) (fadeIn(tween(ms, ms / 4, curve)) togetherWith fadeOut(tween(ms * 2 / 3, easing = curve)))
                        else (fadeIn(tween(ms, ms / 4, curve)) + scaleIn(tween(ms, ms / 4, curve), initialScale = .96f)) togetherWith
                            (fadeOut(tween(ms * 2 / 3, easing = curve)) + scaleOut(tween(ms, easing = curve), targetScale = .98f))
                    },
                    label = "podcast-view-mode",
                ) { showArticle -> if (showArticle) articlePane() else coverPane() }
            }
            val tabSwipeModifier = Modifier.podcastTabSwipe(
                enabled = !wide,
                article = article,
                onSwitchToArticle = { article = true; feedback(TactileKind.Tap) },
                onSwitchToCover = { article = false; feedback(TactileKind.Tap) },
            )
            if (wide) Row(
                Modifier.weight(1f).fillMaxWidth().padding(bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                // Wide screens never trade reading space for control size: cover + full controls beside the article.
                Column(Modifier.weight(1f).fillMaxHeight()) {
                    Box(Modifier.weight(1f).fillMaxWidth()) { coverPane() }
                    PodcastPlayerControls(
                        vm, state, duration, onQueue, compact = false, motionAllowed = motionAllowed,
                        modifier = Modifier.fillMaxWidth().padding(top = 8.dp).then(swipeModifier),
                    )
                }
                Box(Modifier.weight(1.25f).fillMaxHeight()) { articlePane() }
            } else {
                content(Modifier.weight(1f).fillMaxWidth().then(tabSwipeModifier))
                PodcastPlayerControls(
                    vm, state, duration, onQueue, compact = article, motionAllowed = motionAllowed,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 6.dp).then(swipeModifier),
                )
            }
        }
    }
    if (preview) ArtworkPreview(vm, track) { preview = false }
}

/**
 * Horizontal swipe switches only between Cover and Article (never into AI Notes),
 * while ignoring touches near screen edges so Android's system back gesture stays untouched.
 */
private fun Modifier.podcastTabSwipe(
    enabled: Boolean,
    article: Boolean,
    onSwitchToArticle: () -> Unit,
    onSwitchToCover: () -> Unit,
): Modifier = if (!enabled) this else pointerInput(article) {
    val edgeGuardPx = 28.dp.toPx()
    val thresholdPx = 56.dp.toPx()
    var distance = 0f
    var active = false
    detectHorizontalDragGestures(
        onDragStart = { start ->
            distance = 0f
            active = start.x >= edgeGuardPx && start.x <= (size.width - edgeGuardPx)
        },
        onHorizontalDrag = { change, amount ->
            if (!active) return@detectHorizontalDragGestures
            // Only accumulate drags in the valid direction: left on Cover -> Article, right on Article -> Cover.
            if ((!article && distance + amount <= 0f) || (article && distance + amount >= 0f)) {
                distance += amount
                change.consume()
            }
        },
        onDragEnd = {
            if (active) {
                if (!article && distance <= -thresholdPx) onSwitchToArticle()
                else if (article && distance >= thresholdPx) onSwitchToCover()
            }
            active = false
            distance = 0f
        },
        onDragCancel = {
            active = false
            distance = 0f
        },
    )
}

@Composable
private fun PodcastModeTab(
    selected: Boolean,
    label: String,
    tag: String,
    muted: Boolean = false,
    onClick: () -> Unit,
) {
    val bg = if (selected) MaterialTheme.colorScheme.surface.copy(alpha = 0.92f) else Color.Transparent
    val fg = when {
        selected -> MaterialTheme.colorScheme.onSurface
        muted -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.68f)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(15.dp))
            .background(bg)
            .clickable(onClick = onClick)
            .semantics {
                role = Role.Tab
                this.selected = selected
            }
            .padding(horizontal = 14.dp, vertical = 6.dp)
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
    motionAllowed: Boolean,
    modifier: Modifier,
) {
    val position by vm.position.collectAsStateWithLifecycle()
    val feedback = LocalTactileFeedback.current
    var scrub by remember { mutableStateOf<Float?>(null) }
    var speedMenu by remember { mutableStateOf(false) }
    var speed by remember(vm.controller) { mutableFloatStateOf(vm.controller?.playbackParameters?.speed ?: 1f) }
    val ms = if (motionAllowed) 240 else 0
    val fade = tween<Float>(ms, easing = FastOutSlowInEasing)
    val dpSpec = tween<Dp>(ms, easing = FastOutSlowInEasing)
    val sizeSpec = tween<IntSize>(ms, easing = FastOutSlowInEasing)
    var moreMenu by remember { mutableStateOf(false) }
    val sideIcon by animateDpAsState(if (compact) 24.dp else 28.dp, dpSpec, label = "podcast-side-icon")
    val skipIcon by animateDpAsState(if (compact) 26.dp else 28.dp, dpSpec, label = "podcast-skip-icon")
    val playButton by animateDpAsState(if (compact) 48.dp else 64.dp, dpSpec, label = "podcast-play-size")
    val playIcon by animateDpAsState(if (compact) 26.dp else 34.dp, dpSpec, label = "podcast-play-icon")
    val rowGap by animateDpAsState(if (compact) 0.dp else 8.dp, dpSpec, label = "podcast-row-gap")
    run {
        Column(modifier.fillMaxWidth().testTag(if (compact) "podcast-controls-compact" else "podcast-controls-full")) {
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
                AnimatedVisibility(
                    !compact,
                    enter = fadeIn(fade) + expandHorizontally(sizeSpec),
                    exit = fadeOut(fade) + shrinkHorizontally(sizeSpec),
                ) { Row(
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
                                contentDescription = stringResource(R.string.pod_player_queue_desc),
                                modifier = Modifier.size(15.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                text = stringResource(R.string.pod_player_queue_label),
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                            )
                        }
                    }
                } }
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
                    .padding(top = rowGap),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AnimatedVisibility(!compact, enter = fadeIn(fade) + expandHorizontally(sizeSpec), exit = fadeOut(fade) + shrinkHorizontally(sizeSpec)) {
                    IconButton(tactile { vm.skipPodcastEpisode(-1) }) {
                        Icon(Icons.Default.SkipPrevious, stringResource(R.string.podcast_previous_episode), Modifier.size(sideIcon))
                    }
                }
                IconButton(tactile { vm.seek((position - 15_000).coerceAtLeast(0)) }) {
                    Box(contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Replay, stringResource(R.string.pod_player_rewind_15), Modifier.size(skipIcon))
                        Text("15", fontSize = 9.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 3.dp))
                    }
                }
                FilledIconButton(
                    onClick = tactile(vm::toggle),
                    modifier = Modifier.size(playButton).testTag("podcast-play-pause"),
                    shape = CircleShape,
                ) {
                    if (state.buffering) {
                        CircularProgressIndicator(
                            Modifier.size(playIcon * .8f),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Crossfade(state.playing, animationSpec = tween(if (motionAllowed) 130 else 0), label = "podcast-play-pause") { playing ->
                            Icon(
                                if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                                if (playing) stringResource(R.string.pod_player_pause) else stringResource(R.string.pod_player_play),
                                Modifier.size(playIcon),
                            )
                        }
                    }
                }
                IconButton(tactile { vm.seek((position + 30_000).let { if (duration > 0) it.coerceAtMost(duration) else it }) }) {
                    Icon(Icons.Default.Forward30, stringResource(R.string.pod_player_forward_30), Modifier.size(skipIcon))
                }
                AnimatedVisibility(!compact, enter = fadeIn(fade) + expandHorizontally(sizeSpec), exit = fadeOut(fade) + shrinkHorizontally(sizeSpec)) {
                    IconButton(tactile { vm.skipPodcastEpisode(1) }) {
                        Icon(Icons.Default.SkipNext, stringResource(R.string.podcast_next_episode), Modifier.size(sideIcon))
                    }
                }
                // Compact reading bar keeps only the essentials; everything else lives here.
                AnimatedVisibility(compact, enter = fadeIn(fade) + expandHorizontally(sizeSpec), exit = fadeOut(fade) + shrinkHorizontally(sizeSpec)) {
                    Box {
                        IconButton(tactile { moreMenu = true }, Modifier.testTag("podcast-controls-more")) {
                            Icon(Icons.Default.MoreVert, stringResource(R.string.more_options), Modifier.size(sideIcon))
                        }
                        DropdownMenu(moreMenu, { moreMenu = false }) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.podcast_previous_episode)) }, onClick = tactile { moreMenu = false; vm.skipPodcastEpisode(-1) })
                            DropdownMenuItem(text = { Text(stringResource(R.string.podcast_next_episode)) }, onClick = tactile { moreMenu = false; vm.skipPodcastEpisode(1) })
                            DropdownMenuItem(text = { Text(stringResource(R.string.pod_player_queue_label)) }, onClick = tactile { moreMenu = false; onQueue() })
                            listOf(.75f, 1f, 1.25f, 1.5f, 1.75f, 2f).forEach { rate ->
                                DropdownMenuItem(
                                    text = { Text("${rate}×", color = if (rate == speed) MaterialTheme.colorScheme.primary else Color.Unspecified) },
                                    onClick = tactile { vm.controller?.setPlaybackSpeed(rate); speed = rate; moreMenu = false },
                                )
                            }
                        }
                    }
                }
            }
            state.playbackError?.let { message ->
                Surface(
                    modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.85f),
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            message,
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        TextButton(tactile(vm::toggle)) {
                            Text(stringResource(R.string.pod_player_retry))
                        }
                    }
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
