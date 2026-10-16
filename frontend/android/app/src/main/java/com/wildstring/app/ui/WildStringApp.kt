@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import coil.request.ImageRequest
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.delay
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.activity.compose.LocalActivity
import androidx.core.view.WindowCompat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.Player
import coil.compose.AsyncImage
import com.wildstring.app.BuildConfig
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.launch

private val Accent: Color @Composable get() = MaterialTheme.colorScheme.primary
private val Background: Color @Composable get() = MaterialTheme.colorScheme.background
private val Muted: Color @Composable get() = MaterialTheme.colorScheme.onSurfaceVariant
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
        LocalTactileFeedback provides rememberTactileFeedback { model.settings.state.value.haptics }) {
        MaterialTheme(colorScheme = if (preferences.redCloth) redColors else if (dark) classicDarkColors else classicLightColors) {
            Surface(Modifier.fillMaxSize().testTag(if (preferences.redCloth) "appearance-red-cloth" else if (dark) "appearance-dark" else "appearance-light")) {
                Crossfade(state.connected, animationSpec = tween(220), label = "connection") { connected ->
                    if (!connected) ConnectionScreen(state, model::connect) else LibraryApp(model, state)
                }
            }
        }
    }
}

@Composable
fun ConnectionScreen(state: MusicState, connect: (String, String, String, Boolean) -> Unit) {
    var server by rememberSaveable { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var localHttp by rememberSaveable { mutableStateOf(state.localHttp) }
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.size(64.dp), tint = Color.Unspecified)
            Text("野弦", fontSize = 32.sp, fontWeight = FontWeight.Medium)
            Text("连接自己的音乐收藏", color = Muted)
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
    val rotation = rememberSaveable(saver = PlaybackRotation.Saver) { PlaybackRotation() }
    var expanded by rememberSaveable { mutableStateOf(false) }
    var playerFromSettings by rememberSaveable { mutableStateOf(false) }
    var lyrics by rememberSaveable { mutableStateOf(false) }
    var queue by rememberSaveable { mutableStateOf(false) }
    var settings by rememberSaveable { mutableStateOf(false) }
    var createPlaylist by remember { mutableStateOf(false) }
    var actions by remember { mutableStateOf<Track?>(null) }
    var playlistChoices by remember { mutableStateOf<List<Playlist>?>(null) }
    var chooseTrack by remember { mutableStateOf<Track?>(null) }
    var localError by remember { mutableStateOf<String?>(null) }
    fun collapsePlayer() {
        expanded = false
        if (playerFromSettings) { settings = true; playerFromSettings = false }
    }
    val scope = rememberCoroutineScope()
    val mutationSnackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.error, state.mutationMessage) { (state.error ?: state.mutationMessage)?.let { mutationSnackbar.showSnackbar(it) } }
    val savedPages = rememberSaveableStateHolder()
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
                onAdd = { actions = state.current })
        } else {
            Row(Modifier.fillMaxSize()) {
                if (rail) NavigationRail(windowInsets = WindowInsets(0, 0, 0, 0), modifier = Modifier.testTag("navigation-rail")) {
                    Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.padding(vertical = 24.dp).size(36.dp), tint = Color.Unspecified)
                    RailItems(state, vm)
                }
                Scaffold(
                    contentWindowInsets = WindowInsets(0, 0, 0, 0),
                    topBar = { CatalogTopBar(state, vm::back, { vm.load() }, { settings = true }, compact = compact || state.tab == "search") },
                    bottomBar = { Column {
                        if (state.current != null) MiniPlayer(vm, state, onQueue = { queue = true }) { playerFromSettings = false; expanded = true; lyrics = false; queue = false }
                        if (!rail) NavigationBar(windowInsets = WindowInsets(0, 0, 0, 0), modifier = Modifier.testTag("bottom-navigation")) { BottomItems(state, vm) }
                    } },
                ) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding)) {
                        if (state.tab == "library" && state.collection == null) LibraryTabs(state.kind, vm::kind)
                        if (state.tab == "search" && state.collection == null && state.kind != "recent") CatalogSearch(state.query, vm::search)
                        if (state.tab == "mine" && state.collection == null && state.kind != "recent") {
                            PersonalHeader(state, { vm.recent() }, compact = compact)
                            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("我的歌单", style = MaterialTheme.typography.titleMedium)
                                IconButton({ createPlaylist = true }) { Icon(Icons.Default.Add, "新建歌单") }
                            }
                        }
                        state.error?.let { ErrorMessage(it, vm::load) }
                        state.mutationMessage?.let { Text(it, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall) }
                        if (state.offline) Text("网络暂不可用 · 显示本机缓存", color = Muted, fontSize = 12.sp, modifier = Modifier.padding(vertical = 6.dp))
                        // Fixed height avoids moving the entire list when a slow request becomes visible.
                        Box(Modifier.fillMaxWidth().height(4.dp)) {
                            if (delayed(state.loading, 350)) LinearProgressIndicator(Modifier.fillMaxWidth().testTag("catalog-loading"))
                        }
                        if (state.tracks.isNotEmpty() && state.kind != "discover") Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                            FilledTonalButton(tactile { vm.play(state.tracks); expanded = true; lyrics = false; queue = false }, Modifier.padding(start = 16.dp, top = 8.dp, bottom = 8.dp)) {
                                Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(6.dp)); Text(if (state.total > state.tracks.size) "播放本页" else "播放全部")
                            }
                            Text("${state.total} 首", Modifier.padding(end = 20.dp), color = Muted, fontSize = 12.sp)
                        }
                        Box(Modifier.weight(1f).padding(horizontal = if (state.kind == "discover") 0.dp else 16.dp)) {
                            savedPages.SaveableStateProvider(state.contentKey.ifBlank { "initial" }) {
                            when (state.kind) {
                                "discover" -> DiscoveryPage(vm, state, play = { index -> vm.play(state.tracks, index); expanded = true; lyrics = false; queue = false }, recent = vm::recent)
                                "albums" -> LazyVerticalGrid(GridCells.Adaptive(140.dp), modifier = Modifier.testTag("album-grid"), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
                                    items(state.albums, key = { it.id }) { album -> Column(Modifier.animateItem().clickable { vm.openAlbum(album) }) {
                                        Cover(vm, album.coverTrackId, album.title, Modifier.fillMaxWidth().aspectRatio(1f))
                                        Text(album.title, Modifier.padding(top = 9.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        Text(album.artists.joinToString(" / "), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    } }
                                }
                                "artists" -> LazyColumn { items(state.artists, key = { it.id }) { artist -> ListItem(
                                    headlineContent = { Text(artist.name) }, supportingContent = { Text("${artist.trackCount} 首") },
                                    leadingContent = { Cover(vm, artist.coverTrackId, artist.name, Modifier.size(48.dp)) }, modifier = Modifier.animateItem().clickable { vm.openArtist(artist) }) } }
                                "playlists" -> LazyColumn { items(state.playlists, key = { it.id }) { playlist -> ListItem(
                                    headlineContent = { Text(playlist.name) }, supportingContent = { Text("${playlist.trackCount} 首${if (playlist.kind == "smart") " · 规则歌单" else ""}") },
                                    leadingContent = { Cover(vm, playlist.coverTrackId, playlist.name, Modifier.size(48.dp)) }, modifier = Modifier.animateItem().clickable { vm.openPlaylist(playlist) }) } }
                                else -> LazyColumn { items(state.tracks, key = { it.id }) { track -> TrackRow(vm, track, { vm.play(state.tracks, state.tracks.indexOf(track)); expanded = true }, { actions = track }) } }
                            }
                            }
                            if (state.kind != "discover" && !state.loading && state.total == 0 && state.error == null) Text(
                                if (state.query.isNotBlank()) "没有找到匹配的音乐" else if (state.kind == "playlists") "还没有歌单" else "这里还没有音乐，请先在网页端导入曲库。",
                                Modifier.align(Alignment.Center).padding(24.dp), color = Muted)
                        }
                        if (state.kind != "discover" && state.total > 50) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            IconButton({ vm.page(-1) }, enabled = state.offset > 0 && !state.loading) { Icon(Icons.Default.ChevronLeft, "上一页") }
                            Text("${state.offset + 1}–${minOf(state.offset + 50, state.total)} / ${state.total}", fontSize = 12.sp, color = Muted)
                            IconButton({ vm.page(1) }, enabled = state.offset + 50 < state.total && !state.loading) { Icon(Icons.Default.ChevronRight, "下一页") }
                        }
                    }
                }
            }
        }
        }
        if (queue && ((!wide && !landscape) || !expanded)) ModalBottomSheet(onDismissRequest = { queue = false }) { QueuePanel(vm, state, Modifier.fillMaxWidth().heightIn(max = 560.dp)) }
    }
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.BottomCenter) { SnackbarHost(mutationSnackbar, Modifier.padding(16.dp)) }
    if (createPlaylist) NameDialog("新建歌单", "", { createPlaylist = false }) { vm.createPlaylist(it); createPlaylist = false }
    actions?.let { track -> ModalBottomSheet(onDismissRequest = { actions = null }) {
        Text(track.title, Modifier.padding(24.dp), style = MaterialTheme.typography.titleLarge)
        TextButton(tactile { vm.addToQueue(track, true); actions = null }, Modifier.fillMaxWidth()) { Text("下一首播放") }
        TextButton(tactile { vm.addToQueue(track); actions = null }, Modifier.fillMaxWidth()) { Text("加入播放队列") }
        TextButton(tactile { vm.favorite(track); actions = null }, Modifier.fillMaxWidth()) { Text(if (track.loved) "取消收藏" else "收藏") }
        TextButton({
            chooseTrack = track; actions = null
            scope.launch { try { playlistChoices = vm.playlistsForAdd() } catch (e: Exception) { localError = friendlyError(e) } }
        }, Modifier.fillMaxWidth()) { Text("加入歌单") }
        Spacer(Modifier.height(24.dp))
    } }
    playlistChoices?.let { choices -> AlertDialog(onDismissRequest = { playlistChoices = null }, title = { Text("加入歌单") }, text = {
        if (choices.isEmpty()) Text("请先创建普通歌单。") else Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            choices.forEach { p -> TextButton(tactile { chooseTrack?.let { vm.addToPlaylist(it, p) }; playlistChoices = null }) { Text(p.name) } }
        }
    }, confirmButton = { TextButton({ playlistChoices = null }) { Text("关闭") } }) }
    localError?.let { text -> AlertDialog(onDismissRequest = { localError = null }, text = { Text(text) }, confirmButton = { TextButton({ localError = null }) { Text("关闭") } }) }
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
internal fun Cover(vm: MusicViewModel, id: String?, title: String, modifier: Modifier) {
    val profile by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val fallback = painterResource(if (LocalRedCloth.current) R.drawable.ic_red_cloth else R.drawable.ic_wildstring)
    AsyncImage(model = id?.let { ImageRequest.Builder(LocalContext.current).data(vm.repository.cover(it)).memoryCacheKey("${profile}:${it}").crossfade(180).build() }, imageLoader = vm.imageLoader, contentDescription = title,
        placeholder = fallback, error = fallback, fallback = fallback,
        contentScale = ContentScale.Crop, modifier = modifier.clip(RoundedCornerShape(10.dp)))
}
@Composable
private fun TrackRow(vm: MusicViewModel, track: Track, play: () -> Unit, actions: () -> Unit) {
    ListItem(headlineContent = { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }, supportingContent = { Text(track.artist, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingContent = { Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(48.dp)) },
        trailingContent = { IconButton(actions) { Icon(Icons.Default.MoreVert, "${track.title}的操作") } }, modifier = Modifier.clickable(onClick = tactile(play)))
}
@Composable
private fun PlayerScreen(vm: MusicViewModel, input: MusicState, wide: Boolean, landscape: Boolean, lyrics: Boolean, queue: Boolean, rotation: PlaybackRotation,
    onBack: () -> Unit, onLyrics: () -> Unit, onQueue: () -> Unit, onAdd: () -> Unit) {
    val position by vm.position.collectAsStateWithLifecycle()
    val state = input.copy(position = position)
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val track = state.current ?: return
    val progress = if (state.duration > 0) state.position.toFloat() / state.duration else 0f
    val spinning = state.playing && !state.buffering && state.playbackError == null
    Box(Modifier.fillMaxSize()) {
    Column(Modifier.testTag(if (wide) "player-tablet" else if (landscape) "player-landscape" else "player-phone").fillMaxSize().padding(horizontal = if (wide) 34.dp else 20.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, if (lyrics && !wide) "返回封面" else "收起播放器") }
            Text(track.album ?: "正在播放", color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 16.dp))
            IconButton(vm::refreshLyrics) { Icon(Icons.Default.Refresh, "刷新歌词") }
            IconButton(onAdd) { Icon(Icons.Default.MoreVert, "当前歌曲操作") }
        }
        if (landscape) Row(Modifier.weight(1f).fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight().testTag("player-visual-stage").pointerInput(onLyrics) {
                detectTapGestures { onLyrics() }
            }, contentAlignment = Alignment.Center) {
                when {
                    queue -> QueuePanel(vm, state, Modifier.fillMaxSize())
                    lyrics -> LyricsPanel(vm, state, Modifier.fillMaxSize(), onLyrics)
                    else -> PlaybackVisual(vm, track, preferences.playbackStyle, spinning, true, progress, rotation,
                        Modifier.size(minOf(maxWidth, maxHeight)), onLyrics)
                }
            }
            Column(Modifier.weight(1.15f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
                PlaybackControls(vm, state, onQueue, compact = true)
            }
        } else if (wide) Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(.9f).fillMaxHeight().widthIn(max = 380.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                BoxWithConstraints(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    val visualSize = minOf(300.dp, maxWidth, maxHeight)
                    PlaybackVisual(vm, track, preferences.playbackStyle, spinning, true, progress, rotation,
                        Modifier.size(visualSize)) { if (queue) onQueue() }
                }
                Spacer(Modifier.height(20.dp)); PlaybackControls(vm, state, onQueue)
            }
            Column(Modifier.weight(1.1f).fillMaxHeight().padding(top = 24.dp, bottom = 16.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FilterChip(!queue, { if (queue) onQueue() }, label = { Text("歌词") })
                    FilterChip(queue, { if (!queue) onQueue() }, label = { Text("队列 · ${state.queue.size}") })
                }
                if (queue) QueuePanel(vm, state, Modifier.weight(1f)) else LyricsPanel(vm, state, Modifier.weight(1f))
            }
        } else {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().testTag("player-visual-stage").pointerInput(onLyrics) {
                detectTapGestures { onLyrics() }
            }, contentAlignment = Alignment.Center) {
                val visualSize = minOf(370.dp, maxWidth, maxHeight)
                Crossfade(lyrics, Modifier.fillMaxSize(), animationSpec = tween(240), label = "lyrics-cover") { showingLyrics ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (showingLyrics) LyricsPanel(vm, state, Modifier.fillMaxSize().padding(top = 8.dp, bottom = 32.dp), onLyrics)
                        else PlaybackVisual(vm, track, preferences.playbackStyle, spinning, !lyrics, progress, rotation,
                            Modifier.size(visualSize), onLyrics)
                    }
                }
            }
            PlaybackControls(vm, state, onQueue)
        }
    }
    }
}

