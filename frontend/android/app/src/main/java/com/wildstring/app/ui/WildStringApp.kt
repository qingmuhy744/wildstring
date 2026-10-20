@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import coil.request.ImageRequest
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.delay
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.activity.compose.LocalActivity
import androidx.core.view.WindowCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import com.google.gson.JsonObject
import coil.compose.AsyncImage
import com.wildstring.app.BuildConfig
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.launch
import kotlin.math.abs

private val Accent: Color @Composable get() = MaterialTheme.colorScheme.primary
private val Background: Color @Composable get() = MaterialTheme.colorScheme.background
private val Muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant

/** Horizontal track navigation is limited to the artwork stage so lyric scrolling and system back gestures stay untouched. */
internal fun Modifier.trackSwipeGestures(
    enabled: Boolean,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
): Modifier = if (!enabled) this else pointerInput(enabled) {
    var distance = 0f
    detectHorizontalDragGestures(
        onDragStart = { distance = 0f },
        onHorizontalDrag = { change, amount ->
            distance += amount
            change.consume()
        },
        onDragEnd = {
            if (abs(distance) >= 72.dp.toPx()) {
                if (distance < 0) onNext() else onPrevious()
            }
        },
        onDragCancel = { distance = 0f },
    )
}

/** A downward swipe on the visual stage collapses the player; lyric and queue views stay scrollable. */
internal fun Modifier.dismissPlayerSwipe(
    enabled: Boolean,
    onDismiss: () -> Unit,
): Modifier = if (!enabled) this else pointerInput(enabled) {
    var distance = 0f
    detectVerticalDragGestures(
        onDragStart = { distance = 0f },
        onVerticalDrag = { change, amount ->
            distance += amount
            change.consume()
        },
        onDragEnd = {
            if (distance >= 96.dp.toPx()) onDismiss()
        },
        onDragCancel = { distance = 0f },
    )
}
internal val classicDarkColors = darkColorScheme(primary = Color(0xFFE98A6D), onPrimary = Color(0xFF291E17), background = Color(0xFF191A17),
    surface = Color(0xFF191A17), surfaceVariant = Color(0xFF2B2E25), onSurface = Color(0xFFEEEAE2), onSurfaceVariant = Color(0xFFA8AA9D))
internal val redColors = darkColorScheme(
    primary = Color(0xFFFFF3E7), onPrimary = Color(0xFF9D0011), primaryContainer = Color(0xFF8E0010), onPrimaryContainer = Color(0xFFFFF3E7),
    secondary = Color(0xFFFFD4C7), onSecondary = Color(0xFF7F000A), secondaryContainer = Color(0xFFD51A27), onSecondaryContainer = Color.White,
    background = Color(0xFFAD0716), surface = Color(0xFFAD0716), surfaceVariant = Color(0xFFC81826),
    onSurface = Color(0xFFFFF8F1), onSurfaceVariant = Color(0xFFFFE0D8),
    surfaceContainerLowest = Color(0xFF87000D), surfaceContainerLow = Color(0xFF9D0413), surfaceContainer = Color(0xFFB40C1A),
    surfaceContainerHigh = Color(0xFFC91825), surfaceContainerHighest = Color(0xFFDB2734),
    outline = Color(0xFFF9B7AD), outlineVariant = Color(0xFFCC4F51),
)

@Composable
fun WildStringApp(model: MusicViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    var servers by rememberSaveable { mutableStateOf(false) }
    val preferences by model.settings.state.collectAsStateWithLifecycle()
    val systemDark = isSystemInDarkTheme()
    val dark = !preferences.redCloth && when (preferences.appearance) { "light" -> false; "dark" -> true; else -> systemDark }
    val window = LocalActivity.current?.window
    val view = androidx.compose.ui.platform.LocalView.current
    SideEffect { window?.let { WindowCompat.getInsetsController(it, view).apply {
        isAppearanceLightStatusBars = !dark && !preferences.redCloth
        isAppearanceLightNavigationBars = !dark && !preferences.redCloth
    } } }
    CompositionLocalProvider(LocalDarkAppearance provides dark, LocalRedCloth provides preferences.redCloth,
        LocalSongListSize provides preferences.songListSize,
        LocalTactileFeedback provides rememberTactileFeedback { model.settings.state.value.haptics }) {
        MaterialTheme(colorScheme = if (preferences.redCloth) redColors else if (dark) classicDarkColors else classicLightColors) {
            Surface(Modifier.fillMaxSize().testTag(if (preferences.redCloth) "appearance-red-cloth" else if (dark) "appearance-dark" else "appearance-light")) {
                key(state.serverSelection) { Crossfade(state.connected, animationSpec = tween(220), label = "connection") { connected ->
                    if (!connected) ConnectionScreen(state, model::connect) { servers = true } else LibraryApp(model, state)
                } }
                com.wildstring.app.update.UpdatePrompt()
                LaunchedEffect(state.playing, state.handoff?.version) {
                    if (state.playing && state.handoff != null) model.dismissHandoff()
                }
                state.handoff?.takeIf { !state.playing }?.let { saved ->
                    val action = remember(saved.version) { FeatureAction() }; val scope = rememberCoroutineScope()
                    Box(Modifier.fillMaxSize().safeDrawingPadding().padding(horizontal = 16.dp).padding(bottom = 90.dp), contentAlignment = Alignment.BottomCenter) {
                        Surface(Modifier.widthIn(max = 440.dp).fillMaxWidth().testTag("playback-handoff-notice"),
                            shape = RoundedCornerShape(16.dp), tonalElevation = 6.dp, shadowElevation = 8.dp) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("其他设备有可接续的进度", style = MaterialTheme.typography.titleSmall)
                                Text("${saved.trackIds.size} 首 · 第 ${saved.index + 1} 首 · ${formatTime(saved.positionMs)} · 其他设备最近暂停，载入后保持暂停",
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                if (action.message != "已完成") ActionStatus(action)
                                Row(Modifier.align(Alignment.End)) {
                                    TextButton(model::dismissHandoff, enabled = !action.busy) { Text("暂不") }
                                    TextButton({ scope.launch { action.run { model.acceptHandoff() } } }, enabled = !action.busy) { Text("载入进度") }
                                }
                            }
                        }
                    }
                }
                if (servers) ServersScreen(model) { servers = false }
            }
        }
    }
}

