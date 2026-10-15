@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
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

private val Accent = Color(0xFFE98A6D)
private val Background = Color(0xFF191A17)
private val Muted = Color(0xFFA8AA9D)
private val colors = darkColorScheme(primary = Accent, onPrimary = Color(0xFF291E17), background = Background,
    surface = Background, surfaceVariant = Color(0xFF2B2E25), onSurface = Color(0xFFEEEAE2), onSurfaceVariant = Muted)

@Composable
fun WildStringApp(model: MusicViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    MaterialTheme(colorScheme = colors) {
        Surface(Modifier.fillMaxSize()) {
            if (!state.connected) ConnectionScreen(state, model::connect)
            else LibraryApp(model, state)
        }
    }
}

@Composable
fun ConnectionScreen(state: MusicState, connect: (String, String, String, Boolean) -> Unit) {
    var server by rememberSaveable { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf("admin") }
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
    var expanded by rememberSaveable { mutableStateOf(false) }
    var lyrics by rememberSaveable { mutableStateOf(false) }
    var queue by rememberSaveable { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    var createPlaylist by remember { mutableStateOf(false) }
    var actions by remember { mutableStateOf<Track?>(null) }
    var playlistChoices by remember { mutableStateOf<List<Playlist>?>(null) }
    var chooseTrack by remember { mutableStateOf<Track?>(null) }
    var localError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
        val wide = maxWidth >= 840.dp && maxHeight >= 480.dp
        val rail = maxWidth >= 600.dp && maxHeight >= 480.dp
        var wasWide by remember { mutableStateOf(wide) }
        LaunchedEffect(wide) { if (wasWide && !wide && expanded && !queue) lyrics = true; wasWide = wide }
        BackHandler(enabled = expanded || state.collection != null || state.kind == "recent") {
            when { queue -> queue = false; lyrics && !wide -> lyrics = false; expanded -> expanded = false; else -> vm.navigate(state.tab) }
        }
        if (expanded && state.current != null) {
            PlayerScreen(vm, state, wide, lyrics, queue,
                onBack = { if (lyrics && !wide) lyrics = false else expanded = false },
                onLyrics = { lyrics = !lyrics; queue = false }, onQueue = { queue = !queue },
                onAdd = { actions = state.current })
        } else {
            Row(Modifier.fillMaxSize()) {
                if (rail) NavigationRail { Spacer(Modifier.height(40.dp)); RailItems(state, vm) }
                Scaffold(
                    topBar = { TopAppBar(title = { Column {
                        Text(if (state.tab == "library" && state.collection == null) "野弦" else state.title)
                        if (state.tab == "library" && state.collection == null) Text("WILDSTRING", fontSize = 10.sp, color = Muted, letterSpacing = 2.sp)
                    } }, navigationIcon = { if (state.collection != null || state.kind == "recent") IconButton({ vm.navigate(state.tab) }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回曲库") } }, actions = {
                        IconButton({ vm.load() }) { Icon(Icons.Default.Refresh, "刷新曲库") }
                        IconButton({ settings = true }) { Icon(Icons.Default.Settings, "设置") }
                    }) },
                    bottomBar = { Column {
                        if (state.current != null) MiniPlayer(vm, state) { expanded = true; lyrics = false; queue = false }
                        if (!rail) NavigationBar { BottomItems(state, vm) }
                    } },
                ) { padding ->
                    Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 16.dp)) {
                        if (state.tab == "library" && state.collection == null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf("albums" to "专辑", "tracks" to "歌曲", "artists" to "艺人").forEach { (kind, label) ->
                                FilterChip(state.kind == kind, { vm.kind(kind) }, label = { Text(label) })
                            }
                        }
                        if (state.tab == "search") OutlinedTextField(state.query, vm::search, Modifier.fillMaxWidth().padding(bottom = 12.dp), placeholder = { Text("搜索歌曲、艺人或专辑") }, singleLine = true, leadingIcon = { Icon(Icons.Default.Search, null) })
                        if (state.tab == "mine" && state.collection == null && state.kind != "recent") Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            TextButton({ vm.recent() }) { Text("最近听过") }
                            TextButton({ createPlaylist = true }) { Icon(Icons.Default.Add, null); Text("新建歌单") }
                        }
                        state.error?.let { ErrorMessage(it, vm::load) }
                        if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                        if (state.tracks.isNotEmpty()) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                            TextButton({ vm.play(state.tracks); expanded = true; lyrics = false; queue = false }) { Icon(Icons.Default.PlayArrow, null); Text(if (state.total > state.tracks.size) "播放本页" else "播放全部") }
                            Text("${state.total} 首", color = Muted, fontSize = 12.sp)
                        }
                        Box(Modifier.weight(1f)) {
                            when (state.kind) {
                                "albums" -> LazyVerticalGrid(GridCells.Adaptive(140.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalArrangement = Arrangement.spacedBy(18.dp), contentPadding = PaddingValues(vertical = 12.dp)) {
                                    items(state.albums, key = { it.id }) { album -> Column(Modifier.clickable { vm.openAlbum(album) }) {
                                        Cover(vm, album.coverTrackId, album.title, Modifier.fillMaxWidth().aspectRatio(1f))
                                        Text(album.title, Modifier.padding(top = 9.dp), maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        Text(album.artists.joinToString(" / "), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    } }
                                }
                                "artists" -> LazyColumn { items(state.artists, key = { it.id }) { artist -> ListItem(
                                    headlineContent = { Text(artist.name) }, supportingContent = { Text("${artist.trackCount} 首") },
                                    leadingContent = { Cover(vm, artist.coverTrackId, artist.name, Modifier.size(48.dp)) }, modifier = Modifier.clickable { vm.openArtist(artist) }) } }
                                "playlists" -> LazyColumn { items(state.playlists, key = { it.id }) { playlist -> ListItem(
                                    headlineContent = { Text(playlist.name) }, supportingContent = { Text("${playlist.trackCount} 首${if (playlist.kind == "smart") " · 规则歌单" else ""}") },
                                    leadingContent = { Cover(vm, playlist.coverTrackId, playlist.name, Modifier.size(48.dp)) }, modifier = Modifier.clickable { vm.openPlaylist(playlist) }) } }
                                else -> LazyColumn { items(state.tracks, key = { it.id }) { track -> TrackRow(vm, track, { vm.play(state.tracks, state.tracks.indexOf(track)); expanded = true }, { actions = track }) } }
                            }
                            if (!state.loading && state.total == 0 && state.error == null) Text(
                                if (state.query.isNotBlank()) "没有找到匹配的音乐" else if (state.kind == "playlists") "还没有歌单" else "这里还没有音乐，请先在网页端导入曲库。",
                                Modifier.align(Alignment.Center).padding(24.dp), color = Muted)
                        }
                        if (state.total > 50) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            TextButton({ vm.page(-1) }, enabled = state.offset > 0 && !state.loading) { Text("上一页") }
                            Text("${state.offset + 1}–${minOf(state.offset + 50, state.total)} / ${state.total}", fontSize = 12.sp, color = Muted)
                            TextButton({ vm.page(1) }, enabled = state.offset + 50 < state.total && !state.loading) { Text("下一页") }
                        }
                    }
                }
            }
        }
        if (queue && (!wide || !expanded)) ModalBottomSheet(onDismissRequest = { queue = false }) { QueuePanel(vm, state, Modifier.fillMaxWidth().heightIn(max = 560.dp)) }
    }
    if (settings) AlertDialog(onDismissRequest = { settings = false }, title = { Text("连接与设置") }, text = { Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(state.server); Text("野弦 ${BuildConfig.VERSION_NAME}", color = Muted); Text("收藏与歌单保存在服务器。本机仅保留会话和播放队列。", fontSize = 13.sp, color = Muted)
    } }, confirmButton = { TextButton({ settings = false; vm.logout() }) { Text("退出登录 / 更换服务器") } }, dismissButton = { TextButton({ settings = false }) { Text("关闭") } })
    if (createPlaylist) NameDialog("新建歌单", "", { createPlaylist = false }) { vm.createPlaylist(it); createPlaylist = false }
    actions?.let { track -> ModalBottomSheet(onDismissRequest = { actions = null }) {
        Text(track.title, Modifier.padding(24.dp), style = MaterialTheme.typography.titleLarge)
        TextButton({ vm.addToQueue(track, true); actions = null }, Modifier.fillMaxWidth()) { Text("下一首播放") }
        TextButton({ vm.addToQueue(track); actions = null }, Modifier.fillMaxWidth()) { Text("加入播放队列") }
        TextButton({ vm.favorite(track); actions = null }, Modifier.fillMaxWidth()) { Text(if (track.loved) "取消收藏" else "收藏") }
        TextButton({
            chooseTrack = track; actions = null
            scope.launch { try { playlistChoices = vm.playlistsForAdd() } catch (e: Exception) { localError = friendlyError(e) } }
        }, Modifier.fillMaxWidth()) { Text("加入歌单") }
        Spacer(Modifier.height(24.dp))
    } }
    playlistChoices?.let { choices -> AlertDialog(onDismissRequest = { playlistChoices = null }, title = { Text("加入歌单") }, text = {
        if (choices.isEmpty()) Text("请先创建普通歌单。") else Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
            choices.forEach { p -> TextButton({ chooseTrack?.let { vm.addToPlaylist(it, p) }; playlistChoices = null }) { Text(p.name) } }
        }
    }, confirmButton = { TextButton({ playlistChoices = null }) { Text("关闭") } }) }
    localError?.let { text -> AlertDialog(onDismissRequest = { localError = null }, text = { Text(text) }, confirmButton = { TextButton({ localError = null }) { Text("关闭") } }) }
}

