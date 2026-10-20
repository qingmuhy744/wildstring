package com.wildstring.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
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
internal fun CatalogSkeleton(kind: String, modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxSize().testTag("catalog-skeleton"), color = MaterialTheme.colorScheme.background) {
        LazyColumn(contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SkeletonLine(Modifier.width(150.dp), .55f)
                    SkeletonLine(Modifier.width(230.dp), .78f)
                    if (kind == "albums") SkeletonLine(Modifier.width(100.dp), .35f)
                }
            }
            items(7) {
                Row(Modifier.fillMaxWidth().heightIn(min = 68.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SkeletonBlock(Modifier.size(if (kind == "albums") 84.dp else 52.dp))
                    Column(Modifier.weight(1f).padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        SkeletonLine(widthFraction = .72f)
                        SkeletonLine(widthFraction = .45f)
                    }
                    SkeletonBlock(Modifier.size(28.dp))
                }
            }
        }
    }
}

@Composable
internal fun DiscoverySkeleton(modifier: Modifier = Modifier) {
    Surface(modifier.fillMaxSize().testTag("discovery-skeleton"), color = MaterialTheme.colorScheme.background) {
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            item { SkeletonLine(Modifier.padding(horizontal = 20.dp).width(180.dp), .65f) }
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    repeat(3) { SkeletonBlock(Modifier.weight(1f).aspectRatio(1f)) }
                }
            }
            item { SkeletonLine(Modifier.padding(horizontal = 20.dp).width(140.dp), .5f) }
            items(5) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SkeletonBlock(Modifier.size(54.dp))
                    Column(Modifier.weight(1f).padding(vertical = 6.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                        SkeletonLine(widthFraction = .66f); SkeletonLine(widthFraction = .42f)
                    }
                    SkeletonBlock(Modifier.size(32.dp))
                }
            }
        }
    }
}

@Composable
internal fun LyricsSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().testTag("lyrics-skeleton"), verticalArrangement = Arrangement.spacedBy(22.dp),
        horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
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
    Column(modifier.fillMaxSize().padding(16.dp).testTag("review-skeleton"), verticalArrangement = Arrangement.spacedBy(14.dp)) {
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

@Composable
internal fun AgentSkeleton(modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(16.dp).testTag("agent-skeleton"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