@Composable
fun ConnectionScreen(state: MusicState, connect: (String, String, String, Boolean) -> Unit, manageServers: () -> Unit = {}) {
    var server by rememberSaveable(state.serverSelection) { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var localHttp by rememberSaveable { mutableStateOf(state.localHttp) }
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.size(64.dp), tint = Color.Unspecified)
            Text("野弦", fontSize = 32.sp, fontWeight = FontWeight.Medium)
            Text("连接自己的音乐收藏", color = Muted)
            TextButton(manageServers, Modifier.testTag("connection-servers")) { Icon(Icons.Default.Dns, null); Spacer(Modifier.width(8.dp)); Text("服务器 / 切换服务器") }
            OutlinedTextField(server, { server = it }, Modifier.fillMaxWidth(), label = { Text("服务器地址") }, placeholder = { Text("https://music.your-domain.com") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !state.connecting)
            OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text("账号") }, singleLine = true, enabled = !state.connecting)
            OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("密码") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), enabled = !state.connecting)
            if (BuildConfig.DEBUG) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(localHttp, { localHttp = it }, enabled = !state.connecting)
                Text("允许本机调试 HTTP（仅 localhost / 127.0.0.1 / 10.0.2.2）", fontSize = 12.sp, color = Muted)
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = { connect(server, username, password, localHttp) }, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !state.connecting && server.isNotBlank() && username.isNotBlank()) {
                if (state.connecting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Text("连接并登录")
            }
            Text("首次使用请在服务端设置管理员。服务器需提供可访问的 HTTPS 地址。", color = Muted, fontSize = 12.sp)
        }
    }
}