@Composable
private fun RailItems(state: MusicState, vm: MusicViewModel) {
    listOf(Triple("library", "曲库", Icons.Default.LibraryMusic), Triple("search", "找歌", Icons.Default.Search), Triple("mine", "我的", Icons.Default.Person)).forEach { (id, label, icon) ->
        NavigationRailItem(state.tab == id, { vm.navigate(id) }, icon = { Icon(icon, label) }, label = { Text(label) })
    }
}
@Composable
private fun RowScope.BottomItems(state: MusicState, vm: MusicViewModel) {
    listOf(Triple("library", "曲库", Icons.Default.LibraryMusic), Triple("search", "找歌", Icons.Default.Search), Triple("mine", "我的", Icons.Default.Person)).forEach { (id, label, icon) ->
        NavigationBarItem(state.tab == id, { vm.navigate(id) }, icon = { Icon(icon, label) }, label = { Text(label) })
    }
}

@Composable
private fun Cover(vm: MusicViewModel, id: String?, title: String, modifier: Modifier) {
    AsyncImage(model = id?.let { vm.repository.cover(it) }, imageLoader = vm.imageLoader, contentDescription = title,
        placeholder = painterResource(R.drawable.ic_wildstring), error = painterResource(R.drawable.ic_wildstring), fallback = painterResource(R.drawable.ic_wildstring),
        contentScale = ContentScale.Crop, modifier = modifier.clip(RoundedCornerShape(10.dp)))
}
@Composable
private fun TrackRow(vm: MusicViewModel, track: Track, play: () -> Unit, actions: () -> Unit) {
    ListItem(headlineContent = { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis) }, supportingContent = { Text(track.artist, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingContent = { Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(48.dp)) },
        trailingContent = { IconButton(actions) { Icon(Icons.Default.MoreVert, "${track.title}的操作") } }, modifier = Modifier.clickable(onClick = play))
}
@Composable
private fun MiniPlayer(vm: MusicViewModel, state: MusicState, expand: () -> Unit) {
    val track = state.current ?: return
    Surface(Modifier.padding(horizontal = 12.dp, vertical = 7.dp).fillMaxWidth(), shape = RoundedCornerShape(13.dp), color = Color(0xFF2B2E25)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).clickable(onClick = expand).padding(9.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.size(42.dp))
                Column(Modifier.weight(1f)) { Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis); Text(track.artist, color = Muted, fontSize = 11.sp, maxLines = 1) }
            }
            IconButton(vm::toggle) { Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "暂停" else "播放") }
        }
    }
}

