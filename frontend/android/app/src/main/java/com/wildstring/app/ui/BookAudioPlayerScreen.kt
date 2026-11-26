@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.FormatListBulleted
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.wildstring.app.R
import com.wildstring.app.data.BookAudioChapter
import com.wildstring.app.data.BookSummary
import com.wildstring.app.data.formatTime

@Composable
internal fun BookCoverThumb(
    vm: MusicViewModel,
    book: BookSummary,
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 8.dp,
    monogramSize: TextUnit = 20.sp,
    cacheRevision: Int = 0,
) {
    val profile by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val shape = RoundedCornerShape(cornerRadius)
    val dark = LocalDarkAppearance.current
    val placeholderBg = if (dark) Color(0xFF2B2521) else Color(0xFFE7E2D4)
    val monogramColor = if (dark) Color(0xFFE8E3D9) else Color(0xFF423D32)
    val monogram = book.title.trim().firstOrNull()?.uppercase() ?: "B"

    @Composable
    fun MonogramBox() {
        Box(
            Modifier.fillMaxSize().background(placeholderBg),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                monogram,
                fontFamily = FontFamily.Serif,
                fontWeight = FontWeight.Medium,
                fontSize = monogramSize,
                color = monogramColor,
            )
        }
    }

    Surface(
        modifier = modifier,
        shape = shape,
        color = placeholderBg,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        if (!book.hasCover) {
            MonogramBox()
        } else {
            val url = vm.repository.url("api", "v1", "books", book.id, "cover") + "?rev=$cacheRevision"
            SubcomposeAsyncImage(
                model = ImageRequest.Builder(LocalContext.current)
                    .data(url)
                    .memoryCacheKey("${profile.orEmpty()}:${book.id}:cover:$cacheRevision")
                    .crossfade(160)
                    .build(),
                imageLoader = vm.imageLoader,
                contentDescription = book.title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                loading = { MonogramBox() },
                error = { MonogramBox() },
            )
        }
    }
}

