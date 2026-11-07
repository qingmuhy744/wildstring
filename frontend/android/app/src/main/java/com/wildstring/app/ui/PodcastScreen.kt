@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.wildstring.app.R
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.text.HtmlCompat
import coil.compose.AsyncImage
import coil.request.ImageRequest
import com.wildstring.app.data.PodcastDetail
import com.wildstring.app.data.PodcastEpisode
import com.wildstring.app.data.PodcastShowQueuePreference
import com.wildstring.app.data.PodcastSummary
import com.wildstring.app.data.PodcastPublisher
import com.wildstring.app.data.EpisodeProgress
import com.wildstring.app.data.effectiveShowPreference
import com.wildstring.app.data.friendlyError
import com.wildstring.app.data.podcastPublishedMillis
import kotlinx.coroutines.launch
import kotlinx.coroutines.CancellationException

private val PRESET_FEEDS = listOf(
    "声东击西" to "https://etw.fm/rss",
    "疯投圈" to "https://crazy.capital/feed",
    "NPR News" to "https://feeds.npr.org/500005/podcast.xml",
)

private fun podcastDescription(raw: String): String =
    HtmlCompat.fromHtml(raw, HtmlCompat.FROM_HTML_MODE_COMPACT)
        .toString()
        .replace(Regex("[ \\t]+"), " ")
        .replace(Regex("\\n{3,}"), "\n\n")
        .trim()