@Composable
private fun LibraryApp(vm: MusicViewModel, state: MusicState) {
    val inbox by vm.agent.inbox.collectAsStateWithLifecycle()
    val unread = inbox.unread.takeIf { inbox.owner == vm.repository.session.cacheScope() } ?: 0
    val rotation = rememberSaveable(saver = PlaybackRotation.Saver) { PlaybackRotation() }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var playerReturnDepth by rememberSaveable { mutableIntStateOf(-1) }
    var playerReturnTab by rememberSaveable { mutableStateOf("") }
    var returnLyrics by rememberSaveable { mutableStateOf(false) }
    var returnQueue by rememberSaveable { mutableStateOf(false) }
    var returnFromSettings by rememberSaveable { mutableStateOf(false) }
    var playerFromSettings by rememberSaveable { mutableStateOf(false) }
    var lyrics by rememberSaveable { mutableStateOf(false) }
    var queue by rememberSaveable { mutableStateOf(false) }
    var settings by rememberSaveable { mutableStateOf(false) }
    var feature by remember { mutableStateOf<String?>(null) }
    var featureTrack by remember { mutableStateOf<Track?>(null) }
    var featurePlaylist by remember { mutableStateOf<Playlist?>(null) }
    var featureBatchId by remember { mutableStateOf<String?>(null) }
    var sleepDialog by remember { mutableStateOf(false) }
    var diagnostics by remember { mutableStateOf(false) }
    var refreshAlbum by remember { mutableStateOf<String?>(null) }
    var lyricScanAlbum by remember { mutableStateOf<String?>(null) }
    var deletingPlaylist by remember { mutableStateOf<Playlist?>(null) }
    var playlistActions by remember { mutableStateOf<Playlist?>(null) }
    val playlistAction = remember { FeatureAction() }
    var actions by remember { mutableStateOf<Track?>(null) }
    var playlistChoices by remember { mutableStateOf<List<Playlist>?>(null) }
    var chooseTrack by remember { mutableStateOf<Track?>(null) }
    var localError by remember { mutableStateOf<String?>(null) }
    fun collapsePlayer() {
        vm.cancelAlbumNavigation()
        expanded = false
        if (playerFromSettings) { settings = true; playerFromSettings = false }
    }
    fun openTrackAlbum(track: Track) {
        actions = null
        val fromPlayer = expanded
        val originalLyrics = lyrics
        val originalQueue = queue
        val originalSettings = playerFromSettings
        vm.openTrackAlbum(track, fromPlayer = fromPlayer) {
            if (fromPlayer) {
                playerReturnDepth = vm.state.value.navigationDepth - 1
                playerReturnTab = vm.state.value.tab
                returnLyrics = originalLyrics; returnQueue = originalQueue; returnFromSettings = originalSettings
            }
            expanded = false; queue = false; lyrics = false; settings = false; playerFromSettings = false
        }
    }
    LaunchedEffect(state.tab, state.navigationDepth) {
        if (playerReturnDepth >= 0) {
            if (state.tab != playerReturnTab) playerReturnDepth = -1
            else if (state.navigationDepth <= playerReturnDepth) {
                expanded = true; lyrics = returnLyrics; queue = returnQueue; playerFromSettings = returnFromSettings
                playerReturnDepth = -1
            }
        }
    }
    val scope = rememberCoroutineScope()
    val mutationSnackbar = remember { SnackbarHostState() }
    var slowCatalogLoad by remember { mutableStateOf(false) }
    LaunchedEffect(state.loading, state.contentKey) {
        slowCatalogLoad = false
        if (state.loading) {
            delay(2_200)
            slowCatalogLoad = true
        }
    }
    LaunchedEffect(state.error, state.mutationMessage) {
        (state.error ?: state.mutationMessage)?.let { message ->
            try { mutationSnackbar.showSnackbar(message) }
            finally { if (state.error == null) vm.acknowledgeMessage(message) }
        }
    }
    val savedPages = rememberSaveableStateHolder()
    val pullRefresh = rememberPullToRefreshState()
    val savedKeys = remember { ArrayDeque<String>() }
    LaunchedEffect(state.contentKey) {
        savedKeys.remove(state.contentKey); savedKeys.addLast(state.contentKey)
        if (savedKeys.size > 32) savedPages.removeState(savedKeys.removeFirst())
    }
    val destination = when { settings -> "settings"; expanded && state.current != null -> "player"; else -> "catalog" }
    // Draw the atmosphere behind system bars; only interactive content consumes the safe area.
    Crossfade(destination, animationSpec = tween(220), label = "destination-background") { screen ->
        if (screen == "player") state.current?.let { ArtworkBackdrop(vm, it, LocalRedCloth.current) }
        else Box(Modifier.fillMaxSize().background(if (screen == "settings") MaterialTheme.colorScheme.surfaceContainerLow else Background))
    }
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
        val wide = maxWidth >= 840.dp && maxHeight >= 480.dp
        val landscape = maxWidth > maxHeight && !wide
        val rail = maxWidth >= 600.dp && maxHeight >= 480.dp
        val compact = maxHeight < 600.dp
        var wasWide by remember { mutableStateOf(wide) }
        LaunchedEffect(wide) { if (wasWide && !wide && expanded && !queue) lyrics = true; wasWide = wide }
        BackHandler(enabled = !settings && (expanded || queue || state.canGoBack || state.tab != "search")) {
            when { queue -> queue = false; lyrics && !wide -> lyrics = false; expanded -> collapsePlayer(); state.canGoBack -> vm.back(); else -> vm.navigate("search") }
        }
        AnimatedContent(destination, transitionSpec = {
            if (targetState == "settings" || initialState == "settings") {
                (fadeIn(tween(180)) + slideInHorizontally(tween(240)) { if (targetState == "settings") it / 6 else -it / 12 }) togetherWith fadeOut(tween(120))
            } else (fadeIn(tween(220)) + slideInVertically(tween(280, easing = FastOutSlowInEasing)) { it / 12 }) togetherWith fadeOut(tween(140))
        }, label = "app-destination") { destination ->
        if (destination == "settings") savedPages.SaveableStateProvider("settings") { SettingsScreen(vm, bottomBar = {
            MiniPlayer(vm, state, onQueue = { queue = true }) { playerFromSettings = true; settings = false; expanded = true; lyrics = false; queue = false }
        }) { settings = false } }
        else if (destination == "player") {
            PlayerScreen(vm, state, wide, landscape, lyrics, queue, rotation,
                onBack = { if (lyrics && !wide) lyrics = false else collapsePlayer() },
                onLyrics = { lyrics = !lyrics; queue = false }, onQueue = { queue = !queue },
                onAlbum = { state.current?.let(::openTrackAlbum) },
                onAdd = { actions = state.current }, onSleep = { sleepDialog = true })
        } else {
            Row(Modifier.fillMaxSize()) {
                if (rail) NavigationRail(windowInsets = WindowInsets(0, 0, 0, 0), modifier = Modifier.testTag("navigation-rail")) {
                    Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.padding(vertical = 24.dp).size(36.dp), tint = Color.Unspecified)
                    RailItems(state, vm)
                }
                Scaffold(
                    contentWindowInsets = WindowInsets(0, 0, 0, 0),
                    topBar = { CatalogTopBar(state, vm::back, { settings = true }, compact = true, unread = unread,
                        notifications = { feature = "notifications" },
                        queue = if (state.kind !in listOf("tracks", "recent")) ({ queue = true }) else null,
                        recent = if (state.kind !in listOf("tracks", "recent")) vm::recent else null,
                        offline = if (state.kind !in listOf("tracks", "recent")) ({ feature = "offline" }) else null) },
                    bottomBar = { Column {
                        if (state.current != null) MiniPlayer(vm, state, onQueue = { queue = true }) { playerReturnDepth = -1; playerFromSettings = false; expanded = true; lyrics = false; queue = false }
                        if (!rail) NavigationBar(windowInsets = WindowInsets(0, 0, 0, 0), modifier = Modifier.testTag("bottom-navigation")) { BottomItems(state, vm) }
                    } },
                ) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding)) {
                        if (state.tab == "library" && state.collection == null) LibraryTabs(state.kind, vm::kind)
                        // Keep the editor outside query-keyed pages and discover/result branches.
                        if (state.tab == "search" && state.collection == null && state.kind != "recent") CatalogSearch(state.query, vm::search)
                        val header: @Composable () -> Unit = {
                            Column(Modifier.fillMaxWidth()) {
                                if (state.tab == "mine" && state.collection == null && state.kind != "recent") {
                                    PersonalHeader(vm, state, { vm.recent() }, compact = compact)
                                    MobileShortcuts { feature = it }
                                    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                        Text("我的歌单", style = MaterialTheme.typography.titleMedium)
                                        IconButton({ featurePlaylist = null; feature = "playlist" }) { Icon(Icons.Default.Add, "新建歌单") }
                                    }
                                }
                                if (state.kind == "artists" && state.collection == null) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    listOf("artist" to "艺人", "album_artist" to "专辑艺人", "vocalist" to "演唱", "lyricist" to "作词", "composer" to "作曲", "arranger" to "编曲").forEach { (key, name) -> FilterChip(state.role == key, { vm.role(key) }, label = { Text(name) }) }
                                }
                                if (state.collection == "artists" && state.albumFilter == null) Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    FilterChip(state.kind == "tracks", { vm.kind("tracks") }, label = { Text("歌曲") })
                                    FilterChip(state.kind == "albums", { vm.kind("albums") }, label = { Text("专辑") })
                                }
                                if (state.tab == "search" && state.kind == "discover") MobileShortcuts(discovery = true) { feature = it }
                                state.error?.let { ErrorMessage(it, vm::load) }
                                if (state.offline) Text("网络暂不可用 · 显示本机缓存", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
                                if (state.kind == "albums") Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Text("${state.total} 张专辑", Modifier.weight(1f), color = Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                                    CatalogSortControls(state, vm::sort, vm::toggleSortOrder)
                                }
                                if (state.kind == "tracks" || state.kind == "recent") CatalogToolbar(state,
                                    play = tactile { vm.playCollection { playerReturnDepth = -1; expanded = true; lyrics = false; queue = false } }, sort = vm::sort, reverse = vm::toggleSortOrder,
                                    multi = { feature = "multi" }, download = { vm.downloadCollection() },
                                    edit = { featurePlaylist = state.activePlaylist; feature = "playlist" },
                                    order = { featurePlaylist = state.activePlaylist; feature = "order" },
                                    delete = { deletingPlaylist = state.activePlaylist },
                                    albumLyrics = if (state.account?.role == "admin" && (state.collection == "albums" || state.albumFilter != null)) ({ lyricScanAlbum = state.albumFilter ?: state.collectionId }) else null,
                                    albumRefresh = if (state.account?.role == "admin" && (state.collection == "albums" || state.albumFilter != null)) ({ refreshAlbum = state.albumFilter ?: state.collectionId }) else null)
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            PullToRefreshBox(isRefreshing = state.loading, onRefresh = { if (!state.loading) vm.load() },
                                modifier = Modifier.fillMaxSize().testTag("catalog-refresh-area").semantics {
                                    customActions = listOf(CustomAccessibilityAction("刷新当前页面") {
                                        if (state.loading) false else { vm.load(); true }
                                    })
                                }, state = pullRefresh,
                                indicator = { WildRefreshIndicator(state.loading, pullRefresh, Modifier.align(Alignment.TopCenter)) }) {
                                savedPages.SaveableStateProvider(state.contentKey.ifBlank { "initial" }) {
                                    if (state.kind == "discover") DiscoveryPage(vm, state,
                                        play = { index -> vm.play(state.tracks, index); playerReturnDepth = -1; expanded = true; lyrics = false; queue = false }, recent = vm::recent, header = header)
                                    else CatalogBrowser(vm, state, header,
                                        play = { track -> vm.playCollection(track.id) { playerReturnDepth = -1; expanded = true; lyrics = false; queue = false } },
                                        actions = { actions = it }, playlistActions = { playlistActions = it })
                                }
                            }
                            if (state.loading) Surface(
                                Modifier.align(Alignment.TopCenter).padding(top = 8.dp).testTag("catalog-loading-feedback"),
                                shape = RoundedCornerShape(20.dp), tonalElevation = 3.dp,
                            ) {
                                Row(Modifier.padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                                    Spacer(Modifier.width(8.dp))
                                    Text(
                                        when {
                                            slowCatalogLoad -> "网络较慢，仍在加载…"
                                            state.hasContent -> "正在更新…"
                                            else -> "正在打开…"
                                        },
                                        style = MaterialTheme.typography.labelMedium,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        }
        if (queue && ((!wide && !landscape) || !expanded)) ModalBottomSheet(onDismissRequest = { queue = false }) { QueuePanel(vm, state, Modifier.fillMaxWidth().heightIn(max = 560.dp)) }
    }
    val playerFeedback = expanded && state.current != null && !settings
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = if (playerFeedback) Alignment.TopCenter else Alignment.BottomCenter) {
        SnackbarHost(mutationSnackbar, Modifier.padding(horizontal = 16.dp, vertical = if (playerFeedback) 64.dp else 16.dp).testTag("mutation-feedback"))
    }
    fun openFeatureAction(target: String, params: JsonObject?) {
        val batchId = params?.text("batch_id")?.takeIf { it.isNotBlank() }
        when (target) {
            "metadata-center", "metadata-review" -> { feature = "management"; featureBatchId = batchId }
            "lyric-scan" -> { feature = "lyric-scans"; featureBatchId = batchId }
        }
    }
    feature?.let { route -> FeatureDialog(vm, route, featureTrack, featurePlaylist, dismiss = { feature = null; featureTrack = null; featurePlaylist = null; featureBatchId = null }, initialBatchId = featureBatchId, onOpenAction = ::openFeatureAction) }
    playlistActions?.let { playlist -> ModalBottomSheet(onDismissRequest = { playlistActions = null }) {
        Text(playlist.name, Modifier.padding(horizontal = 20.dp, vertical = 12.dp), style = MaterialTheme.typography.titleLarge)
        SongAction("打开歌单", Icons.AutoMirrored.Filled.PlaylistPlay) { playlistActions = null; vm.openPlaylist(playlist) }
        SongAction(if (playlist.id in vm.repository.downloads.followedPlaylists()) "关闭自动下载" else "自动下载歌单", Icons.Default.Download) {
            vm.followPlaylist(playlist, playlist.id !in vm.repository.downloads.followedPlaylists()); playlistActions = null
        }
        if (playlist.kind != "favorites") {
            SongAction("编辑歌单", Icons.Default.Edit) { featurePlaylist = playlist; feature = "playlist"; playlistActions = null }
            if (playlist.kind == "manual") SongAction("管理歌单曲目", Icons.AutoMirrored.Filled.QueueMusic) { featurePlaylist = playlist; feature = "order"; playlistActions = null }
            SongAction("删除歌单", Icons.Default.Delete, destructive = true) { deletingPlaylist = playlist; playlistActions = null }
        }
        Spacer(Modifier.height(24.dp))
    } }
    lyricScanAlbum?.let { albumId -> FeatureDialog(vm, "lyric-scans", albumId = albumId, dismiss = { lyricScanAlbum = null }) }
    refreshAlbum?.let { albumId -> MetadataRefreshPrompt(vm, "album", albumId) { refreshAlbum = null } }
    if (sleepDialog) SleepDialog(vm) { sleepDialog = false }
    if (diagnostics) PlaybackDiagnosticsDialog(vm) { diagnostics = false }
    deletingPlaylist?.let { playlist -> AlertDialog(onDismissRequest = { if (!playlistAction.busy) deletingPlaylist = null }, title = { Text("删除歌单？") }, text = { Column { Text(playlist.name); ActionStatus(playlistAction) } }, confirmButton = { TextButton({ scope.launch { playlistAction.run { vm.deletePlaylist(playlist); deletingPlaylist = null } } }, enabled = !playlistAction.busy) { Text("删除") } }, dismissButton = { TextButton({ deletingPlaylist = null }, enabled = !playlistAction.busy) { Text("取消") } }) }
    actions?.let { track -> ModalBottomSheet(
        onDismissRequest = { actions = null },
        modifier = Modifier.testTag("song-actions-sheet"),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        // Only the list consumes vertical flings; the sheet must not share their velocity.
        sheetGesturesEnabled = false,
        dragHandle = {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("歌曲操作", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton({ actions = null }) { Icon(Icons.Default.Close, "关闭歌曲操作") }
            }
        },
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 640.dp).testTag("song-actions-scroll").verticalScroll(rememberScrollState(), overscrollEffect = null)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(48.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(track.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(track.artist, style = MaterialTheme.typography.bodySmall, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        SongAction("查看所属专辑", Icons.Default.Album, navigate = true) { openTrackAlbum(track) }
        SongAction("响度均衡与手动调整", Icons.Default.VolumeUp) { feature = "gain"; featureTrack = track; actions = null }
        if (track.id == state.current?.id) SongAction("播放诊断", Icons.Default.Troubleshoot) { diagnostics = true; actions = null }
        HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        SongAction("下一首播放", Icons.AutoMirrored.Filled.PlaylistPlay, onClick = tactile { vm.addToQueue(track, true); actions = null })
        SongAction("加入播放队列", Icons.AutoMirrored.Filled.QueueMusic, onClick = tactile { vm.addToQueue(track); actions = null })
        SongAction(if (track.loved) "取消收藏" else "收藏", if (track.loved) Icons.Default.Favorite else Icons.Default.FavoriteBorder, onClick = tactile { vm.favorite(track); actions = null })
        SongAction("加入歌单", Icons.AutoMirrored.Filled.PlaylistAdd) {
            chooseTrack = track; actions = null
            scope.launch { try { playlistChoices = vm.playlistsForAdd() } catch (e: Exception) { localError = friendlyError(e) } }
        }
        SongAction("离线保存", Icons.Default.Download) { vm.download(listOf(track)); actions = null }
        state.activePlaylist?.takeIf { it.kind == "manual" }?.let { playlist -> SongAction("从当前歌单移除", Icons.Default.RemoveCircleOutline, destructive = true) { actions = null; scope.launch { try { vm.removePlaylistTrack(track, playlist) } catch (e: Exception) { localError = friendlyError(e) } } } }
        if (state.account?.role == "admin") {
            HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            listOf(Triple("metadata", "编辑歌曲信息", Icons.Default.Edit), Triple("lyrics", "编辑歌词与打点", Icons.Default.Lyrics), Triple("suggestions", "更新元数据与建议", Icons.Default.Refresh)).forEach { (route, title, icon) ->
                SongAction(title, icon, navigate = true) { featureTrack = track; feature = route; actions = null }
            }
        }
        Spacer(Modifier.height(24.dp))
        }
    } }
    playlistChoices?.let { choices -> AlertDialog(onDismissRequest = { playlistChoices = null }, title = { Text("加入歌单") }, text = {
        if (choices.isEmpty()) Text("请先创建普通歌单。") else Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            choices.forEach { p -> TextButton(tactile { chooseTrack?.let { vm.addToPlaylist(it, p) }; playlistChoices = null }) { Text(p.name) } }
        }
    }, confirmButton = { TextButton({ playlistChoices = null }) { Text("关闭") } }) }
    localError?.let { text -> AlertDialog(onDismissRequest = { localError = null }, text = { Text(text) }, confirmButton = { TextButton({ localError = null }) { Text("关闭") } }) }
}

@Composable
private fun SongAction(label: String, icon: ImageVector, navigate: Boolean = false, destructive: Boolean = false, onClick: () -> Unit) {
    val color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    ListItem(
        headlineContent = { Text(label, style = MaterialTheme.typography.bodyLarge) },
        leadingContent = { Icon(icon, null, Modifier.size(24.dp)) },
        trailingContent = { if (navigate) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(20.dp), tint = Muted) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent, headlineColor = color, leadingIconColor = if (destructive) color else Muted),
        modifier = Modifier.fillMaxWidth().testTag("song-action-$label").clickable(onClick = onClick),
    )
}