@Composable
internal fun BookAudioPlayerScreen(
    vm: MusicViewModel,
    bookState: BookPlaybackState,
    wide: Boolean,
    chaptersSheetOpen: Boolean,
    onChaptersSheetChange: (Boolean) -> Unit,
    onDismiss: () -> Unit,
    onOpenBook: (String) -> Unit,
) {
    val book = bookState.book ?: return
    val positionMs by vm.bookPlayback.positionMs.collectAsStateWithLifecycle()
    val durationMs = bookState.durationMs.takeIf { it > 0L } ?: bookState.activeChapter?.resolvedDurationMs ?: 0L
    val feedback = LocalTactileFeedback.current
    var sleepDialog by remember { mutableStateOf(false) }
    var speedMenuOpen by remember { mutableStateOf(false) }

    BackHandler(true) {
        when {
            chaptersSheetOpen -> onChaptersSheetChange(false)
            sleepDialog -> sleepDialog = false
            else -> onDismiss()
        }
    }

    Surface(
        modifier = Modifier
            .fillMaxSize()
            .testTag("book-audio-player"),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .safeDrawingPadding()
                .padding(horizontal = if (wide) 32.dp else 20.dp, vertical = 8.dp),
        ) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .dismissPlayerSwipe(!chaptersSheetOpen, onDismiss, onThresholdCrossed = { feedback(TactileKind.Tap) }),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(tactile(onDismiss), Modifier.testTag("book-audio-collapse")) {
                    Icon(Icons.Default.KeyboardArrowDown, stringResource(R.string.player_collapse))
                }
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        stringResource(R.string.books_audiobook),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(
                    tactile { sleepDialog = true },
                    Modifier.semantics { selected = bookState.sleepMinutes > 0 },
                ) {
                    Icon(
                        Icons.Default.Bedtime,
                        stringResource(R.string.books_sleep),
                        tint = if (bookState.sleepMinutes > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                IconButton(
                    onClick = tactile {
                        vm.bookPlayback.stopAndClose()
                        onDismiss()
                    },
                    modifier = Modifier.testTag("book-audio-stop"),
                ) {
                    Icon(Icons.Default.Close, stringResource(R.string.books_stop_listening))
                }
            }

            if (wide) {
                Row(
                    Modifier
                        .weight(1f)
                        .widthIn(max = 1120.dp)
                        .fillMaxWidth()
                        .align(Alignment.CenterHorizontally)
                        .padding(vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(36.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(
                        Modifier
                            .weight(0.95f)
                            .fillMaxHeight()
                            .verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        BookPlayerControlsPane(
                            vm = vm,
                            book = book,
                            bookState = bookState,
                            positionMs = positionMs,
                            durationMs = durationMs,
                            compactArt = false,
                            speedMenuOpen = speedMenuOpen,
                            onSpeedMenuChange = { speedMenuOpen = it },
                            onOpenBook = onOpenBook,
                            onOpenChapters = null,
                        )
                    }
                    Surface(
                        Modifier.weight(1.05f).fillMaxHeight(),
                        shape = RoundedCornerShape(16.dp),
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    ) {
                        Column(Modifier.fillMaxSize().padding(16.dp)) {
                            Row(
                                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    stringResource(R.string.books_chapters),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                Text(
                                    stringResource(R.string.books_chapter_count, bookState.chapters.size),
                                    style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
                            BookPlayerChapterList(
                                chapters = bookState.chapters,
                                activeIndex = bookState.index,
                                playing = bookState.playing,
                                modifier = Modifier.fillMaxSize(),
                                onSelect = { index -> vm.bookPlayback.selectChapter(index, true) },
                            )
                        }
                    }
                }
            } else {
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                    val compactArt = maxHeight < 580.dp
                    Column(
                        Modifier
                            .fillMaxSize()
                            .verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.SpaceEvenly,
                    ) {
                        BookPlayerControlsPane(
                            vm = vm,
                            book = book,
                            bookState = bookState,
                            positionMs = positionMs,
                            durationMs = durationMs,
                            compactArt = compactArt,
                            speedMenuOpen = speedMenuOpen,
                            onSpeedMenuChange = { speedMenuOpen = it },
                            onOpenBook = onOpenBook,
                            onOpenChapters = { onChaptersSheetChange(true) },
                        )
                    }
                }
            }
        }
    }

    if (chaptersSheetOpen) {
        ModalBottomSheet(
            onDismissRequest = { onChaptersSheetChange(false) },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 520.dp)
                    .padding(horizontal = 16.dp),
            ) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        stringResource(R.string.books_chapters),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        stringResource(R.string.books_chapter_count, bookState.chapters.size),
                        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
                BookPlayerChapterList(
                    chapters = bookState.chapters,
                    activeIndex = bookState.index,
                    playing = bookState.playing,
                    modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
                    onSelect = { index ->
                        vm.bookPlayback.selectChapter(index, true)
                        onChaptersSheetChange(false)
                    },
                )
                Spacer(Modifier.height(16.dp))
            }
        }
    }

    if (sleepDialog) {
        AlertDialog(
            onDismissRequest = { sleepDialog = false },
            title = { Text(stringResource(R.string.books_sleep)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        if (bookState.sleepMinutes > 0) stringResource(R.string.sleep_remaining, bookState.sleepMinutes)
                        else stringResource(R.string.not_enabled),
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        listOf(0, 15, 30, 45, 60).forEach { mins ->
                            val selected = bookState.sleepMinutes == mins && mins > 0
                            BookChoicePill(
                                label = if (mins == 0) stringResource(R.string.sleep_cancel) else stringResource(R.string.books_minutes, mins),
                                selected = selected,
                                onClick = {
                                    vm.bookPlayback.setSleep(mins)
                                    sleepDialog = false
                                },
                            )
                        }
                    }
                }
            },
            confirmButton = {
                TextButton({ sleepDialog = false }) { Text(stringResource(R.string.close)) }
            },
        )
    }
}