@Composable
private fun PlaybackControls(vm: MusicViewModel, state: MusicState, onQueue: () -> Unit, compact: Boolean = false) {
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
private fun LyricsPanel(vm: MusicViewModel, state: MusicState, modifier: Modifier, onBlank: () -> Unit = {}) {
    Box(modifier, contentAlignment = Alignment.Center) {
        when {
            state.lyricsLoading -> if (delayed(state.lyricsLoading, 350)) CircularProgressIndicator()
            state.lyricsError != null -> Text(state.lyricsError, color = Muted)
            state.lyrics.lines.isEmpty() -> Text("暂无歌词", color = Muted)
            else -> LyricViewport(state.lyrics, state.position, vm::seek, onBlank, Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun ErrorMessage(message: String, retry: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(message, Modifier.weight(1f), color = MaterialTheme.colorScheme.error, fontSize = 12.sp); TextButton(retry) { Text("重试") } }
}
@Composable
private fun NameDialog(title: String, initial: String, dismiss: () -> Unit, save: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { OutlinedTextField(name, { name = it.take(100) }, label = { Text("歌单名称") }, singleLine = true) },
        confirmButton = { TextButton({ save(name.trim()) }, enabled = name.isNotBlank()) { Text("保存") } }, dismissButton = { TextButton(dismiss) { Text("取消") } })
}
