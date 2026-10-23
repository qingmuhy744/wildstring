package com.wildstring.app.ui

import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.wildstring.app.data.PodcastDetail
import com.wildstring.app.data.PodcastEpisode
import com.wildstring.app.data.PodcastSummary
import kotlinx.coroutines.launch

private val PRESET_FEEDS = listOf(
    "声东击西" to "https://etw.fm/rss",
    "疯投圈" to "https://crazy.capital/feed",
    "NPR News" to "https://feeds.npr.org/500005/podcast.xml",
)

@Composable
fun PodcastChannelPage(
    vm: MusicViewModel,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    var podcasts by remember { mutableStateOf<List<PodcastSummary>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var selectedPodcast by remember { mutableStateOf<PodcastSummary?>(null) }
    var selectedDetail by remember { mutableStateOf<PodcastDetail?>(null) }
    var detailLoading by remember { mutableStateOf(false) }
    var showSubscribeDialog by remember { mutableStateOf(false) }
    var statusMessage by remember { mutableStateOf<String?>(null) }

    fun refreshList() {
        scope.launch {
            loading = true
            try {
                podcasts = vm.repository.podcasts()
            } catch (e: Exception) {
                statusMessage = "获取播客订阅失败: ${e.message}"
            } finally {
                loading = false
            }
        }
    }

    fun loadDetail(p: PodcastSummary) {
        selectedPodcast = p
        scope.launch {
            detailLoading = true
            try {
                selectedDetail = vm.repository.podcastDetail(p.id)
            } catch (e: Exception) {
                statusMessage = "加载单集列表失败: ${e.message}"
            } finally {
                detailLoading = false
            }
        }
    }

    LaunchedEffect(Unit) {
        refreshList()
    }

    Box(modifier = modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        if (selectedPodcast != null) {
            PodcastDetailView(
                podcast = selectedPodcast!!,
                detail = selectedDetail,
                loading = detailLoading,
                onBack = {
                    selectedPodcast = null
                    selectedDetail = null
                    refreshList()
                },
                onRefresh = {
                    scope.launch {
                        detailLoading = true
                        try {
                            selectedDetail = vm.repository.refreshPodcast(selectedPodcast!!.id)
                            statusMessage = "已从源端完成最新单集巡检同步"
                        } catch (e: Exception) {
                            statusMessage = "刷新失败: ${e.message}"
                        } finally {
                            detailLoading = false
                        }
                    }
                },
                onPlayEpisode = { ep ->
                    val podcast = selectedPodcast!!
                    if (podcast.coverUrl.isNotBlank()) {
                        vm.repository.rememberPodcastCover("podcast_ep_${ep.id}", podcast.coverUrl)
                    }
                    val track = ep.toTrack(podcast)
                    vm.play(listOf(track), 0)
                    scope.launch {
                        vm.repository.updatePodcastProgress(
                            episodeId = ep.id,
                            positionSec = ep.positionSeconds,
                            durationSec = ep.durationSeconds,
                            completed = ep.completed,
                        )
                    }
                },
            )
        } else {
            PodcastListView(
                podcasts = podcasts,
                loading = loading,
                onSelect = { loadDetail(it) },
                onAddClick = { showSubscribeDialog = true },
                onRefreshAll = {
                    scope.launch {
                        loading = true
                        try {
                            vm.repository.refreshAllPodcasts()
                            refreshList()
                            statusMessage = "服务端已触发全量巡检更新"
                        } catch (e: Exception) {
                            statusMessage = "更新请求失败: ${e.message}"
                        } finally {
                            loading = false
                        }
                    }
                },
                onDelete = { p ->
                    scope.launch {
                        try {
                            vm.repository.deletePodcast(p.id)
                            refreshList()
                            statusMessage = "已取消订阅: ${p.title}"
                        } catch (e: Exception) {
                            statusMessage = "取消订阅失败: ${e.message}"
                        }
                    }
                },
            )
        }

        if (showSubscribeDialog) {
            SubscribePodcastDialog(
                onDismiss = { showSubscribeDialog = false },
                onConfirm = { url ->
                    showSubscribeDialog = false
                    scope.launch {
                        loading = true
                        try {
                            val detail = vm.repository.subscribePodcast(url)
                            refreshList()
                            loadDetail(detail.podcast)
                            statusMessage = "成功订阅: ${detail.podcast.title}"
                        } catch (e: Exception) {
                            statusMessage = "订阅失败: ${e.message}"
                            loading = false
                        }
                    }
                },
            )
        }

        statusMessage?.let { msg ->
            LaunchedEffect(msg) {
                kotlinx.coroutines.delay(2800)
                statusMessage = null
            }
            Snackbar(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 76.dp, start = 16.dp, end = 16.dp),
            ) {
                Text(msg)
            }
        }
    }
}