@Composable
private fun BookPlayerControlsPane(
    vm: MusicViewModel,
    book: BookSummary,
    bookState: BookPlaybackState,
    positionMs: Long,
    durationMs: Long,
    compactArt: Boolean,
    speedMenuOpen: Boolean,
    onSpeedMenuChange: (Boolean) -> Unit,
    onOpenBook: (String) -> Unit,
    onOpenChapters: (() -> Unit)?,
) {
    val feedback = LocalTactileFeedback.current
    var scrubMs by remember(book.id, bookState.index) { mutableStateOf<Float?>(null) }
    val activeChapter = bookState.activeChapter
    val coverHeight = if (compactArt) 144.dp else 210.dp
    val coverWidth = (coverHeight.value * 0.72f).dp

    BookCoverThumb(
        vm = vm,
        book = book,
        modifier = Modifier.size(width = coverWidth, height = coverHeight),
        cornerRadius = 12.dp,
        monogramSize = 42.sp,
    )
    Spacer(Modifier.height(14.dp))
    Column(
        Modifier.widthIn(max = 460.dp).fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            book.title,
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .clickable { onOpenBook(book.id) }
                .padding(horizontal = 8.dp, vertical = 2.dp),
            fontFamily = FontFamily.Serif,
            fontWeight = FontWeight.Medium,
            fontSize = 22.sp,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Text(
            activeChapter?.title ?: book.authors.joinToString(" · "),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (book.authors.isNotEmpty() && activeChapter != null) {
            Text(
                book.authors.joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.outline,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }

    Spacer(Modifier.height(14.dp))

    Column(Modifier.widthIn(max = 460.dp).fillMaxWidth()) {
        val displayPos = scrubMs?.toLong() ?: positionMs
        val maxRange = durationMs.coerceAtLeast(1L).toFloat()
        PlaybackSlider(
            value = (scrubMs ?: positionMs.toFloat()).coerceIn(0f, maxRange),
            onValueChange = { scrubMs = it },
            onValueChangeFinished = {
                scrubMs?.let {
                    feedback(TactileKind.Tap)
                    vm.bookPlayback.seekTo(it.toLong())
                }
                scrubMs = null
            },
            valueRange = 0f..maxRange,
            enabled = durationMs > 0L && !bookState.loading,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                formatTime(displayPos),
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                formatTime(durationMs),
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }

    Spacer(Modifier.height(8.dp))

    Row(
        Modifier.widthIn(max = 460.dp).fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(
            onClick = tactile { vm.bookPlayback.seekBy(-15_000L) },
            enabled = activeChapter != null && !bookState.loading,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Replay, stringResource(R.string.pod_player_rewind_15), Modifier.size(28.dp))
                Text("15", fontSize = 10.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 3.dp))
            }
        }
        IconButton(
            onClick = tactile { vm.bookPlayback.selectChapter((bookState.index - 1).coerceAtLeast(0), bookState.playing) },
            enabled = bookState.chapters.isNotEmpty() && bookState.index > 0 && !bookState.loading,
        ) {
            Icon(Icons.Default.SkipPrevious, stringResource(R.string.books_prev_chapter), Modifier.size(30.dp))
        }
        FilledIconButton(
            onClick = tactile(vm.bookPlayback::togglePlay),
            enabled = !bookState.loading,
            modifier = Modifier.size(60.dp).testTag("book-audio-play-toggle"),
        ) {
            Box(contentAlignment = Alignment.Center) {
                if (bookState.loading || delayed(bookState.buffering, 300)) {
                    CircularProgressIndicator(
                        Modifier.size(48.dp),
                        color = LocalContentColor.current.copy(alpha = 0.88f),
                        trackColor = LocalContentColor.current.copy(alpha = 0.2f),
                        strokeWidth = 2.dp,
                    )
                }
                Crossfade(bookState.playing, animationSpec = tween(130), label = "book-play-pause") { playing ->
                    Icon(
                        if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                        if (playing) stringResource(R.string.pause) else stringResource(R.string.play),
                        Modifier.size(30.dp),
                    )
                }
            }
        }
        IconButton(
            onClick = tactile { vm.bookPlayback.selectChapter((bookState.index + 1).coerceAtMost(bookState.chapters.lastIndex), bookState.playing) },
            enabled = bookState.chapters.isNotEmpty() && bookState.index < bookState.chapters.lastIndex && !bookState.loading,
        ) {
            Icon(Icons.Default.SkipNext, stringResource(R.string.books_next_chapter), Modifier.size(30.dp))
        }
        IconButton(
            onClick = tactile { vm.bookPlayback.seekBy(30_000L) },
            enabled = activeChapter != null && !bookState.loading,
        ) {
            Icon(Icons.Default.Forward30, stringResource(R.string.pod_player_forward_30), Modifier.size(28.dp))
        }
    }

    Spacer(Modifier.height(10.dp))

    Row(
        Modifier.widthIn(max = 460.dp).fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            OutlinedButton(
                onClick = { onSpeedMenuChange(true) },
                shape = RoundedCornerShape(999.dp),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Icon(Icons.Default.Speed, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    "${bookState.speed}×",
                    style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                )
            }
            DropdownMenu(expanded = speedMenuOpen, onDismissRequest = { onSpeedMenuChange(false) }) {
                BOOK_PLAYBACK_RATES.forEach { rate ->
                    DropdownMenuItem(
                        text = { Text("${rate}×", style = LocalTextStyle.current.copy(fontFeatureSettings = "tnum")) },
                        trailingIcon = if (kotlin.math.abs(bookState.speed - rate) < 0.01f) {
                            { Icon(Icons.Default.Check, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.primary) }
                        } else null,
                        onClick = {
                            onSpeedMenuChange(false)
                            vm.bookPlayback.setSpeed(rate)
                        },
                    )
                }
            }
        }
        if (onOpenChapters != null) {
            OutlinedButton(
                onClick = tactile(onOpenChapters),
                shape = RoundedCornerShape(999.dp),
                modifier = Modifier.heightIn(min = 48.dp),
            ) {
                Icon(Icons.AutoMirrored.Filled.FormatListBulleted, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.books_chapters))
            }
        }
    }

    if (bookState.syncConflict) {
        Surface(
            modifier = Modifier
                .widthIn(max = 460.dp)
                .fillMaxWidth()
                .padding(top = 10.dp)
                .testTag("book-audio-sync-conflict"),
            shape = RoundedCornerShape(12.dp),
            color = MaterialTheme.colorScheme.errorContainer,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.error.copy(alpha = 0.35f)),
        ) {
            Row(
                Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    stringResource(R.string.books_audio_sync_conflict),
                    Modifier.weight(1f),
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                )
                TextButton(
                    onClick = { vm.bookPlayback.reloadFromServer() },
                    modifier = Modifier.testTag("book-audio-sync-reload"),
                ) {
                    Text(stringResource(R.string.books_resume_from_server))
                }
            }
        }
    } else if (bookState.error != null) {
        Text(
            bookState.error,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}

@Composable
private fun BookPlayerChapterList(
    chapters: List<BookAudioChapter>,
    activeIndex: Int,
    playing: Boolean,
    modifier: Modifier = Modifier,
    onSelect: (Int) -> Unit,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(activeIndex) {
        if (activeIndex in chapters.indices) {
            listState.animateScrollToItem(activeIndex)
        }
    }
    LazyColumn(
        state = listState,
        modifier = modifier,
        contentPadding = PaddingValues(vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        items(chapters, key = { it.index }) { chapter ->
            val current = chapter.index == activeIndex
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (current) MaterialTheme.colorScheme.surfaceVariant else Color.Transparent)
                    .clickable { onSelect(chapter.index) }
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.width(28.dp), contentAlignment = Alignment.Center) {
                    if (current && playing) {
                        Icon(
                            Icons.Default.GraphicEq,
                            null,
                            Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    } else {
                        Text(
                            "%02d".format(chapter.index + 1),
                            style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                            color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                Text(
                    chapter.title,
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    formatTime(chapter.resolvedDurationMs),
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace, fontFeatureSettings = "tnum"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