@Composable
private fun RailItems(state: MusicState, vm: MusicViewModel) {
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    listOf(Triple("search", "发现", Icons.Default.Search), Triple("library", "音乐", Icons.Default.LibraryMusic), Triple("mine", "我的", Icons.Default.Person)).forEach { (id, label, icon) ->
        NavigationRailItem(state.tab == id, { keyboard?.hide(); vm.navigate(id) }, modifier = Modifier.testTag("nav-$id"), icon = { Icon(icon, label) }, label = { Text(label) })
    }
}
@Composable
private fun RowScope.BottomItems(state: MusicState, vm: MusicViewModel) {
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    listOf(Triple("search", "发现", Icons.Default.Search), Triple("library", "音乐", Icons.Default.LibraryMusic), Triple("mine", "我的", Icons.Default.Person)).forEach { (id, label, icon) ->
        NavigationBarItem(state.tab == id, { keyboard?.hide(); vm.navigate(id) }, modifier = Modifier.testTag("nav-$id"), icon = { Icon(icon, label) }, label = { Text(label) })
    }
}

@Composable
internal fun Cover(vm: MusicViewModel, id: String?, title: String, modifier: Modifier, contentScale: ContentScale = ContentScale.Crop) {
    val profile by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val fallback = painterResource(if (LocalRedCloth.current) R.drawable.ic_red_cloth else R.drawable.ic_wildstring)
    AsyncImage(model = id?.let { ImageRequest.Builder(LocalContext.current).data(vm.repository.cover(it)).memoryCacheKey("${profile}:${it}").crossfade(180).build() }, imageLoader = vm.imageLoader, contentDescription = title,
        placeholder = fallback, error = fallback, fallback = fallback,
        contentScale = contentScale, modifier = modifier.clip(RoundedCornerShape(10.dp)))
}
@Composable
internal fun TrackRow(vm: MusicViewModel, track: Track, state: MusicState, index: Int, play: () -> Unit, actions: () -> Unit) {
    val current = state.current?.id == track.id
    val album = state.collection == "albums" || state.albumFilter != null
    val size = LocalSongListSize.current
    val metric = when (state.sort) {
        "play_count" -> "${track.playCount} 次"
        "listened_ms" -> "${track.listenedMs / 60_000} 分钟"
        "last_played_at" -> track.lastPlayedAt?.take(10)
        else -> null
    }
    Row(Modifier.fillMaxWidth().heightIn(min = size.rowDp.dp).testTag("catalog-item-$index")
        .background(if (current) MaterialTheme.colorScheme.primary.copy(alpha = .08f) else Color.Transparent)
        .semantics { selected = current }.clickable(onClick = tactile(play))
        .padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (album) Box(Modifier.width(30.dp), contentAlignment = Alignment.Center) {
            if (current) PlaybackIndicator(state.playing, state.buffering)
            else Text(track.trackNumber?.toString()?.padStart(2, '0') ?: "—", color = Muted, style = MaterialTheme.typography.bodySmall, fontSize = size.artistSp.sp, lineHeight = size.artistLineSp.sp)
        } else Box(Modifier.size(size.coverDp.dp).clip(RoundedCornerShape(10.dp)).testTag("track-cover-$index"), contentAlignment = Alignment.Center) {
            Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.fillMaxSize())
            if (current) {
                Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = .46f)))
                PlaybackIndicator(state.playing, state.buffering, color = Color.White)
            }
        }
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Text(track.title, Modifier.testTag("track-title-$index"), color = if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge, fontSize = size.titleSp.sp, lineHeight = size.titleLineSp.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(if (album && state.discs.size > 1 && state.sort !in listOf("title", "track_number")) "Disc ${track.discNumber ?: 1}" else null, track.artist, metric).joinToString(" · "), Modifier.testTag("track-subtitle-$index"), color = Muted,
                style = MaterialTheme.typography.bodySmall, fontSize = size.artistSp.sp, lineHeight = size.artistLineSp.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(actions, Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("track-action-$index")) { Icon(Icons.Default.MoreVert, "${track.title}的操作") }
    }
}

