package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Shares the navigation surface; the album only lends a soft tint. No per-frame artwork work. */
@Composable internal fun MiniPlayer(
    vm: MusicViewModel,
    state: MusicState,
    onQueue: () -> Unit,
    includeBottomInset: Boolean = false,
    expand: () -> Unit,
) {
    val track = state.current ?: return
    val feedback = LocalTactileFeedback.current
    val art = artworkAtmosphere(vm, track)
    val colors = MaterialTheme.colorScheme
    val dark = LocalDarkAppearance.current
    val tint = art?.tint ?: colors.secondary
    val currentQueueIndex = remember(state.entryId, state.queue) {
        state.queue.indexOfFirst { it.entryId == state.entryId }
    }
    var lastQueueIndex by remember { mutableIntStateOf(currentQueueIndex) }
    var slideDirection by remember { mutableIntStateOf(1) }
    if (currentQueueIndex != lastQueueIndex && currentQueueIndex >= 0 && lastQueueIndex >= 0) {
        slideDirection = if (currentQueueIndex < lastQueueIndex) -1 else 1
        lastQueueIndex = currentQueueIndex
    } else if (currentQueueIndex >= 0) {
        lastQueueIndex = currentQueueIndex
    }
    var rawDragX by remember { mutableFloatStateOf(0f) }
    var draggingX by remember { mutableStateOf(false) }
    val animatedDragX = animateFloatAsState(
        targetValue = if (draggingX) rawDragX * 0.35f else 0f,
        animationSpec = if (draggingX) snap() else spring(stiffness = Spring.StiffnessMediumLow),
        label = "mini-player-drag-x",
    )
    val barColor = colors.surfaceContainer
    Surface(
        modifier = Modifier.fillMaxWidth().testTag("mini-player")
            .trackSwipeGestures(
                enabled = true,
                onPrevious = {
                    slideDirection = -1
                    feedback(TactileKind.Tap)
                    vm.previous()
                },
                onNext = {
                    slideDirection = 1
                    feedback(TactileKind.Tap)
                    vm.next()
                },
                onDragOffset = { offset, active ->
                    rawDragX = offset
                    draggingX = active
                },
            ),
        color = barColor,
        tonalElevation = 0.dp,
    ) {
        Column(Modifier.fillMaxWidth()) {
            HorizontalDivider(
                thickness = 0.5.dp,
                color = colors.outlineVariant.copy(alpha = 0.35f),
            )
            Box(Modifier.fillMaxWidth()) {
                Row(
                    Modifier.fillMaxWidth()
                        .background(Brush.horizontalGradient(listOf(tint.copy(alpha = if (dark) .14f else .10f), Color.Transparent)))
                        .then(
                            if (includeBottomInset) {
                                Modifier.windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                            } else {
                                Modifier
                            }
                        )
                        .padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AnimatedContent(
                        targetState = track,
                        modifier = Modifier.weight(1f).testTag("mini-player-open")
                            .drawWithContent {
                                withTransform({ translate(left = animatedDragX.value) }) {
                                    this@drawWithContent.drawContent()
                                }
                            }
                            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = tactile(expand)),
                        transitionSpec = {
                            val dir = slideDirection
                            (fadeIn(tween(220)) + slideInHorizontally(tween(240, easing = FastOutSlowInEasing)) { fullWidth -> dir * (fullWidth / 4) })
                                .togetherWith(fadeOut(tween(150)) + slideOutHorizontally(tween(220, easing = FastOutSlowInEasing)) { fullWidth -> -dir * (fullWidth / 4) })
                        },
                        contentKey = { it.id },
                        label = "mini-player-track",
                    ) { currentTrack ->
                        Row(
                            Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Surface(
                                shape = RoundedCornerShape(8.dp),
                                color = colors.surfaceContainerHighest,
                                border = BorderStroke(1.dp, colors.outlineVariant),
                            ) {
                                Cover(vm, currentTrack.coverId, currentTrack.title, Modifier.size(44.dp))
                            }
                            Column(Modifier.weight(1f).padding(vertical = 2.dp)) {
                                Text(currentTrack.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(currentTrack.artist, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                    Spacer(Modifier.width(4.dp))
                    FilledIconButton(
                        onClick = tactile(vm::toggle),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = colors.primary,
                            contentColor = colors.onPrimary,
                        ),
                        modifier = Modifier.size(38.dp),
                    ) {
                        Icon(
                            if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                            if (state.playing) stringResource(R.string.pause) else stringResource(R.string.play),
                            Modifier.size(22.dp).offset(x = if (state.playing) 0.dp else 1.dp),
                        )
                    }
                    IconButton(tactile(onQueue), Modifier.testTag("mini-player-queue")) {
                        Icon(Icons.AutoMirrored.Filled.QueueMusic, stringResource(R.string.play_queue), tint = colors.onSurfaceVariant)
                    }
                }
                MiniPlayerProgress(
                    vm,
                    state.duration,
                    includeBottomInset,
                    Modifier.align(if (includeBottomInset) Alignment.TopCenter else Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun MiniPlayerProgress(
    vm: MusicViewModel,
    duration: Long,
    includeBottomInset: Boolean,
    modifier: Modifier = Modifier,
) {
    val position by vm.position.collectAsStateWithLifecycle()
    val fraction = if (duration > 0L) (position.toFloat() / duration.toFloat()).coerceIn(0f, 1f) else 0f
    MiniPlayerProgressTrack(fraction, includeBottomInset, modifier)
}

@Composable
private fun MiniPlayerProgressTrack(
    fraction: Float,
    includeBottomInset: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    if (fraction > 0f) {
        Box(modifier.fillMaxWidth().height(2.dp).background(colors.outlineVariant.copy(alpha = 0.35f))) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(fraction).background(colors.primary.copy(alpha = 0.9f)))
        }
    } else if (!includeBottomInset) {
        HorizontalDivider(
            modifier = modifier,
            thickness = 0.5.dp,
            color = colors.outlineVariant.copy(alpha = 0.35f),
        )
    }
}

@Composable
internal fun BookMiniPlayer(
    vm: MusicViewModel,
    bookState: BookPlaybackState,
    includeBottomInset: Boolean = false,
    onChapters: () -> Unit,
    expand: () -> Unit,
) {
    val book = bookState.book ?: return
    val colors = MaterialTheme.colorScheme
    val chapterTitle = bookState.activeChapter?.title ?: book.title
    val subtitle = if (bookState.activeChapter != null) book.title else book.authors.joinToString(" · ")
    val positionMs by vm.bookPlayback.positionMs.collectAsStateWithLifecycle()
    val durationMs = bookState.durationMs.takeIf { it > 0L } ?: bookState.activeChapter?.resolvedDurationMs ?: 0L
    val fraction = if (durationMs > 0L) (positionMs.toFloat() / durationMs.toFloat()).coerceIn(0f, 1f) else 0f
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("book-mini-player")
            .trackSwipeGestures(
                enabled = bookState.chapters.size > 1,
                onPrevious = {
                    val prev = (bookState.index - 1).coerceAtLeast(0)
                    if (prev != bookState.index) vm.bookPlayback.selectChapter(prev, bookState.playing)
                },
                onNext = {
                    val next = (bookState.index + 1).coerceAtMost(bookState.chapters.lastIndex)
                    if (next != bookState.index) vm.bookPlayback.selectChapter(next, bookState.playing)
                },
            ),
        color = colors.surfaceContainer,
        tonalElevation = 0.dp,
    ) {
        Column(Modifier.fillMaxWidth()) {
            HorizontalDivider(
                thickness = 0.5.dp,
                color = colors.outlineVariant.copy(alpha = 0.35f),
            )
            Box(Modifier.fillMaxWidth()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(
                            if (includeBottomInset) {
                                Modifier.windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                            } else {
                                Modifier
                            },
                        )
                        .padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Row(
                        Modifier
                            .weight(1f)
                            .testTag("book-mini-player-open")
                            .clickable(
                                interactionSource = remember { MutableInteractionSource() },
                                indication = null,
                                onClick = tactile(expand),
                            ),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        BookCoverThumb(
                            vm = vm,
                            book = book,
                            modifier = Modifier.size(width = 34.dp, height = 46.dp),
                            cornerRadius = 6.dp,
                            monogramSize = 16.sp,
                        )
                        Column(Modifier.weight(1f).padding(vertical = 2.dp)) {
                            Text(
                                chapterTitle,
                                style = MaterialTheme.typography.titleSmall,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            if (subtitle.isNotBlank()) {
                                Text(
                                    subtitle,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = colors.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    Spacer(Modifier.width(4.dp))
                    FilledIconButton(
                        onClick = tactile(vm.bookPlayback::togglePlay),
                        enabled = !bookState.loading,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = colors.primary,
                            contentColor = colors.onPrimary,
                        ),
                        modifier = Modifier.size(38.dp).testTag("book-mini-player-toggle"),
                    ) {
                        if (bookState.loading || delayed(bookState.buffering, 300)) {
                            CircularProgressIndicator(
                                Modifier.size(18.dp),
                                color = colors.onPrimary,
                                strokeWidth = 2.dp,
                            )
                        } else {
                            Icon(
                                if (bookState.playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                                if (bookState.playing) stringResource(R.string.pause) else stringResource(R.string.play),
                                Modifier.size(22.dp).offset(x = if (bookState.playing) 0.dp else 1.dp),
                            )
                        }
                    }
                    IconButton(tactile(onChapters), Modifier.testTag("book-mini-player-chapters")) {
                        Icon(
                            Icons.AutoMirrored.Filled.FormatListBulleted,
                            stringResource(R.string.books_chapters),
                            tint = colors.onSurfaceVariant,
                        )
                    }
                }
                MiniPlayerProgressTrack(
                    fraction = fraction,
                    includeBottomInset = includeBottomInset,
                    modifier = Modifier.align(if (includeBottomInset) Alignment.TopCenter else Alignment.BottomCenter),
                )
            }
        }
    }
}
