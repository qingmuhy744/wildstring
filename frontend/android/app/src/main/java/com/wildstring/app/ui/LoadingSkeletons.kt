package com.wildstring.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** Static, low-motion placeholders. They keep the final layout stable without a shimmer animation. */
@Composable
internal fun SkeletonBlock(modifier: Modifier, shape: RoundedCornerShape = RoundedCornerShape(10.dp)) {
    Box(modifier.clip(shape).background(MaterialTheme.colorScheme.surfaceContainerHigh))
}

@Composable
internal fun SkeletonLine(modifier: Modifier = Modifier, widthFraction: Float = 1f) {
    SkeletonBlock(modifier.fillMaxWidth(widthFraction).height(14.dp), RoundedCornerShape(7.dp))
}

@Composable
internal fun CatalogSkeleton(kind: String, modifier: Modifier = Modifier, tab: String = "") {
    val pad = LocalAndroidLayoutMode.current == AndroidLayoutMode.Pad
    val rowSize = LocalSongListSize.current
    Surface(modifier.fillMaxSize().testTag("catalog-skeleton"), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            val trackColumns = pad && maxWidth >= 760.dp && tab.isNotBlank()
            val cardGrid = pad && kind in listOf("artists", "playlists") && tab.isNotBlank()
            when {
                kind == "albums" -> {
                    val albumColumns = if (pad) ((minOf(maxWidth, 1180.dp) - 16.dp) / 156.dp).toInt().coerceAtLeast(3) else 2
                    LazyVerticalGrid(
                        columns = if (pad) GridCells.Adaptive(140.dp) else GridCells.Fixed(2),
                        modifier = Modifier.widthIn(max = 1180.dp).fillMaxSize(),
                        contentPadding = PaddingValues(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(16.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                        userScrollEnabled = false,
                    ) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Box(Modifier.fillMaxWidth().height(48.dp), contentAlignment = Alignment.CenterEnd) {
                                SkeletonLine(Modifier.width(100.dp))
                            }
                        }
                        items(albumColumns * 3) { index ->
                            Column(Modifier.testTag("album-skeleton-$index"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                SkeletonBlock(Modifier.fillMaxWidth().aspectRatio(1f))
                                SkeletonLine(widthFraction = .72f)
                                SkeletonLine(widthFraction = .45f)
                            }
                        }
                    }
                }
                cardGrid -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(260.dp),
                    modifier = Modifier.widthIn(max = 1180.dp).fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    userScrollEnabled = false,
                ) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        if (tab == "mine") PadPersonalSkeletonHeader()
                        else Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            repeat(5) {
                                SkeletonBlock(Modifier.width(72.dp).height(32.dp), RoundedCornerShape(8.dp))
                            }
                        }
                    }
                    items(12) { index ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 12.dp).testTag("catalog-skeleton-card-$index"),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(16.dp),
                        ) {
                            SkeletonBlock(Modifier.size(44.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                SkeletonLine(widthFraction = .68f)
                                SkeletonLine(widthFraction = .42f)
                            }
                        }
                    }
                }
                trackColumns -> LazyColumn(
                    Modifier.widthIn(max = 1180.dp).fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                    userScrollEnabled = false,
                ) {
                    item {
                        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            SkeletonBlock(Modifier.width(96.dp).height(36.dp), RoundedCornerShape(18.dp))
                            Spacer(Modifier.width(10.dp))
                            SkeletonLine(Modifier.width(68.dp))
                            Spacer(Modifier.weight(1f))
                            SkeletonBlock(Modifier.width(88.dp).height(32.dp), RoundedCornerShape(8.dp))
                        }
                    }
                    item {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Spacer(Modifier.width(rowSize.coverDp.dp))
                            Box(Modifier.weight(2.4f).padding(start = 14.dp)) { SkeletonLine(Modifier.width(44.dp)) }
                            Box(Modifier.weight(1.4f).padding(start = 24.dp)) { SkeletonLine(Modifier.width(44.dp)) }
                            Box(Modifier.weight(1.7f).padding(start = 24.dp)) { SkeletonLine(Modifier.width(44.dp)) }
                            Box(Modifier.width(52.dp), contentAlignment = Alignment.CenterEnd) { SkeletonLine(Modifier.width(34.dp)) }
                            Spacer(Modifier.width(48.dp))
                        }
                    }
                    items(10) { index ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = rowSize.rowDp.dp).padding(horizontal = 16.dp, vertical = 4.dp).testTag("catalog-skeleton-row-$index"),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            SkeletonBlock(Modifier.size(rowSize.coverDp.dp))
                            Box(Modifier.weight(2.4f).padding(start = 14.dp, end = 8.dp)) {
                                SkeletonLine(widthFraction = .62f)
                            }
                            Box(Modifier.weight(1.4f).padding(end = 12.dp)) {
                                SkeletonLine(widthFraction = .55f)
                            }
                            Box(Modifier.weight(1.7f).padding(end = 12.dp)) {
                                SkeletonLine(widthFraction = .65f)
                            }
                            Box(Modifier.width(52.dp), contentAlignment = Alignment.CenterEnd) {
                                SkeletonBlock(Modifier.width(38.dp).height(12.dp), RoundedCornerShape(6.dp))
                            }
                            Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                                SkeletonBlock(Modifier.size(20.dp), CircleShape)
                            }
                        }
                    }
                }
                else -> LazyColumn(
                    Modifier.widthIn(max = 1180.dp).fillMaxSize(),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    userScrollEnabled = false,
                ) {
                    if (tab == "mine") item {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            SkeletonBlock(Modifier.fillMaxWidth().height(56.dp), RoundedCornerShape(14.dp))
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                repeat(3) {
                                    SkeletonBlock(Modifier.weight(1f).height(54.dp), RoundedCornerShape(14.dp))
                                }
                            }
                            SkeletonLine(Modifier.width(110.dp), 1f)
                        }
                    } else if (tab.isNotBlank()) item {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            SkeletonLine(Modifier.width(150.dp), .55f)
                            SkeletonLine(Modifier.width(230.dp), .78f)
                        }
                    }
                    items(8) { index ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = rowSize.rowDp.dp).testTag("catalog-skeleton-row-$index"),
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            SkeletonBlock(Modifier.size(rowSize.coverDp.dp))
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                SkeletonLine(widthFraction = .72f)
                                SkeletonLine(widthFraction = .45f)
                            }
                            SkeletonBlock(Modifier.size(24.dp), CircleShape)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PadPersonalSkeletonHeader() {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(20.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Column(Modifier.width(336.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                SkeletonBlock(Modifier.size(56.dp), CircleShape)
                SkeletonLine(Modifier.width(120.dp), 1f)
            }
            SkeletonBlock(Modifier.fillMaxWidth().height(56.dp), RoundedCornerShape(14.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(3) {
                    SkeletonBlock(Modifier.weight(1f).height(54.dp), RoundedCornerShape(14.dp))
                }
            }
            SkeletonLine(Modifier.width(110.dp), 1f)
        }
    }
}

@Composable
internal fun DiscoverySkeleton(modifier: Modifier = Modifier) {
    val pad = LocalAndroidLayoutMode.current == AndroidLayoutMode.Pad
    Surface(modifier.fillMaxSize().testTag("discovery-skeleton"), color = MaterialTheme.colorScheme.background) {
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
            val columns = pad && maxWidth >= 760.dp
            LazyColumn(
                Modifier.widthIn(max = 1040.dp).fillMaxSize(),
                contentPadding = PaddingValues(bottom = 24.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                userScrollEnabled = false,
            ) {
                item {
                    Row(
                        (if (pad) Modifier.widthIn(max = 720.dp) else Modifier)
                            .fillMaxWidth()
                            .padding(horizontal = 20.dp, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        repeat(3) { index ->
                            SkeletonBlock(
                                Modifier.weight(1f).height(54.dp).testTag("discovery-skeleton-shortcut-$index"),
                                RoundedCornerShape(14.dp),
                            )
                        }
                    }
                }
                item {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        SkeletonLine(Modifier.width(140.dp), 1f)
                        SkeletonLine(Modifier.width(56.dp), 1f)
                    }
                }
                item {
                    LazyRow(
                        modifier = if (pad) Modifier.fillMaxWidth().padding(horizontal = 20.dp) else Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = if (pad) 0.dp else 20.dp),
                        horizontalArrangement = Arrangement.spacedBy(14.dp),
                        userScrollEnabled = false,
                    ) {
                        items(8) { index ->
                            Column(Modifier.width(116.dp).testTag("discovery-skeleton-album-$index")) {
                                SkeletonBlock(Modifier.size(116.dp))
                                Spacer(Modifier.height(8.dp))
                                SkeletonLine(widthFraction = .78f)
                                Spacer(Modifier.height(6.dp))
                                SkeletonLine(widthFraction = .52f)
                            }
                        }
                    }
                }
                item {
                    Spacer(Modifier.height(4.dp))
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        SkeletonLine(Modifier.width(140.dp), 1f)
                        SkeletonLine(Modifier.width(56.dp), 1f)
                    }
                }
                items(5) { index ->
                    DiscoveryTrackSkeletonRow(columns, index)
                }
                item {
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        SkeletonLine(Modifier.width(110.dp), 1f)
                        SkeletonLine(Modifier.width(56.dp), 1f)
                    }
                }
                items(3) { index ->
                    DiscoveryTrackSkeletonRow(columns, 5 + index)
                }
            }
        }
    }
}