@Composable
private fun PlayerScreen(vm: MusicViewModel, state: MusicState, wide: Boolean, lyrics: Boolean, queue: Boolean,
    onBack: () -> Unit, onLyrics: () -> Unit, onQueue: () -> Unit, onAdd: () -> Unit) {
    val track = state.current ?: return
    Column(Modifier.testTag(if (wide) "player-tablet" else "player-phone").fillMaxSize().background(Brush.radialGradient(listOf(Color(0xFF343F31), Background))).padding(horizontal = if (wide) 34.dp else 20.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, if (lyrics && !wide) "返回封面" else "收起播放器") }
            Text(track.album ?: "正在播放", color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(horizontal = 16.dp))
            IconButton(onAdd) { Icon(Icons.Default.MoreVert, "当前歌曲操作") }
        }
        if (wide) Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(.9f).widthIn(max = 380.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.widthIn(max = 300.dp).fillMaxWidth().aspectRatio(1f).clickable { if (queue) onQueue() })
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
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                if (lyrics) LyricsPanel(vm, state, Modifier.fillMaxSize())
                else Cover(vm, track.id.takeIf { track.hasCover }, track.title, Modifier.widthIn(max = 370.dp).fillMaxWidth().aspectRatio(1f).clickable(onClick = onLyrics))
            }
            PlaybackControls(vm, state, onQueue)
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.Center) {
                TextButton(onLyrics) { Text(if (lyrics) "返回封面" else "歌词") }
                TextButton(onQueue) { Text("队列 · ${state.queue.size}") }
            }
        }
    }
}