@Composable
internal fun CatalogToolbar(state: MusicState, play: () -> Unit, sort: (String) -> Unit, reverse: () -> Unit, multi: () -> Unit,
    download: () -> Unit, edit: () -> Unit, order: () -> Unit, delete: () -> Unit,
    albumLyrics: (() -> Unit)? = null, albumRefresh: (() -> Unit)? = null) {
    var more by remember { mutableStateOf(false) }
    BoxWithConstraints(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp).testTag("catalog-toolbar")) {
        // Measure the current labels with the actual font scale. Use one row
        // whenever all controls and the full count fit, including the rail gutter.
        val measurer = rememberTextMeasurer()
        val density = LocalDensity.current
        fun textWidth(text: String, style: androidx.compose.ui.text.TextStyle) = with(density) {
            measurer.measure(AnnotatedString(text), style = style, softWrap = false, maxLines = 1).size.width.toDp()
        }
        val playLabel = if (state.collecting) "准备中…" else "播放全部"
        val countLabel = "${state.total} 首"
        val sortContext = catalogSortContext(state.kind, state.collection, state.albumFilter)
        val sortLabel = sortContext?.let { catalogSortChoices(it).firstOrNull { choice -> choice.first == state.sort }?.second ?: "歌曲名称" }
        val requiredWidth = maxOf(64.dp, textWidth(playLabel, MaterialTheme.typography.labelLarge) + 50.dp) +
            textWidth(countLabel, MaterialTheme.typography.labelMedium) + 8.dp + 48.dp + 8.dp +
            (if (state.collection != "playlists" && sortLabel != null) maxOf(64.dp, textWidth(sortLabel, MaterialTheme.typography.labelLarge) + 36.dp) else 0.dp)
        val stacked = maxWidth < requiredWidth
        val playback: @Composable RowScope.() -> Unit = {
            FilledTonalButton(play, Modifier.testTag("catalog-play-all"), enabled = state.total > 0 && !state.collecting, contentPadding = PaddingValues(horizontal = 14.dp)) {
                Icon(Icons.Default.PlayArrow, null, Modifier.size(18.dp)); Spacer(Modifier.width(4.dp))
                Text(playLabel, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
            }
            Text(countLabel, Modifier.padding(start = 8.dp).weight(1f).testTag("catalog-count"),
                style = MaterialTheme.typography.labelMedium, color = Muted, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
        }
        val actions: @Composable RowScope.() -> Unit = {
            if (state.collection != "playlists") CatalogSortControls(state, sort, reverse, if (stacked) Modifier.weight(1f) else Modifier)
            Box {
                IconButton({ more = true }, Modifier.testTag("catalog-more")) { Icon(Icons.Default.MoreVert, "列表操作") }
                DropdownMenu(more, { more = false }) {
                    albumLyrics?.let { open -> DropdownMenuItem(text = { Text("歌词补全与洗版") }, leadingIcon = { Icon(Icons.Default.Lyrics, null) }, onClick = { more = false; open() }) }
                    albumRefresh?.let { update -> DropdownMenuItem(text = { Text("更新专辑元数据") }, leadingIcon = { Icon(Icons.Default.Edit, null) }, onClick = { more = false; update() }) }
                    if (albumLyrics != null || albumRefresh != null) HorizontalDivider()
                    DropdownMenuItem(text = { Text("多选加入") }, onClick = { more = false; multi() })
                    DropdownMenuItem(text = { Text("离线保存") }, onClick = { more = false; download() }, enabled = !state.collecting)
                    state.activePlaylist?.takeIf { it.kind != "favorites" }?.let { playlist ->
                        DropdownMenuItem(text = { Text("编辑歌单") }, onClick = { more = false; edit() })
                        if (playlist.kind == "manual") DropdownMenuItem(text = { Text("拖动排序") }, onClick = { more = false; order() })
                        DropdownMenuItem(text = { Text("删除歌单") }, onClick = { more = false; delete() })
                    }
                }
            }
        }
        if (stacked) Column {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, content = playback)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, content = actions)
        } else Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            playback(); actions()
        }
    }
}
@Composable
private fun PlayerScreen(vm: MusicViewModel, input: MusicState, wide: Boolean, landscape: Boolean, lyrics: Boolean, queue: Boolean, rotation: PlaybackRotation,
    onBack: () -> Unit, onLyrics: () -> Unit, onQueue: () -> Unit, onAlbum: () -> Unit, onAdd: () -> Unit, onSleep: () -> Unit) {
    val position by vm.position.collectAsStateWithLifecycle()
    val state = input.copy(position = position)
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val sleep by vm.sleep.state.collectAsStateWithLifecycle()
    val feedback = LocalTactileFeedback.current
    val track = state.current ?: return
    val progress = if (state.duration > 0) state.position.toFloat() / state.duration else 0f
    var artworkPreview by rememberSaveable { mutableStateOf(false) }
    val showArtwork = remember { { artworkPreview = true } }
    val dismissArtwork = remember { { artworkPreview = false } }
    val spinning = state.playing && !state.buffering && state.playbackError == null && !artworkPreview
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.testTag(if (wide) "player-tablet" else if (landscape) "player-landscape" else "player-phone").fillMaxSize().padding(horizontal = if (wide) 34.dp else 20.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onBack) {
                Icon(
                    if (lyrics && !wide) Icons.AutoMirrored.Filled.ArrowBack else Icons.Default.KeyboardArrowDown,
                    if (lyrics && !wide) "返回封面" else "收起播放器",
                )
            }
            Spacer(Modifier.weight(1f))
            IconButton(onSleep) { Icon(Icons.Default.Bedtime, "睡眠定时", tint = if (sleep.deadline != null || sleep.entryId != null) Accent else Muted) }
            IconButton(vm::refreshLyrics) { Icon(Icons.Default.Refresh, "刷新歌词") }
            IconButton(onAdd) { Icon(Icons.Default.MoreVert, "当前歌曲操作") }
        }
        if (landscape) Row(Modifier.weight(1f).fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight().testTag("player-visual-stage")
                .pointerInput(onLyrics, showArtwork, queue) {
                    detectTapGestures(
                        onDoubleTap = { /* Deliberately no double-tap action on the cover. */ },
                        onLongPress = { if (!queue) showArtwork() },
                        onTap = { onLyrics() },
                    )
                }
                .dismissPlayerSwipe(!queue && !lyrics, onBack)
                .trackSwipeGestures(!queue && !lyrics,
                    onPrevious = { feedback(TactileKind.Tap); vm.previous() },
                    onNext = { feedback(TactileKind.Tap); vm.next() }), contentAlignment = Alignment.Center) {
                when {
                    queue -> QueuePanel(vm, state, Modifier.fillMaxSize())
                    lyrics -> LyricsPanel(vm, state, Modifier.fillMaxSize(), onLyrics, showArtwork)
                    else -> PlaybackVisual(vm, track, preferences.playbackStyle, spinning, true, progress, rotation,
                        Modifier.size(minOf(maxWidth, maxHeight)), showArtwork, onLyrics)
                }
            }
            Column(Modifier.weight(1.15f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
                PlaybackControls(vm, state, onQueue, onAlbum, compact = true)
            }
        } else if (wide) Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(.9f).fillMaxHeight().widthIn(max = 380.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()
                    .dismissPlayerSwipe(!lyrics && !queue, onBack)
                    .trackSwipeGestures(!lyrics && !queue,
                        onPrevious = { feedback(TactileKind.Tap); vm.previous() },
                        onNext = { feedback(TactileKind.Tap); vm.next() }), contentAlignment = Alignment.Center) {
                    val visualSize = minOf(300.dp, maxWidth, maxHeight)
                    PlaybackVisual(vm, track, preferences.playbackStyle, spinning, true, progress, rotation,
                        Modifier.size(visualSize), showArtwork) { if (queue) onQueue() }
                }
                Spacer(Modifier.height(20.dp)); PlaybackControls(vm, state, onQueue, onAlbum)
            }
            Column(Modifier.weight(1.1f).fillMaxHeight().padding(top = 24.dp, bottom = 16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FilterChip(!queue, { if (queue) onQueue() }, label = { Text("歌词") })
                    FilterChip(queue, { if (!queue) onQueue() }, label = { Text("队列 · ${state.queue.size}") })
                }
                if (queue) QueuePanel(vm, state, Modifier.weight(1f)) else LyricsPanel(vm, state, Modifier.weight(1f), onArtwork = showArtwork)
            }
        } else {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().testTag("player-visual-stage")
                .pointerInput(onLyrics, showArtwork, lyrics) {
                    detectTapGestures(
                        onDoubleTap = { /* Deliberately no double-tap action on the cover. */ },
                        onLongPress = { showArtwork() },
                        onTap = { onLyrics() },
                    )
                }
                .dismissPlayerSwipe(!lyrics, onBack)
                .trackSwipeGestures(!lyrics,
                    onPrevious = { feedback(TactileKind.Tap); vm.previous() },
                    onNext = { feedback(TactileKind.Tap); vm.next() }), contentAlignment = Alignment.Center) {
                val visualSize = minOf(370.dp, maxWidth, maxHeight)
                Crossfade(lyrics, Modifier.fillMaxSize(), animationSpec = tween(240), label = "lyrics-cover") { showingLyrics ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (showingLyrics) LyricsPanel(vm, state, Modifier.fillMaxSize().padding(top = 8.dp, bottom = 32.dp), onLyrics, showArtwork)
                        else PlaybackVisual(vm, track, preferences.playbackStyle, spinning, !lyrics, progress, rotation,
                            Modifier.size(visualSize), showArtwork, onLyrics)
                    }
                }
            }
            PlaybackControls(vm, state, onQueue, onAlbum)
        }
    }
    }
    if (artworkPreview) ArtworkPreview(vm, track, dismissArtwork)
}