@Composable
fun PodcastChannelPage(
    vm: MusicViewModel,
    modifier: Modifier = Modifier,
) {
    val scope = rememberCoroutineScope()
    val state by vm.state.collectAsStateWithLifecycle()
    val positions by vm.podcastProgress.positions.collectAsStateWithLifecycle()
    val browser by vm.podcastBrowser.state.collectAsStateWithLifecycle()
    val cloud by vm.podcastCloud.collectAsStateWithLifecycle()
    val owner = vm.repository.session.cacheScope()
    val podcasts = browser.podcasts.takeIf { browser.owner == owner }.orEmpty()
    val loading = browser.owner != owner || !browser.listLoaded || browser.listLoading
    val pageStates = rememberSaveableStateHolder()
    var selectedPublisherId by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedPublisherName by rememberSaveable { mutableStateOf("") }
    var publisherOriginPodcastId by rememberSaveable { mutableStateOf<String?>(null) }
    val selectedPublisher = selectedPublisherId?.let { PodcastPublisher(it, selectedPublisherName) }
    val selectedId = state.podcastId
    val closePublisher = {
        val originId = publisherOriginPodcastId
        selectedPublisherId = null
        publisherOriginPodcastId = null
        if (originId != null) vm.openPodcast(originId)
    }
    val selectedDetail = selectedId?.let(browser.details::get).takeIf { browser.owner == owner }
    val selectedPodcast = selectedId?.let { id ->
        selectedDetail?.podcast ?: podcasts.find { it.id == id }
        ?: PodcastSummary(id, state.current?.takeIf { it.podcast?.podcastId == id }?.album ?: "单集列表", feedUrl = "")
    }
    val detailLoading = browser.owner != owner || (selectedId != null &&
        (selectedId !in browser.loadedDetails || selectedId in browser.loadingDetails))
    var showSubscribeDialog by remember(owner) { mutableStateOf(false) }
    var exploring by remember(owner) { mutableStateOf(false) }
    var autoDownloadPodcast by remember(owner) { mutableStateOf<PodcastSummary?>(null) }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var followingOnly by rememberSaveable { mutableStateOf(true) }
    val canBrowseCatalog = state.account?.profile in listOf("owner", "librarian")
    val personalOnly = !canBrowseCatalog || followingOnly
    var canAddPodcast by remember(owner) { mutableStateOf(false) }
    val canEditPublisher = state.account?.profile in listOf("owner", "librarian", "editor")
    LaunchedEffect(owner, browser.listLoading) {
        try {
            val policy = vm.repository.podcastCatalogPolicy()
            if (owner == vm.repository.session.cacheScope()) canAddPodcast = policy.canAdd
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { canAddPodcast = state.account?.profile in listOf("owner", "librarian") }
    }
    BackHandler(enabled = selectedId == null && selectedPublisher != null) { closePublisher() }

    LaunchedEffect(owner, browser.listLoaded) { vm.podcastBrowser.ensureList() }
    LaunchedEffect(owner) { if (owner != null) vm.refreshPodcastCloud() }
    LaunchedEffect(cloud.notice) {
        cloud.notice?.let { statusMessage = it; vm.clearPodcastQueueNotice() }
    }
    LaunchedEffect(owner, selectedId, selectedId in browser.loadedDetails) { selectedId?.let(vm.podcastBrowser::ensureDetail) }
    LaunchedEffect(browser.message) {
        browser.message?.let { statusMessage = it; vm.podcastBrowser.clearMessage() }
    }

    Box(modifier = modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        if (selectedPodcast != null) {
            pageStates.SaveableStateProvider("detail:${selectedPodcast.id}") {
                PodcastDetailView(
                    podcast = selectedPodcast,
                    detail = selectedDetail,
                    positions = positions,
                    loading = detailLoading,
                    onBack = vm::back,
                    onRefresh = { vm.podcastBrowser.refresh(selectedPodcast.id, synchronize = false) },
                    onPlayEpisode = { ep ->
                        vm.playPodcastEpisode(ep, selectedPodcast)
                    },
                    onQueueEpisode = { ep, next ->
                        vm.addPodcastEpisodeToQueue(ep, selectedPodcast, next)
                    },
                    onAddToInbox = { ep -> vm.addPodcastEpisodeToInbox(ep) },
                    showPreference = cloud.preferences?.let { effectiveShowPreference(it, selectedPodcast.id) },
                    preferenceLoading = cloud.preferencesLoading && cloud.preferences == null,
                    preferenceError = cloud.preferencesError,
                    onShowPreference = { action, limit -> vm.updatePodcastShowPreference(selectedPodcast.id, action, limit) },
                    onRetryPreference = vm::refreshPodcastQueuePreferences,
                    onFollow = { vm.togglePodcastFollow(selectedPodcast) },
                    onAutoDownload = { autoDownloadPodcast = selectedPodcast },
                    onReadDownloads = { vm.podcastBrowser.refresh(selectedPodcast.id, synchronize = false) },
                    onSaveEpisode = { episode -> scope.launch {
                        try {
                            val result = vm.repository.savePodcastEpisode(episode.id, !episode.resourceSaved)
                            if (owner != vm.repository.session.cacheScope()) return@launch
                            val current = vm.podcastBrowser.state.value.details[episode.podcastId]
                            current?.let { detail -> vm.podcastBrowser.remember(detail.copy(episodes = detail.episodes.map { item ->
                                if (item.id == episode.id) item.copy(resourceSaved = result.saved, downloadStatus = if (result.saved) (if (result.reused) "downloaded" else "queued") else item.downloadStatus) else item
                            })) }
                            statusMessage = if (!result.saved) "已取消个人保存，共享音频由服务器按策略保留" else if (result.reused) "已复用服务器已有音频，无需重复下载" else "已保存，正在准备服务器音频"
                        } catch (e: CancellationException) { throw e }
                        catch (e: Exception) { statusMessage = friendlyError(e) }
                    } },
                    publisher = {
                        PublisherAffiliation(vm, selectedPodcast, canEditPublisher,
                            onOpen = {
                                publisherOriginPodcastId = selectedPodcast.id
                                selectedPublisherId = it.id
                                selectedPublisherName = it.name
                                vm.back()
                            },
                            onSaved = { detail ->
                                vm.podcastBrowser.remember(detail)
                                statusMessage = "出品方归属已保存"
                            })
                    },
                )
            }
        } else if (selectedPublisher != null) {
            PodcastPublisherPage(
                vm = vm,
                publisher = selectedPublisher,
                onBack = closePublisher,
                onSelect = {
                    if (it.id == publisherOriginPodcastId) {
                        selectedPublisherId = null
                        publisherOriginPodcastId = null
                    }
                    vm.openPodcast(it.id)
                },
                personalOnly = personalOnly,
            )
        } else {
            pageStates.SaveableStateProvider("list") {
                PodcastListView(
                    podcasts = if (personalOnly) podcasts.filter { it.followed } else podcasts,
                    followingOnly = personalOnly,
                    canBrowseCatalog = canBrowseCatalog,
                    onScope = { followingOnly = it; if (!it) vm.podcastBrowser.reloadList(synchronize = false) },
                    canManage = false,
                    canAdd = canAddPodcast,
                    onFollow = vm::togglePodcastFollow,
                    onAutoDownload = { autoDownloadPodcast = it },
                    loading = loading,
                    onSelect = { vm.openPodcast(it.id) },
                    onAddClick = { exploring = true },
                    onExplore = { exploring = true },
                    onRefreshAll = {
                        vm.podcastBrowser.reloadList(synchronize = false)
                        vm.refreshPodcastCloud()
                    },
                    queueHeader = {
                        PodcastCloudLists(
                            cloud = cloud,
                            autoContinue = cloud.preferences?.autoContinue ?: vm.settings.podcastContinuePreference().autoContinue,
                            onRetry = vm::retryPodcastQueueSync,
                            onBrowse = { exploring = true },
                            onPlay = { episodeId ->
                                scope.launch {
                                    try {
                                        val episode = vm.repository.podcastEpisode(episodeId)
                                        val detail = vm.repository.podcastDetail(episode.podcastId)
                                        vm.playPodcastEpisode(episode, detail.podcast)
                                    } catch (e: CancellationException) { throw e }
                                    catch (e: Exception) { statusMessage = friendlyError(e) }
                                }
                            },
                            onQueueInbox = vm::movePodcastInboxToQueue,
                            onRemoveInbox = vm::removePodcastInboxEpisode,
                            onRemoveQueue = vm::removePodcastQueueEpisode,
                        )
                    },
                    onDelete = { p ->
                        scope.launch {
                            try {
                                vm.repository.deletePodcast(p.id)
                                if (owner == vm.repository.session.cacheScope()) vm.podcastBrowser.remove(p.id)
                                statusMessage = "已从本服删除节目: ${p.title}"
                            } catch (e: CancellationException) { throw e }
                            catch (e: Exception) {
                                statusMessage = "删除节目失败: ${e.message}"
                            }
                        }
                    },
                )
            }
        }

        autoDownloadPodcast?.let { podcast ->
            PodcastDownloadSettingsDialog(vm, podcast, onDismiss = { autoDownloadPodcast = null }, onSaved = {
                vm.podcastBrowser.refresh(podcast.id, synchronize = false)
                statusMessage = "已保存你的自动下载设置"
            })
        }
        if (exploring) key(owner) {
            PodcastExploreDialog(vm, canAddPodcast, onDismiss = { exploring = false }) { id ->
                exploring = false
                vm.podcastBrowser.reloadList(synchronize = false)
                vm.openPodcast(id)
            }
        }
        if (showSubscribeDialog) {
            SubscribePodcastDialog(
                onDismiss = { showSubscribeDialog = false },
                onConfirm = { url ->
                    showSubscribeDialog = false
                    scope.launch {
                        try {
                            val detail = vm.repository.subscribePodcast(url)
                            if (owner != vm.repository.session.cacheScope()) return@launch
                            vm.podcastBrowser.remember(detail)
                            vm.openPodcast(detail.podcast.id)
                            statusMessage = "已添加并关注: ${detail.podcast.title}"
                        } catch (e: CancellationException) { throw e }
                        catch (e: Exception) {
                            statusMessage = "订阅失败: ${e.message}"
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
private fun PodcastCloudLists(
    cloud: PodcastCloudState,
    autoContinue: Boolean,
    onRetry: () -> Unit,
    onBrowse: () -> Unit,
    onPlay: (String) -> Unit,
    onQueueInbox: (String) -> Unit,
    onRemoveInbox: (String) -> Unit,
    onRemoveQueue: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp)) {
        cloud.syncError?.let { message ->
            PodcastStatusCard(message, onRetry, stringResource(R.string.podcast_sync_retry), tag = "podcast-sync-error")
        }
        PodcastQueueBlock(
            title = stringResource(R.string.podcast_inbox_title),
            loading = cloud.inboxLoading,
            error = cloud.inboxError,
            empty = stringResource(R.string.podcast_inbox_empty),
            rows = cloud.inboxRows,
            onRetry = onRetry,
            tag = "podcast-inbox",
            emptyAction = stringResource(R.string.podcast_browse_shows),
            onEmptyAction = onBrowse,
            onPlay = onPlay,
            secondary = stringResource(R.string.podcast_add_queue) to onQueueInbox,
            onRemove = onRemoveInbox,
        )
        PodcastQueueBlock(
            title = stringResource(R.string.podcast_queue_title),
            loading = cloud.queueLoading,
            error = cloud.queueError,
            empty = stringResource(if (autoContinue) R.string.podcast_queue_empty_on else R.string.podcast_queue_empty_off),
            rows = cloud.queueRows,
            onRetry = onRetry,
            tag = "podcast-queue",
            onPlay = onPlay,
            secondary = null,
            onRemove = onRemoveQueue,
        )
    }
}

@Composable
private fun PodcastQueueBlock(
    title: String,
    loading: Boolean,
    error: String?,
    empty: String,
    rows: List<PodcastQueueRow>,
    onRetry: () -> Unit,
    tag: String,
    emptyAction: String? = null,
    onEmptyAction: () -> Unit = {},
    onPlay: (String) -> Unit,
    secondary: Pair<String, (String) -> Unit>?,
    onRemove: (String) -> Unit,
) {
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        when {
            loading -> repeat(2) {
                Box(
                    Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(12.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh),
                )
            }
            error != null -> PodcastStatusCard(error, onRetry, stringResource(R.string.podcast_sync_retry), tag = "$tag-error")
            rows.isEmpty() -> Column {
                Text(empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (emptyAction != null) TextButton(onEmptyAction) { Text(emptyAction) }
            }
            else -> rows.forEach { row ->
                Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            if (row.unavailable) stringResource(R.string.podcast_episode_unavailable) else row.title.ifBlank { row.episodeId },
                            style = MaterialTheme.typography.bodyMedium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (row.showTitle.isNotBlank()) Text(row.showTitle, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (!row.unavailable) TextButton({ onPlay(row.episodeId) }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(stringResource(R.string.podcast_play)) }
                            secondary?.let { (label, action) ->
                                TextButton({ action(row.episodeId) }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(label, maxLines = 1) }
                            }
                            TextButton({ onRemove(row.episodeId) }, contentPadding = PaddingValues(horizontal = 8.dp)) { Text(stringResource(R.string.podcast_remove)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun PodcastStatusCard(message: String, onAction: () -> Unit, action: String, tag: String) {
    Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth().testTag(tag)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            TextButton(onAction) { Text(action) }
        }
    }
}

@Composable
private fun PodcastShowPreferenceSection(
    preference: PodcastShowQueuePreference?,
    loading: Boolean,
    error: String?,
    onChange: (String, Int) -> Unit,
    onRetry: () -> Unit,
) {
    val current = preference ?: PodcastShowQueuePreference()
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("podcast-new-episode"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.podcast_new_episode_action), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        when {
            loading -> Box(Modifier.fillMaxWidth().height(36.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh))
            error != null && preference == null -> PodcastStatusCard(error, onRetry, stringResource(R.string.podcast_sync_retry), tag = "podcast-pref-error")
            else -> {
                if (error != null) PodcastStatusCard(error, onRetry, stringResource(R.string.podcast_sync_retry), tag = "podcast-pref-error")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(
                        "inbox" to R.string.podcast_action_inbox,
                        "queue_last" to R.string.podcast_action_queue_last,
                        "queue_next" to R.string.podcast_action_queue_next,
                        "ignore" to R.string.podcast_action_ignore,
                    ).forEach { (action, label) ->
                        FilterChip(selected = current.action == action, onClick = { onChange(action, current.autoLimit) }, label = { Text(stringResource(label), maxLines = 1) })
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(stringResource(R.string.podcast_auto_limit), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    IconButton({ onChange(current.action, (current.autoLimit - 1).coerceAtLeast(0)) }, enabled = current.autoLimit > 0) { Icon(Icons.Default.Remove, contentDescription = null) }
                    Text(stringResource(R.string.podcast_auto_limit_value, current.autoLimit), style = MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"))
                    IconButton({ onChange(current.action, (current.autoLimit + 1).coerceAtMost(100)) }) { Icon(Icons.Default.Add, contentDescription = null) }
                }
            }
        }
    }
}

@Composable
private fun PodcastRefreshBox(loading: Boolean, onRefresh: () -> Unit, tag: String,
    actionLabel: String, content: @Composable BoxScope.() -> Unit) {
    val refresh = rememberPullToRefreshState()
    var manualRefresh by remember { mutableStateOf(false) }
    LaunchedEffect(loading) {
        if (!loading) manualRefresh = false
    }
    val showIndicator = manualRefresh && loading
    PullToRefreshBox(isRefreshing = showIndicator,
        onRefresh = { if (!loading) { manualRefresh = true; onRefresh() } }, state = refresh,
        modifier = Modifier.fillMaxSize().testTag(tag).semantics {
            customActions = listOf(CustomAccessibilityAction(actionLabel) {
                if (loading) false else { manualRefresh = true; onRefresh(); true }
            })
        },
        indicator = { WildRefreshIndicator(showIndicator, refresh, Modifier.align(Alignment.TopCenter)) },
        content = content)
}

@Composable
private fun PodcastListView(
    podcasts: List<PodcastSummary>,
    followingOnly: Boolean,
    canBrowseCatalog: Boolean,
    onScope: (Boolean) -> Unit,
    canManage: Boolean,
    canAdd: Boolean,
    onFollow: (PodcastSummary) -> Unit,
    onAutoDownload: (PodcastSummary) -> Unit,
    loading: Boolean,
    onSelect: (PodcastSummary) -> Unit,
    onAddClick: () -> Unit,
    onExplore: () -> Unit,
    onRefreshAll: () -> Unit,
    onDelete: (PodcastSummary) -> Unit,
    queueHeader: @Composable () -> Unit = {},
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f, fill = false),
            ) {
                FilterChip(
                    selected = followingOnly,
                    onClick = { onScope(true) },
                    label = { Text("我的关注", maxLines = 1, softWrap = false) },
                )
                if (canBrowseCatalog) {
                    FilterChip(
                        selected = !followingOnly,
                        onClick = { onScope(false) },
                        label = { Text("本服节目", maxLines = 1, softWrap = false) },
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
            FilledTonalButton(
                onClick = onExplore,
                modifier = Modifier.testTag("podcast-open-explore"),
                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                shape = RoundedCornerShape(20.dp),
            ) {
                Icon(
                    if (canAdd) Icons.Default.Add else Icons.Default.Search,
                    contentDescription = null,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(4.dp))
                Text(
                    text = if (canAdd) "探索与添加" else "探索",
                    fontSize = 13.sp,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
        PodcastRefreshBox(loading, onRefreshAll, "podcast-list-refresh", "刷新播客订阅") {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                val columns = if (maxWidth >= 720.dp) 2 else 1
                val rows = remember(podcasts, columns) { podcasts.chunked(columns) }
                LazyColumn(
                    modifier = Modifier.fillMaxSize().testTag("podcast-list"),
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp, top = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    item { queueHeader() }
                    if (podcasts.isEmpty() && !loading) item {
                        Box(Modifier.fillParentMaxSize()) {
                            if (followingOnly) Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("还没有关注的节目")
                                TextButton(onExplore) { Text(if (canAdd) "探索或添加节目" else "探索热门播客") }
                                if (canBrowseCatalog) TextButton({ onScope(false) }) { Text("浏览本服节目") }
                            } else EmptyPodcastState(canAdd = canAdd, onPresetSelect = onAddClick)
                        }
                    }
                    items(rows, key = { row -> row.first().id }) { row ->
                        if (columns == 1) {
                            val podcast = row.first()
                            PodcastCardItem(
                                podcast = podcast,
                                onClick = { onSelect(podcast) },
                                onDelete = { onDelete(podcast) },
                                onFollow = { onFollow(podcast) },
                                onAutoDownload = { onAutoDownload(podcast) },
                                canManage = canManage,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        } else {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                row.forEach { podcast ->
                                    PodcastCardItem(
                                        podcast = podcast,
                                        onClick = { onSelect(podcast) },
                                        onDelete = { onDelete(podcast) },
                                        onFollow = { onFollow(podcast) },
                                        onAutoDownload = { onAutoDownload(podcast) },
                                        canManage = canManage,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                                if (row.size < columns) {
                                    Spacer(Modifier.weight((columns - row.size).toFloat()))
                                }
                            }
                        }
                    }
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
    onFollow: () -> Unit,
    onAutoDownload: () -> Unit,
    canManage: Boolean,
    modifier: Modifier = Modifier,
) {
    var showMenu by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }

    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = modifier.clickable(onClick = onClick),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(64.dp)
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
                        modifier = Modifier.size(30.dp),
                    )
                }
            }

            Spacer(Modifier.width(14.dp))

            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = podcast.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Text(
                    text = podcast.author.ifBlank { "未知播客主" },
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    modifier = Modifier.padding(top = 2.dp),
                ) {
                    Text(
                        text = "${podcast.totalEpisodes} 集",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (podcast.unplayedEpisodes > 0) {
                        Surface(
                            shape = RoundedCornerShape(6.dp),
                            color = MaterialTheme.colorScheme.primary.copy(alpha = 0.14f),
                        ) {
                            Text(
                                text = "${podcast.unplayedEpisodes} 未听",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp),
                            )
                        }
                    }
                }
            }

            Spacer(Modifier.width(8.dp))

            if (!podcast.followed) {
                FilledTonalButton(
                    onClick = onFollow,
                    shape = RoundedCornerShape(18.dp),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
                    modifier = Modifier.height(34.dp),
                ) {
                    Text("关注", fontSize = 12.sp, maxLines = 1, softWrap = false)
                }
            }

            if (podcast.followed || canManage) {
                Box {
                    IconButton(
                        onClick = { showMenu = true },
                        modifier = Modifier.size(36.dp),
                    ) {
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
                        if (podcast.followed) {
                            DropdownMenuItem(
                                text = { Text("自动下载设置") },
                                onClick = {
                                    showMenu = false
                                    onAutoDownload()
                                },
                                leadingIcon = {
                                    Icon(Icons.Default.Download, contentDescription = null)
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("取消关注") },
                                onClick = {
                                    showMenu = false
                                    onFollow()
                                },
                                leadingIcon = {
                                    Icon(Icons.Default.RemoveCircleOutline, contentDescription = null)
                                },
                            )
                        }
                        if (canManage) {
                            DropdownMenuItem(
                                text = { Text("删除共享节目", color = MaterialTheme.colorScheme.error) },
                                onClick = {
                                    showMenu = false
                                    deleting = true
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
    }
    if (deleting) AlertDialog(onDismissRequest = { deleting = false }, title = { Text("从本服删除节目？") },
        text = { Text("删除《${podcast.title}》会移除所有用户的关注和收听记录。仅取消自己的关注，请使用“取消关注”。") },
        confirmButton = { TextButton({ deleting = false; onDelete() }) { Text("删除共享节目") } },
        dismissButton = { TextButton({ deleting = false }) { Text("保留节目") } })
}

@Composable
private fun EmptyPodcastState(
    canAdd: Boolean,
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
            text = "本服暂无节目",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = if (canAdd) "添加 RSS 节目后，所有用户可分别关注\n服务端会统一获取最新单集" else "节目管理员添加节目后\n即可浏览并关注感兴趣的节目",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        if (canAdd) Button(
            onClick = onPresetSelect,
            shape = RoundedCornerShape(20.dp),
        ) {
            Icon(Icons.Default.Add, contentDescription = null)
            Spacer(Modifier.width(6.dp))
            Text("添加节目")
        }
    }
}

@Composable
private fun PodcastDetailView(
    podcast: PodcastSummary,
    detail: PodcastDetail?,
    positions: Map<String, EpisodeProgress>,
    loading: Boolean,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onPlayEpisode: (PodcastEpisode) -> Unit,
    onQueueEpisode: (PodcastEpisode, Boolean) -> Unit,
    onAddToInbox: (PodcastEpisode) -> Unit = {},
    showPreference: PodcastShowQueuePreference? = null,
    preferenceLoading: Boolean = false,
    preferenceError: String? = null,
    onShowPreference: (String, Int) -> Unit = { _, _ -> },
    onRetryPreference: () -> Unit = {},
    onSaveEpisode: (PodcastEpisode) -> Unit,
    onFollow: () -> Unit,
    onAutoDownload: () -> Unit,
    onReadDownloads: () -> Unit,
    publisher: @Composable () -> Unit,
) {
    var episodeScope by rememberSaveable(podcast.id) { mutableStateOf("all") }
    var sortDescending by rememberSaveable(podcast.id) { mutableStateOf(true) }
    var showDescription by remember(podcast.id) { mutableStateOf(false) }

    val sortedEpisodes = remember(detail?.episodes, sortDescending, episodeScope) {
        val list = detail?.episodes.orEmpty().filter {
            when (episodeScope) {
                "saved" -> it.resourceSaved || it.resourceAutomatic || it.resourcePlaybackCached
                "downloaded" -> it.downloadStatus == "downloaded"
                else -> true
            }
        }
        val parseNum = { ep: PodcastEpisode ->
            if (ep.episodeNumber != null) ep.episodeNumber
            else {
                val match = Regex("""#(\d+)|第\s*(\d+)\s*期""").find(ep.title)
                match?.groupValues?.getOrNull(1)?.toIntOrNull()
                    ?: match?.groupValues?.getOrNull(2)?.toIntOrNull()
                    ?: 0
            }
        }
        val keys = list.associate { it.id to (podcastPublishedMillis(it.pubDate) to parseNum(it)) }
        val comparator = compareBy<PodcastEpisode> { keys.getValue(it.id).first }.thenBy { keys.getValue(it.id).second }
        list.sortedWith(if (sortDescending) comparator.reversed() else comparator)
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
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
        }

        PodcastRefreshBox(loading, onRefresh, "podcast-detail-refresh", "刷新单集列表") {
            LazyColumn(
                modifier = Modifier.fillMaxSize().testTag("podcast-episodes"),
                contentPadding = PaddingValues(bottom = 96.dp),
            ) {
                item {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.Top,
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(96.dp)
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
                                        modifier = Modifier.size(44.dp),
                                    )
                                }
                            }

                            Spacer(Modifier.width(16.dp))

                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                Text(
                                    text = podcast.title,
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = podcast.author.ifBlank { "未知创作者" },
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                publisher()
                                val episodeTotal = podcast.totalEpisodes.coerceAtLeast(detail?.episodes?.size ?: 0)
                                if (episodeTotal > 0 || podcast.unplayedEpisodes > 0) {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                                        modifier = Modifier.padding(top = 2.dp),
                                    ) {
                                        Surface(
                                            shape = RoundedCornerShape(6.dp),
                                            color = MaterialTheme.colorScheme.secondaryContainer,
                                        ) {
                                            Text(
                                                text = "共 $episodeTotal 集",
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                            )
                                        }
                                        if (podcast.unplayedEpisodes > 0) {
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
                            }
                        }

                        Spacer(Modifier.height(14.dp))

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            FilledTonalButton(
                                onClick = onFollow,
                                shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                                modifier = Modifier.height(36.dp),
                            ) {
                                Text(if (podcast.followed) "取消关注" else "关注节目", fontSize = 13.sp)
                            }
                            if (podcast.followed) {
                                OutlinedButton(
                                    onClick = onAutoDownload,
                                    shape = RoundedCornerShape(10.dp),
                                    contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                                    modifier = Modifier.height(36.dp),
                                ) {
                                    Text("自动下载", fontSize = 13.sp)
                                }
                            }
                            OutlinedButton(
                                onClick = { showDescription = true },
                                shape = RoundedCornerShape(10.dp),
                                contentPadding = PaddingValues(horizontal = 14.dp, vertical = 6.dp),
                                modifier = Modifier.height(36.dp),
                            ) {
                                Text("节目介绍", fontSize = 13.sp)
                            }
                        }

                        Spacer(Modifier.height(12.dp))

                        Surface(
                            shape = RoundedCornerShape(12.dp),
                            color = MaterialTheme.colorScheme.surfaceContainerLow,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { showDescription = true },
                        ) {
                            Text(
                                text = podcastDescription(podcast.description).ifBlank { "暂无简介" },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 3,
                                overflow = TextOverflow.Ellipsis,
                                lineHeight = 18.sp,
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
                            )
                        }
                    }
                    PodcastShowPreferenceSection(
                        preference = showPreference,
                        loading = preferenceLoading,
                        error = preferenceError,
                        onChange = onShowPreference,
                        onRetry = onRetryPreference,
                    )
                    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(episodeScope == "saved", { episodeScope = "saved"; onReadDownloads() }, label = { Text("我的下载") })
                        FilterChip(episodeScope == "downloaded", { episodeScope = "downloaded" }, label = { Text("服务器已有") })
                        FilterChip(episodeScope == "all", { episodeScope = "all" }, label = { Text("全部单集") })
                    }
                    if (episodeScope == "saved") Text("包含你的手动下载、自动下载和播放缓存。播放缓存可按服务器清理规则回收。",
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                            Text("正在加载单集…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } else if (sortedEpisodes.isEmpty() && !loading) {
                    item {
                        Box(Modifier.fillMaxWidth().padding(48.dp), contentAlignment = Alignment.Center) {
                            Text(when (episodeScope) {
                                "saved" -> "还没有你的下载，播放时缓存或选择保存后会显示在这里"
                                "downloaded" -> "服务器还没有已下载单集"
                                else -> "暂无单集"
                            }, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                } else {
                    items(sortedEpisodes, key = { it.id }) { episode ->
                        val ep = positions[episode.id]?.let { progress ->
                            episode.copy(positionSeconds = progress.positionSeconds.toInt(), completed = progress.completed)
                        } ?: episode
                        EpisodeRowItem(
                            episode = ep,
                            onPlay = { onPlayEpisode(ep) },
                            onPlayNext = { onQueueEpisode(ep, true) },
                            onAddToQueue = { onQueueEpisode(ep, false) },
                            onAddToInbox = { onAddToInbox(ep) },
                            onSave = { onSaveEpisode(ep) },
                        )
                    }
                }
            }
        }
    }
    if (showDescription) AlertDialog(onDismissRequest = { showDescription = false },
        title = { Text(podcast.title) },
        text = { Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
            PodcastArticleText(podcast.description.ifBlank { "暂无节目介绍" }, Modifier.fillMaxWidth())
        } },
        confirmButton = { TextButton({ showDescription = false }) { Text("关闭") } })
}

@Composable
private fun EpisodeRowItem(
    episode: PodcastEpisode,
    onPlay: () -> Unit,
    onPlayNext: () -> Unit,
    onAddToQueue: () -> Unit,
    onAddToInbox: () -> Unit = {},
    onSave: () -> Unit,
) {
    var details by remember(episode.id) { mutableStateOf(false) }
    var showMenu by remember(episode.id) { mutableStateOf(false) }
    val feedback = LocalTactileFeedback.current
    val durationText = formatDuration(episode.durationSeconds)

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .testTag("podcast-episode-${episode.id}")
            .combinedClickable(onClick = { details = true }, onLongClick = { showMenu = true }, onLongClickLabel = "单集操作")
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
                    if (episode.resourceSaved || episode.resourceAutomatic) { Spacer(Modifier.width(8.dp)); Text(if (episode.resourceSaved) "已保存" else "自动保存", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
                    else if (episode.resourcePlaybackCached) { Spacer(Modifier.width(8.dp)); Text("播放缓存", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    if (episode.completed) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = "已听完",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                }
                if (!episode.completed && episode.positionSeconds > 0) {
                    Text(text = "已听至 ${episode.positionSeconds / 60}:${(episode.positionSeconds % 60).toString().padStart(2, '0')}",
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 4.dp))
                }
            }
            Box {
                IconButton(onClick = { showMenu = true }, modifier = Modifier.testTag("podcast-episode-actions-${episode.id}")) {
                    Icon(Icons.Default.MoreVert, contentDescription = "单集操作：${episode.title}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.podcast_play_next)) },
                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.PlaylistPlay, null) },
                        onClick = { showMenu = false; feedback(TactileKind.Tap); onPlayNext() },
                        modifier = Modifier.testTag("podcast-episode-play-next-${episode.id}"),
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.podcast_add_queue)) },
                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.QueueMusic, null) },
                        onClick = { showMenu = false; feedback(TactileKind.Tap); onAddToQueue() },
                        modifier = Modifier.testTag("podcast-episode-enqueue-${episode.id}"),
                    )
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.podcast_add_inbox)) },
                        leadingIcon = { Icon(Icons.Default.Inbox, null) },
                        onClick = { showMenu = false; feedback(TactileKind.Tap); onAddToInbox() },
                        modifier = Modifier.testTag("podcast-episode-inbox-${episode.id}"),
                    )
                    DropdownMenuItem(
                        text = { Text(if (episode.resourceSaved) "取消个人保存" else "保存到服务器") },
                        leadingIcon = { Icon(if (episode.resourceSaved) Icons.Default.BookmarkRemove else Icons.Default.BookmarkAdd, null) },
                        onClick = { showMenu = false; onSave() },
                        modifier = Modifier.testTag("podcast-episode-save-${episode.id}"),
                    )
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("单集详情") },
                        leadingIcon = { Icon(Icons.Default.Info, null) },
                        onClick = { showMenu = false; details = true },
                    )
                }
            }
        }
    }
    if (details) {
        AlertDialog(
            onDismissRequest = { details = false },
            title = { Text(episode.title) },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    PodcastArticleText(episode.description.ifBlank { "暂无单集简介" }, Modifier.fillMaxWidth())
                    if (episode.pubDate.isNotBlank()) Text("发布时间：${episode.pubDate}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (durationText.isNotBlank()) Text("时长：$durationText", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            },
            confirmButton = { Button(onClick = { details = false; onPlay() }) { Text("播放单集") } },
            dismissButton = { TextButton(onClick = { details = false }) { Text("关闭") } },
        )
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
        title = { Text("添加 RSS 并关注") },
        text = {
            Column {
                Text("输入节目 RSS 地址即可关注。已有节目会直接复用，你的关注和收听进度单独保存。", style = MaterialTheme.typography.bodySmall)
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