@Composable
private fun PodcastListView(
    podcasts: List<PodcastSummary>,
    loading: Boolean,
    onSelect: (PodcastSummary) -> Unit,
    onAddClick: () -> Unit,
    onRefreshAll: () -> Unit,
    onDelete: (PodcastSummary) -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = "播客电台",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                IconButton(onClick = onRefreshAll, modifier = Modifier.size(36.dp)) {
                    Icon(
                        Icons.Default.Refresh,
                        contentDescription = "全部更新",
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(20.dp),
                    )
                }
                FilledTonalButton(
                    onClick = onAddClick,
                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("添加订阅", fontSize = 13.sp, maxLines = 1, softWrap = false)
                }
            }
        }

        if (loading && podcasts.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
        } else if (podcasts.isEmpty()) {
            EmptyPodcastState(onPresetSelect = onAddClick)
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp, top = 8.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(podcasts, key = { it.id }) { podcast ->
                    PodcastCardItem(
                        podcast = podcast,
                        onClick = { onSelect(podcast) },
                        onDelete = { onDelete(podcast) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PodcastCardItem(
    podcast: PodcastSummary,
    onClick: () -> Unit,
    onDelete: () -> Unit,
) {
    var showMenu by remember { mutableStateOf(false) }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(68.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest),
                contentAlignment = Alignment.Center,
            ) {
                if (podcast.coverUrl.isNotBlank()) {
                    AsyncImage(
                        model = ImageRequest.Builder(LocalContext.current)
                            .data(podcast.coverUrl)
                            .crossfade(true)
                            .build(),
                        contentDescription = podcast.title,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                } else {
                    Icon(
                        Icons.Default.Podcasts,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.size(32.dp),
                    )
                }
            }

            Spacer(Modifier.width(14.dp))

            Column(Modifier.weight(1f)) {
                Text(
                    text = podcast.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = podcast.author.ifBlank { "未知播客主" },
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(
                        shape = RoundedCornerShape(6.dp),
                        color = MaterialTheme.colorScheme.secondaryContainer,
                    ) {
                        Text(
                            text = "${podcast.totalEpisodes} 集",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                    if (podcast.unplayedEpisodes > 0) {
                        Spacer(Modifier.width(6.dp))
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.15f),
                        ) {
                            Text(
                                text = "${podcast.unplayedEpisodes} 未听",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
            }

            Box {
                IconButton(onClick = { showMenu = true }) {
                    Icon(
                        Icons.Default.MoreVert,
                        contentDescription = "更多操作",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DropdownMenu(
                    expanded = showMenu,
                    onDismissRequest = { showMenu = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("取消订阅", color = MaterialTheme.colorScheme.error) },
                        onClick = {
                            showMenu = false
                            onDelete()
                        },
                        leadingIcon = {
                            Icon(
                                Icons.Default.DeleteOutline,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error,
                            )
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptyPodcastState(
    onPresetSelect: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(
            shape = CircleShape,
            color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.4f),
            modifier = Modifier.size(88.dp),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(
                    Icons.Default.Podcasts,
                    contentDescription = null,
                    modifier = Modifier.size(46.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        Text(
            text = "暂无订阅播客",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = "输入 RSS 地址或从精选推荐中一键添加\n服务端会在后台自动为您检测最新单集",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = onPresetSelect,
            shape = RoundedCornerShape(20.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
            Spacer(Modifier.width(6.dp))
            Text("立即添加订阅")
        }
    }
}

@Composable
private fun PodcastDetailView(
    podcast: PodcastSummary,
    detail: PodcastDetail?,
    loading: Boolean,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onPlayEpisode: (PodcastEpisode) -> Unit,
) {
    var sortDescending by remember { mutableStateOf(true) }

    val sortedEpisodes = remember(detail?.episodes, sortDescending) {
        val list = detail?.episodes ?: emptyList()
        val parseNum = { ep: PodcastEpisode ->
            if (ep.episodeNumber != null) ep.episodeNumber
            else {
                val match = Regex("""#(\d+)|第\s*(\d+)\s*期""").find(ep.title)
                match?.groupValues?.getOrNull(1)?.toIntOrNull()
                    ?: match?.groupValues?.getOrNull(2)?.toIntOrNull()
                    ?: 0
            }
        }
        if (sortDescending) {
            list.sortedWith(compareByDescending<PodcastEpisode> { it.pubDate }.thenByDescending { parseNum(it) })
        } else {
            list.sortedWith(compareBy<PodcastEpisode> { it.pubDate }.thenBy { parseNum(it) })
        }
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
            Text(
                text = podcast.title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = onRefresh) {
                if (loading) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Default.Refresh, contentDescription = "立即从源刷新")
                }
            }
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = 96.dp),
        ) {
            item {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalAlignment = Alignment.Top,
                ) {
                    Box(
                        modifier = Modifier
                            .size(100.dp)
                            .clip(RoundedCornerShape(16.dp))
                            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (podcast.coverUrl.isNotBlank()) {
                            AsyncImage(
                                model = ImageRequest.Builder(LocalContext.current)
                                    .data(podcast.coverUrl)
                                    .crossfade(true)
                                    .build(),
                                contentDescription = podcast.title,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                            )
                        } else {
                            Icon(
                                Icons.Default.Podcasts,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.size(48.dp),
                            )
                        }
                    }

                    Spacer(Modifier.width(16.dp))

                    Column(Modifier.weight(1f)) {
                        Text(
                            text = podcast.title,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = podcast.author.ifBlank { "未知创作者" },
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = podcast.description.replace(Regex("<[^>]+>"), " ").trim().ifBlank { "暂无简介" },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                Spacer(Modifier.height(8.dp))

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = "单集列表 (${sortedEpisodes.size})",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold,
                    )
                    TextButton(
                        onClick = { sortDescending = !sortDescending },
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp),
                    ) {
                        Icon(
                            if (sortDescending) Icons.Default.ArrowDownward else Icons.Default.ArrowUpward,
                            contentDescription = null,
                            modifier = Modifier.size(16.dp),
                        )
                        Spacer(Modifier.width(4.dp))
                        Text(if (sortDescending) "最近更新" else "最早发布", fontSize = 12.sp)
                    }
                }
            }

            if (sortedEpisodes.isEmpty() && loading) {
                item {
                    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
            } else if (sortedEpisodes.isEmpty()) {
                item {
                    Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                        Text("暂无单集", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            } else {
                items(sortedEpisodes, key = { it.id }) { ep ->
                    EpisodeRowItem(
                        episode = ep,
                        onPlay = { onPlayEpisode(ep) },
                    )
                }
            }
        }
    }
}

@Composable
private fun EpisodeRowItem(
    episode: PodcastEpisode,
    onPlay: () -> Unit,
) {
    val durationText = formatDuration(episode.durationSeconds)

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onPlay)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
    ) {
        Row(
            modifier = Modifier.padding(14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FilledIconButton(
                onClick = onPlay,
                modifier = Modifier.size(42.dp),
                shape = CircleShape,
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            ) {
                Icon(
                    Icons.Default.PlayArrow,
                    contentDescription = "播放单集",
                    modifier = Modifier.size(22.dp),
                )
            }

            Spacer(Modifier.width(14.dp))

            Column(Modifier.weight(1f)) {
                Text(
                    text = episode.title,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (episode.pubDate.isNotBlank()) {
                        Text(
                            text = episode.pubDate.take(16),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    if (durationText.isNotBlank()) {
                        Text(
                            text = durationText,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                    if (episode.completed) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "已听",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                }
            }
        }
    }
}

private fun formatDuration(seconds: Int): String {
    if (seconds <= 0) return ""
    val h = seconds / 3600
    val m = (seconds % 3600) / 60
    val s = seconds % 60
    return if (h > 0) {
        String.format("%d:%02d:%02d", h, m, s)
    } else {
        String.format("%02d:%02d", m, s)
    }
}

@Composable
private fun SubscribePodcastDialog(
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var url by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("订阅播客") },
        text = {
            Column {
                OutlinedTextField(
                    value = url,
                    onValueChange = { url = it },
                    label = { Text("RSS 地址") },
                    placeholder = { Text("https://example.com/feed.xml") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(14.dp))
                Text(
                    text = "或快速添加精选播客：",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(6.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    PRESET_FEEDS.forEach { (name, presetUrl) ->
                        SuggestionChip(
                            onClick = { url = presetUrl },
                            label = { Text(name, fontSize = 12.sp) },
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(url.trim()) },
                enabled = url.isNotBlank(),
            ) {
                Text("订阅")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}