@Composable
private fun PlaybackControls(vm: MusicViewModel, state: MusicState, onQueue: () -> Unit, onAlbum: () -> Unit, compact: Boolean = false) {
    var scrub by remember { mutableStateOf<Float?>(null) }
    val feedback = LocalTactileFeedback.current
    val track = state.current ?: return
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(track.title, fontSize = if (compact) 20.sp else 23.sp, fontWeight = FontWeight.Medium, maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis)
                Text(track.artist, color = Muted, fontSize = 13.sp, maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis)
            }
            FavoriteControl(track.loved, track.id in state.pendingFavorites, tactile { vm.favorite(track) })
        }
        TextButton(onAlbum, Modifier.testTag("player-album").heightIn(min = 40.dp), contentPadding = PaddingValues(0.dp)) {
            Text("专辑 · ${track.album ?: "未知专辑"}", color = Muted, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(16.dp), tint = Muted)
        }
        if (state.playbackQuality.isNotBlank()) Text(state.playbackQuality, color = Muted, fontSize = 11.sp, modifier = Modifier.padding(top = 6.dp).testTag("playback-quality"))
        Slider(value = scrub ?: state.position.coerceAtMost(state.duration).toFloat(), onValueChange = { scrub = it },
            onValueChangeFinished = { scrub?.let { feedback(TactileKind.Tap); vm.seek(it.toLong()) }; scrub = null }, valueRange = 0f..state.duration.coerceAtLeast(1).toFloat(), enabled = state.duration > 0,
            colors = SliderDefaults.colors(thumbColor = Accent, activeTrackColor = Accent,
                inactiveTrackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = .14f),
                activeTickColor = Color.Transparent, inactiveTickColor = Color.Transparent))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(formatTime(scrub?.toLong() ?: state.position), color = Muted, fontSize = 11.sp); Text(formatTime(state.duration), color = Muted, fontSize = 11.sp) }
        Row(Modifier.fillMaxWidth().padding(vertical = if (compact) 4.dp else 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            val modeIcon = if (state.shuffle) Icons.Default.Shuffle else if (state.repeatMode == Player.REPEAT_MODE_ONE) Icons.Default.RepeatOne else Icons.Default.Repeat
            IconButton(tactile(vm::cycleMode)) { Icon(modeIcon, "切换播放模式", tint = if (state.shuffle || state.repeatMode != Player.REPEAT_MODE_OFF) Accent else Muted) }
            IconButton(tactile(vm::previous)) { Icon(Icons.Default.SkipPrevious, "上一首", Modifier.size(30.dp)) }
            FilledIconButton(tactile(vm::toggle), Modifier.size(if (compact) 56.dp else 64.dp)) {
                if (delayed(state.buffering, 500)) CircularProgressIndicator(Modifier.size(25.dp), strokeWidth = 2.dp)
                else Crossfade(state.playing, animationSpec = tween(130), label = "play-pause") { playing -> Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) "暂停" else "播放", Modifier.size(34.dp)) }
            }
            IconButton(tactile(vm::next)) { Icon(Icons.Default.SkipNext, "下一首", Modifier.size(30.dp)) }
            IconButton(tactile(onQueue)) { Icon(Icons.AutoMirrored.Filled.QueueMusic, "播放队列") }
        }
        state.playbackError?.let { ErrorMessage(it) { vm.toggle() } }
    }
}