@Composable
private fun DiscoveryTrackSkeletonRow(columns: Boolean, index: Int) {
    if (columns) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp).testTag("discovery-skeleton-track-$index"),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SkeletonBlock(Modifier.size(48.dp))
            Box(Modifier.weight(2.4f).padding(start = 16.dp, end = 8.dp)) {
                SkeletonLine(widthFraction = .66f)
            }
            Box(Modifier.weight(1.4f).padding(end = 12.dp)) {
                SkeletonLine(widthFraction = .58f)
            }
            Box(Modifier.weight(1.7f).padding(end = 12.dp)) {
                SkeletonLine(widthFraction = .64f)
            }
            Box(Modifier.width(52.dp), contentAlignment = Alignment.CenterEnd) {
                SkeletonBlock(Modifier.width(38.dp).height(12.dp), RoundedCornerShape(6.dp))
            }
        }
    } else {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp).testTag("discovery-skeleton-track-$index"),
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            SkeletonBlock(Modifier.size(48.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SkeletonLine(widthFraction = .66f)
                SkeletonLine(widthFraction = .42f)
            }
            SkeletonBlock(Modifier.size(28.dp), CircleShape)
        }
    }
}

@Composable
internal fun LyricsSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().testTag("lyrics-skeleton"), verticalArrangement = Arrangement.spacedBy(22.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.weight(1f))
        repeat(5) { index ->
            SkeletonLine(Modifier.width(if (index == 2) 210.dp else 150.dp), 1f)
            SkeletonLine(Modifier.width(if (index == 2) 120.dp else 90.dp), 1f)
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable
internal fun ReviewSkeleton(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().testTag("review-skeleton"), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 840.dp).fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            SkeletonLine(Modifier.width(180.dp), .6f)
            SkeletonLine(Modifier.width(300.dp), .9f)
            repeat(5) {
                Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        SkeletonLine(widthFraction = .25f)
                        SkeletonLine(widthFraction = .72f)
                        SkeletonLine(widthFraction = .54f)
                    }
                }
            }
        }
    }
}

