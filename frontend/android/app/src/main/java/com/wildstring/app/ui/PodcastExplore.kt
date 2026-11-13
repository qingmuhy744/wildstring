package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import coil.request.ImageRequest
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
    val resultScroll = rememberLazyListState()
    val previewScroll = rememberLazyListState()
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
        previewScroll.scrollToItem(0)
        val feedUrl = activeFeedUrl ?: return@LaunchedEffect
        if (isRssUrl) delay(350)
        previewing = true
        try { preview = vm.repository.previewPodcast(feedUrl) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { previewError = friendlyError(e) }
        finally { previewing = false }
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = androidx.compose.ui.platform.LocalView.current
        val darkBars = LocalDarkAppearance.current
        LaunchedEffect(view, darkBars) {
            (view.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.let { window ->
                androidx.core.view.WindowCompat.enableEdgeToEdge(window)
                if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
                androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !darkBars
                    isAppearanceLightNavigationBars = !darkBars
                }
            }
        }
        Surface(Modifier.fillMaxSize().testTag("podcast-explore")) {
            BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(16.dp)) {
                val wide = LocalAndroidLayoutMode.current == AndroidLayoutMode.Pad && maxWidth >= 720.dp
                BackHandler(selected != null && !wide) { selected = null }
                LaunchedEffect(wide, page, isRssUrl) {
                    if (wide && !isRssUrl && selected == null) selected = page?.results?.firstOrNull()
                }
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton({ if (selected != null && !wide) selected = null else onDismiss() }) {
                            Icon(if (selected != null && !wide) Icons.AutoMirrored.Filled.ArrowBack else Icons.Default.Close, if (selected != null && !wide) stringResource(R.string.pod_exp_back_to_list) else stringResource(R.string.pod_exp_close_explore))
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
                        shape = RoundedCornerShape(10.dp),
                        colors = OutlinedTextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest, focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest, unfocusedBorderColor = androidx.compose.ui.graphics.Color.Transparent),
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
                    val regionLabel = regions.first { it.first == region }.second
                    val rankingLabel = page?.regions.orEmpty().map { code ->
                        regions.firstOrNull { it.first.equals(code, ignoreCase = true) }?.second ?: code.uppercase()
                    }.joinToString(" · ")
                    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
                        if ((selected == null || wide) && !isRssUrl) {
                            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text(
                                    text = if (query.isBlank()) {
                                        val suffix = rankingLabel.ifBlank { regionLabel }
                                        if (suffix.isBlank()) stringResource(R.string.pod_exp_hot_ranking_plain)
                                        else stringResource(R.string.pod_exp_hot_ranking, suffix)
                                    } else stringResource(R.string.pod_exp_search_apple),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                error?.let { Text(it, color = MaterialTheme.colorScheme.error); TextButton({ retry++ }) { Text(stringResource(R.string.retry)) } }
                                if (page?.failedRegions?.isNotEmpty() == true) Text(stringResource(R.string.pod_exp_partial_regions_failed), style = MaterialTheme.typography.bodySmall)
                                if ((page?.explicitHidden ?: 0) > 0) Text(stringResource(R.string.pod_exp_explicit_hidden), style = MaterialTheme.typography.bodySmall)
                                val followedBadge = stringResource(R.string.pod_exp_followed)
                                val explicitBadge = stringResource(R.string.pod_exp_explicit)
                                LazyColumn(
                                    state = resultScroll,
                                    modifier = Modifier.weight(1f).testTag("podcast-explore-results"),
                                    verticalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    items(page?.results.orEmpty(), key = { it.feedUrl }) { item ->
                                        ListItem(
                                            headlineContent = { Text(item.title, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                                            supportingContent = { Text(listOf(item.author, if (item.followed) followedBadge else if (item.explicit) explicitBadge else item.genres.joinToString(" · ")).filter { it.isNotEmpty() }.joinToString("\n"), maxLines = 2) },
                                            leadingContent = { PodcastDirectoryArtwork(vm, item, Modifier.size(56.dp)) },
                                            colors = ListItemDefaults.colors(containerColor = if (selected?.feedUrl == item.feedUrl) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerLow),
                                            modifier = Modifier.clip(RoundedCornerShape(12.dp)).testTag("podcast-explore-${item.itunesId}")
                                                .selectable(selected = selected?.feedUrl == item.feedUrl, enabled = !busy, role = Role.Button) { selected = item },
                                        )
                                    }
                                    if (loading) item { PodcastExploreResultsSkeleton() }
                                    if (!loading && error == null && page?.results?.isEmpty() == true) item { Text(stringResource(R.string.pod_exp_no_results)) }
                                }
                            }
                        }
                        if (selected != null || isRssUrl || wide) {
                            Box(Modifier.weight(1f).fillMaxHeight(), contentAlignment = Alignment.TopCenter) {
                                Column(Modifier.widthIn(max = 760.dp).fillMaxSize().testTag("podcast-explore-preview"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    if (selected == null && !isRssUrl) {
                                        Text(
                                            stringResource(R.string.podcast_select_show),
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                        if (loading) PodcastExplorePreviewSkeleton()
                                    } else {
                                        val titleText = preview?.title?.takeIf { it.isNotBlank() } ?: selected?.title ?: trimmedQuery
                                        val feedUrlToSubscribe = activeFeedUrl.orEmpty()
                                        val itunesIdToSubscribe = selected?.itunesId
                                        LazyColumn(Modifier.weight(1f, fill = !wide), state = previewScroll, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                            if (isRssUrl) {
                                                item {
                                                    Text(
                                                        text = stringResource(R.string.pod_exp_rss_previewing),
                                                        style = MaterialTheme.typography.bodySmall,
                                                        color = MaterialTheme.colorScheme.primary,
                                                    )
                                                }
                                            }
                                            item {
                                                Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                                                    selected?.let { PodcastDirectoryArtwork(vm, it, Modifier.size(92.dp)) }
                                                    Text(titleText, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.weight(1f))
                                                }
                                            }
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
                }
            }
        }
    }
}

@Composable private fun PodcastDirectoryArtwork(vm: MusicViewModel, item: PodcastDirectoryResult, modifier: Modifier) {
    val profile by vm.repository.session.profiles.collectAsStateWithLifecycle()
    Box(modifier.clip(RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
        Icon(Icons.Default.Podcasts, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        vm.repository.podcastDirectoryArtwork(item)?.let { artwork ->
            AsyncImage(
                model = ImageRequest.Builder(LocalContext.current).data(artwork)
                    .memoryCacheKey("$profile:podcast-directory:$artwork:${item.artworkUrl}").build(),
                imageLoader = vm.imageLoader,
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        }
    }
}
