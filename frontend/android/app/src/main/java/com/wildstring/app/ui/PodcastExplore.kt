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
    val regions = listOf(
        "" to stringResource(R.string.pod_exp_region_default),
        "tw" to stringResource(R.string.pod_exp_region_tw),
        "cn" to stringResource(R.string.pod_exp_region_cn),
        "hk" to stringResource(R.string.pod_exp_region_hk),
        "us" to stringResource(R.string.pod_exp_region_us),
        "jp" to stringResource(R.string.pod_exp_region_jp),
        "gb" to stringResource(R.string.pod_exp_region_gb),
    )
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
                        Icon(if (selected != null) Icons.AutoMirrored.Filled.ArrowBack else Icons.Default.Close, if (selected != null) stringResource(R.string.pod_exp_back_to_list) else stringResource(R.string.pod_exp_close_explore))
                    }
                    Text(
                        text = if (canAdd) stringResource(R.string.pod_exp_title_add) else stringResource(R.string.pod_exp_title),
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
                    label = { Text(if (canAdd) stringResource(R.string.pod_exp_search_label_rss) else stringResource(R.string.pod_exp_search_label)) },
                    singleLine = true,
                    trailingIcon = {
                        if (query.isNotEmpty() && !busy) {
                            IconButton({ query = ""; selected = null }) {
                                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.pod_exp_clear_search))
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth().testTag("podcast-explore-search"),
                    enabled = !busy,
                )
                if (selected == null && !isRssUrl) {
                    Text(
                        text = if (query.isBlank()) stringResource(R.string.pod_exp_hot_ranking, page?.regions.orEmpty().joinToString().uppercase()) else stringResource(R.string.pod_exp_search_apple),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton({ retry++ }) { Text(stringResource(R.string.retry)) } }
                    if (page?.failedRegions?.isNotEmpty() == true) Text(stringResource(R.string.pod_exp_partial_regions_failed), style = MaterialTheme.typography.bodySmall)
                    if ((page?.explicitHidden ?: 0) > 0) Text(stringResource(R.string.pod_exp_explicit_hidden), style = MaterialTheme.typography.bodySmall)
                    val followedBadge = stringResource(R.string.pod_exp_followed)
                    val explicitBadge = stringResource(R.string.pod_exp_explicit)
                    LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(page?.results.orEmpty(), key = { it.feedUrl }) { item ->
                            ListItem(
                                headlineContent = { Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                                supportingContent = { Text(listOf(item.author, if (item.followed) followedBadge else if (item.explicit) explicitBadge else item.genres.joinToString(" · ")).filter { it.isNotEmpty() }.joinToString("\n"), maxLines = 2) },
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
                        if (!loading && error == null && page?.results?.isEmpty() == true) item { Text(stringResource(R.string.pod_exp_no_results)) }
                    }
                } else {
                    val titleText = preview?.title?.takeIf { it.isNotBlank() } ?: selected?.title ?: trimmedQuery
                    val feedUrlToSubscribe = activeFeedUrl.orEmpty()
                    val itunesIdToSubscribe = selected?.itunesId
                    LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        if (isRssUrl) {
                            item {
                                Text(
                                    text = stringResource(R.string.pod_exp_rss_previewing),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                        item { Text(titleText, style = MaterialTheme.typography.headlineSmall) }
                        if (previewing) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                        previewError?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error) } }
                        preview?.let { value ->
                            item { Text(stringResource(R.string.pod_exp_author_episodes, value.author, value.episodeCount), style = MaterialTheme.typography.bodySmall) }
                            item { Text(android.text.Html.fromHtml(value.description, android.text.Html.FROM_HTML_MODE_COMPACT).toString().trim()) }
                            item { Text(stringResource(R.string.pod_exp_latest_episodes), style = MaterialTheme.typography.titleMedium) }
                            items(value.latestEpisodes) { episode -> Text(episode.title) }
                        }
                    }
                    val canConfirm = !busy && !previewing && (preview != null || (isRssUrl && previewError != null)) && (canAdd || preview?.catalogPodcastId != null)
                    if (preview != null || isRssUrl) {
                        val followingText = stringResource(R.string.pod_exp_following)
                        val openShowText = stringResource(R.string.pod_exp_open_show)
                        val addFollowText = stringResource(R.string.pod_exp_add_and_follow)
                        val followText = stringResource(R.string.pod_exp_follow_show)
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
                            Text(if (busy) followingText else if (followed) openShowText else if (isRssUrl && preview?.catalogPodcastId == null) addFollowText else followText)
                        }
                        if (!canAdd && preview?.catalogPodcastId == null) Text(stringResource(R.string.pod_exp_cannot_add_hint), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}