@Composable
private fun LyricsPanel(vm: MusicViewModel, state: MusicState, modifier: Modifier, onBlank: () -> Unit = {}, onArtwork: () -> Unit = {}) {
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    Box(modifier, contentAlignment = Alignment.Center) {
        when {
            state.lyricsLoading && state.lyrics.lines.isEmpty() -> LyricsSkeleton()
            state.lyricsLoading -> {
                LyricViewport(state.lyrics, state.position, vm::seek, onBlank, Modifier.fillMaxSize(), onArtwork,
                    followDelayMs = preferences.lyricFollowSeconds * 1_000L)
                LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
            state.lyricsError != null -> Text(state.lyricsError, color = Muted)
            state.lyrics.lines.isEmpty() -> Text("暂无歌词", color = Muted)
            else -> LyricViewport(state.lyrics, state.position, vm::seek, onBlank, Modifier.fillMaxSize(), onArtwork,
                followDelayMs = preferences.lyricFollowSeconds * 1_000L)
        }
    }
}

@Composable
private fun ErrorMessage(message: String, retry: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { androidx.compose.foundation.text.selection.SelectionContainer(Modifier.weight(1f)) { Text(message, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }; TextButton(retry) { Text("重试") } }
}
@Composable
private fun NameDialog(title: String, initial: String, dismiss: () -> Unit, save: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { OutlinedTextField(name, { name = it.take(100) }, label = { Text("歌单名称") }, singleLine = true) },
        confirmButton = { TextButton({ save(name.trim()) }, enabled = name.isNotBlank()) { Text("保存") } }, dismissButton = { TextButton(dismiss) { Text("取消") } })
}