@Composable
private fun PlaybackControls(vm: MusicViewModel, state: MusicState, onQueue: () -> Unit) {
    var scrub by remember { mutableStateOf<Float?>(null) }
    val track = state.current ?: return
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(track.title, fontSize = 23.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(track.artist, color = Muted, fontSize = 13.sp, maxLines = 2)
            }
            IconButton({ vm.favorite(track) }) { Icon(if (track.loved) Icons.Default.Favorite else Icons.Default.FavoriteBorder, if (track.loved) "取消收藏" else "收藏", tint = if (track.loved) Accent else MaterialTheme.colorScheme.onSurface) }
        }
        Slider(value = scrub ?: state.position.coerceAtMost(state.duration).toFloat(), onValueChange = { scrub = it },
            onValueChangeFinished = { scrub?.let { vm.seek(it.toLong()) }; scrub = null }, valueRange = 0f..state.duration.coerceAtLeast(1).toFloat(), enabled = state.duration > 0)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text(formatTime(scrub?.toLong() ?: state.position), color = Muted, fontSize = 11.sp); Text(formatTime(state.duration), color = Muted, fontSize = 11.sp) }
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            val modeIcon = if (state.shuffle) Icons.Default.Shuffle else if (state.repeatMode == Player.REPEAT_MODE_ONE) Icons.Default.RepeatOne else Icons.Default.Repeat
            IconButton(vm::cycleMode) { Icon(modeIcon, "切换播放模式", tint = if (state.shuffle || state.repeatMode != Player.REPEAT_MODE_OFF) Accent else Muted) }
            IconButton(vm::previous) { Icon(Icons.Default.SkipPrevious, "上一首", Modifier.size(30.dp)) }
            FilledIconButton(vm::toggle, Modifier.size(64.dp)) { if (state.buffering) CircularProgressIndicator(Modifier.size(25.dp), strokeWidth = 2.dp) else Icon(if (state.playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (state.playing) "暂停" else "播放", Modifier.size(34.dp)) }
            IconButton(vm::next) { Icon(Icons.Default.SkipNext, "下一首", Modifier.size(30.dp)) }
            IconButton(onQueue) { Icon(Icons.AutoMirrored.Filled.QueueMusic, "播放队列") }
        }
        state.playbackError?.let { ErrorMessage(it) { vm.toggle() } }
    }
}

@Composable
private fun LyricsPanel(vm: MusicViewModel, state: MusicState, modifier: Modifier) {
    val list = rememberLazyListState()
    var follow by remember(state.current?.id) { mutableStateOf(true) }
    val lines = state.lyrics.lines
    val active = if (state.lyrics.kind == "synced") lines.indexOfLast { (it.timeMs ?: Long.MAX_VALUE) <= state.position } else -1
    LaunchedEffect(list) { list.interactionSource.interactions.collect { if (it is DragInteraction.Start) follow = false } }
    LaunchedEffect(active, follow) { if (follow && active >= 0 && lines.isNotEmpty()) list.animateScrollToItem(active) }
    Column(modifier) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            when {
                state.lyricsLoading -> CircularProgressIndicator()
                state.lyricsError != null -> Text(state.lyricsError, color = Muted)
                lines.isEmpty() -> Text("暂无歌词", color = Muted)
                else -> LazyColumn(state = list, contentPadding = PaddingValues(vertical = 100.dp), modifier = Modifier.fillMaxSize()) {
                    items(lines.size) { index -> val line = lines[index]
                        Text(line.text, Modifier.fillMaxWidth().clickable(enabled = line.timeMs != null) { vm.seek(line.timeMs ?: 0); follow = true }.padding(vertical = 16.dp, horizontal = 4.dp),
                            fontSize = 25.sp, lineHeight = 36.sp, fontWeight = if (active == index) FontWeight.Medium else FontWeight.Normal,
                            color = if (state.lyrics.kind == "plain" || active == index) Color(0xFFEEEFE5) else Color(0xFF869180))
                    }
                }
            }
        }
        if (!follow && state.lyrics.kind == "synced") TextButton({ follow = true }, Modifier.align(Alignment.CenterHorizontally)) { Text("回到当前歌词") }
    }
}

@Composable
private fun QueuePanel(vm: MusicViewModel, state: MusicState, modifier: Modifier) {
    Column(modifier) {
        Text("播放队列 · ${state.queue.size}", Modifier.padding(16.dp), style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.weight(1f, fill = false)) {
            items(state.queue, key = { it.entryId }) { row -> Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).clickable { vm.playQueue(row.index) }.padding(vertical = 12.dp, horizontal = 16.dp)) {
                    Text(row.title, color = if (row.entryId == state.entryId) Accent else MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(row.artist, color = Muted, fontSize = 11.sp, maxLines = 1)
                }
                IconButton({ vm.moveQueue(row.index, -1) }, enabled = row.index > 0) { Icon(Icons.Default.KeyboardArrowUp, "向前移动") }
                IconButton({ vm.moveQueue(row.index, 1) }, enabled = row.index < state.queue.lastIndex) { Icon(Icons.Default.KeyboardArrowDown, "向后移动") }
                IconButton({ vm.removeQueue(row.index) }) { Icon(Icons.Default.Close, "移除${row.title}") }
            } }
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
