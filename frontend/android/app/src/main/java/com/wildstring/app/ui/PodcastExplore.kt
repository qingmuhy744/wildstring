package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable internal fun PodcastExploreDialog(vm: MusicViewModel, canAdd: Boolean, onDismiss: () -> Unit, onFollowed: (String) -> Unit) {
    var query by remember { mutableStateOf("") }
    var region by remember { mutableStateOf("") }
    var regionMenu by remember { mutableStateOf(false) }
    val initialCached = remember(region) { vm.repository.cachedPodcastDirectory(region) }
    var page by remember { mutableStateOf<PodcastDirectoryPage?>(initialCached) }
    var selected by remember { mutableStateOf<PodcastDirectoryResult?>(null) }
    var preview by remember { mutableStateOf<PodcastFeedPreview?>(null) }
    var loading by remember { mutableStateOf(initialCached == null) }
    var previewing by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var previewError by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val regions = listOf("" to "服务器默认", "tw" to "台湾", "cn" to "中国大陆", "hk" to "香港", "us" to "美国", "jp" to "日本", "gb" to "英国")
    val trimmedQuery = query.trim()
    val isRssUrl = trimmedQuery.startsWith("http://", ignoreCase = true) || trimmedQuery.startsWith("https://", ignoreCase = true)
    val activeFeedUrl = if (isRssUrl) trimmedQuery else selected?.feedUrl

    LaunchedEffect(trimmedQuery, region, retry, isRssUrl) {
        if (isRssUrl) {
            loading = false; error = null; page = null; selected = null
            return@LaunchedEffect
        }
        val cached = if (trimmedQuery.isBlank() && retry == 0) vm.repository.cachedPodcastDirectory(region) else null
        if (cached != null) {
            page = cached
            loading = false
            error = null
            selected = null
            return@LaunchedEffect
        }
        loading = true; error = null; page = null; selected = null
        if (trimmedQuery.isNotBlank()) delay(350)
        try { page = vm.repository.podcastDirectory(trimmedQuery, region, forceRefresh = retry > 0) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = friendlyError(e) }
        finally { loading = false }
    }
    LaunchedEffect(activeFeedUrl) {
        preview = null; previewError = null
        val feedUrl = activeFeedUrl ?: return@LaunchedEffect
        if (isRssUrl) delay(350)
        previewing = true
        try { preview = vm.repository.previewPodcast(feedUrl) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { previewError = friendlyError(e) }
        finally { previewing = false }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize().systemBarsPadding().testTag("podcast-explore")) {
            BackHandler(selected != null) { selected = null }
            Column(Modifier.fillMaxSize().widthIn(max = 840.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton({ if (selected != null) selected = null else onDismiss() }) {
                        Icon(if (selected != null) Icons.AutoMirrored.Filled.ArrowBack else Icons.Default.Close, if (selected != null) "返回探索列表" else "关闭探索")
                    }
                    Text(
                        text = if (canAdd) "探索与添加播客" else "探索播客",
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.weight(1f),
                    )
                    Box {
                        TextButton({ regionMenu = true }, enabled = query.isBlank() && !busy) { Text(regions.first { it.first == region }.second) }
                        DropdownMenu(regionMenu, { regionMenu = false }) {
                            regions.forEach { (code, name) -> DropdownMenuItem(text = { Text(name) }, onClick = { region = code; regionMenu = false }) }
                        }
                    }
                }
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it.take(512) },
                    label = { Text(if (canAdd) "搜索节目名称，或粘贴 RSS 地址" else "搜索节目名称") },
                    singleLine = true,
                    trailingIcon = {
                        if (query.isNotEmpty() && !busy) {
                            IconButton({ query = ""; selected = null }) {
                                Icon(Icons.Default.Close, contentDescription = "清空搜索")
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().testTag("podcast-explore-search"),
                    enabled = !busy,
                )
                if (selected == null && !isRssUrl) {
                    Text(
                        text = if (query.isBlank()) "Apple Podcasts 区域热门榜 · ${page?.regions.orEmpty().joinToString().uppercase()}" else "搜索 Apple Podcasts 公开目录",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton({ retry++ }) { Text(stringResource(R.string.retry)) } }
                    if (page?.failedRegions?.isNotEmpty() == true) Text("部分区域暂时不可用，已保留可用结果。", style = MaterialTheme.typography.bodySmall)
                    if ((page?.explicitHidden ?: 0) > 0) Text("已按管理员设置隐藏成人内容", style = MaterialTheme.typography.bodySmall)
                    LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(page?.results.orEmpty(), key = { it.feedUrl }) { item ->
                            ListItem(
                                headlineContent = { Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                                supportingContent = { Text(listOf(item.author, if (item.followed) "已关注" else if (item.explicit) "成人内容" else item.genres.joinToString(" · ")).filter { it.isNotEmpty() }.joinToString("\n"), maxLines = 2) },
                                leadingContent = {
                                    AsyncImage(
                                        model = item.artworkUrl,
                                        contentDescription = null,
                                        modifier = Modifier.size(56.dp).clip(RoundedCornerShape(10.dp)),
                                        contentScale = ContentScale.Crop,
                                    )
                                },
                                modifier = Modifier.testTag("podcast-explore-${item.itunesId}").clickable { selected = item },
                            )
                        }
                        if (!loading && error == null && page?.results?.isEmpty() == true) item { Text("暂无节目，试试其他区域或关键词。") }
                    }
                } else {
                    val titleText = preview?.title?.takeIf { it.isNotBlank() } ?: selected?.title ?: trimmedQuery
                    val feedUrlToSubscribe = activeFeedUrl.orEmpty()
                    val itunesIdToSubscribe = selected?.itunesId
                    LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        if (isRssUrl) {
                            item {
                                Text(
                                    text = "已识别为 RSS 地址，正在直接预览该订阅源",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                        item { Text(titleText, style = MaterialTheme.typography.headlineSmall) }
                        if (previewing) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                        previewError?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
                        preview?.let { value ->
                            item { Text("${value.author} · ${value.episodeCount} 集", style = MaterialTheme.typography.bodySmall) }
                            item { Text(android.text.Html.fromHtml(value.description, android.text.Html.FROM_HTML_MODE_COMPACT).toString().trim()) }
                            item { Text("最新单集", style = MaterialTheme.typography.titleMedium) }
                            items(value.latestEpisodes) { episode -> Text(episode.title) }
                        }
                    }
                    val canConfirm = !busy && !previewing && (preview != null || (isRssUrl && previewError != null)) && (canAdd || preview?.catalogPodcastId != null)
                    if (preview != null || isRssUrl) {
                        Button(
                            onClick = {
                                busy = true; previewError = null
                                scope.launch {
                                    try {
                                        val value = preview
                                        val id = value?.catalogPodcastId?.also { if (!value.followed) vm.repository.followPodcast(it, true) }
                                            ?: vm.repository.subscribePodcast(feedUrlToSubscribe, itunesIdToSubscribe).podcast.id
                                        onFollowed(id)
                                    } catch (e: CancellationException) { throw e }
                                    catch (e: Exception) { previewError = friendlyError(e) }
                                    finally { busy = false }
                                }
                            },
                            enabled = canConfirm,
                            modifier = Modifier.fillMaxWidth().testTag("podcast-explore-follow"),
                        ) {
                            val followed = preview?.followed == true
                            Text(if (busy) "正在关注…" else if (followed) "打开节目" else if (isRssUrl && preview?.catalogPodcastId == null) "添加并关注" else "关注节目")
                        }
                        if (!canAdd && preview?.catalogPodcastId == null) Text("管理员尚未开放添加节目", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