@Composable
internal fun AgentSkeleton(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().testTag("agent-skeleton"), contentAlignment = Alignment.TopCenter) {
        Column(Modifier.widthIn(max = 840.dp).fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SkeletonLine(Modifier.width(160.dp), .55f)
            repeat(4) {
                Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        SkeletonLine(widthFraction = .32f); SkeletonLine(widthFraction = .88f); SkeletonLine(widthFraction = .64f)
                    }
                }
            }
        }
    }
}

@Composable
internal fun PodcastExploreResultsSkeleton(modifier: Modifier = Modifier, count: Int = 8) {
    Column(modifier.fillMaxWidth().testTag("podcast-explore-results-skeleton"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(count) {
            Row(Modifier.fillMaxWidth().heightIn(min = 68.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SkeletonBlock(Modifier.size(56.dp), RoundedCornerShape(10.dp))
                Column(Modifier.weight(1f).padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    SkeletonLine(widthFraction = .72f)
                    SkeletonLine(widthFraction = .45f)
                }
            }
        }
    }
}

@Composable
internal fun PodcastExplorePreviewSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().testTag("podcast-explore-preview-skeleton"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            SkeletonBlock(Modifier.size(92.dp), RoundedCornerShape(12.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                SkeletonLine(widthFraction = .7f)
                SkeletonLine(widthFraction = .42f)
            }
        }
        SkeletonLine(widthFraction = .55f)
        SkeletonLine(widthFraction = 1f)
        SkeletonLine(widthFraction = .86f)
        SkeletonLine(widthFraction = .64f)
    }
}
