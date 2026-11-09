@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.wildstring.app.ui

import androidx.compose.ui.res.stringResource
import androidx.activity.compose.BackHandler
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import coil.request.ImageRequest
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.activity.compose.LocalActivity
import androidx.core.view.WindowCompat
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.semantics.Role
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
import androidx.compose.material.icons.automirrored.filled.FactCheck
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.PlaylistAdd
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.input.pointer.util.addPointerInputChange
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.media3.common.Player
import com.google.gson.JsonObject
import coil.compose.AsyncImage
import com.wildstring.app.BuildConfig
import com.wildstring.app.R
import com.wildstring.app.data.*
import kotlinx.coroutines.Job
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
    onDragOffset: (Float, Boolean) -> Unit = { _, _ -> },
): Modifier = if (!enabled) this else pointerInput(enabled) {
    var distance = 0f
    detectHorizontalDragGestures(
        onDragStart = {
            distance = 0f
            onDragOffset(0f, false)
        },
        onHorizontalDrag = { change, amount ->
            distance += amount
            onDragOffset(distance, true)
            change.consume()
        },
        onDragEnd = {
            onDragOffset(0f, false)
            if (abs(distance) >= 72.dp.toPx()) {
                if (distance < 0) onNext() else onPrevious()
            }
        },
        onDragCancel = {
            distance = 0f
            onDragOffset(0f, false)
        },
    )
}

internal val PlayerFlingVelocity = 1100.dp

/** A vertical swipe collapses the player on downward drag or opens the queue on upward drag. */
internal fun Modifier.dismissPlayerSwipe(
    enabled: Boolean,
    onDismiss: () -> Unit,
    onDragOffset: (Float, Boolean) -> Unit = { _, _ -> },
    onThresholdCrossed: () -> Unit = {},
    onSwipeUp: (() -> Unit)? = null,
): Modifier = if (!enabled) this else pointerInput(enabled, onSwipeUp != null) {
    var distance = 0f
    var crossedDown = false
    var crossedUp = false
    val threshold = 52.dp.toPx()
    val flingDistance = 16.dp.toPx()
    val flingVelocity = PlayerFlingVelocity.toPx()
    val velocity = VelocityTracker()
    detectVerticalDragGestures(
        onDragStart = {
            distance = 0f
            crossedDown = false
            crossedUp = false
            velocity.resetTracking()
            onDragOffset(0f, false)
        },
        onVerticalDrag = { change, amount ->
            velocity.addPointerInputChange(change)
            distance += amount
            if (distance > 0f) {
                onDragOffset(distance, true)
                if (distance >= threshold && !crossedDown) {
                    crossedDown = true
                    onThresholdCrossed()
                }
            } else if (onSwipeUp != null && distance < 0f) {
                onDragOffset(distance, true)
                if (distance <= -threshold && !crossedUp) {
                    crossedUp = true
                    onThresholdCrossed()
                }
            } else {
                onDragOffset(0f, false)
            }
            change.consume()
        },
        onDragEnd = {
            // A quick flick counts as much as a long pull, so short confident swipes are not ignored.
            val speed = velocity.calculateVelocity().y
            when {
                distance >= threshold || (distance >= flingDistance && speed >= flingVelocity) -> onDismiss()
                onSwipeUp != null && (distance <= -threshold || (distance <= -flingDistance && speed <= -flingVelocity)) -> {
                    onDragOffset(0f, false)
                    onSwipeUp()
                }
                else -> onDragOffset(0f, false)
            }
        },
        onDragCancel = {
            distance = 0f
            onDragOffset(0f, false)
        },
    )
}
internal val classicDarkColors = darkColorScheme(
    primary = Color(0xFFE98A6D), onPrimary = Color(0xFF291E17), primaryContainer = Color(0xFF43302A), onPrimaryContainer = Color(0xFFFFDBCC),
    secondary = Color(0xFFBCC6B0), onSecondary = Color(0xFF263020), secondaryContainer = Color(0xFF2E2924), onSecondaryContainer = Color(0xFFE3DDD0),
    outline = Color(0xFF9A9288), outlineVariant = Color(0xFF3A352F),
    background = Color(0xFF181614), surface = Color(0xFF181614),
    surfaceVariant = Color(0xFF2E2924), onSurface = Color(0xFFE8E3D9), onSurfaceVariant = Color(0xFFAAA59A),
    surfaceContainerLowest = Color(0xFF131110), surfaceContainerLow = Color(0xFF1D1A18),
    surfaceContainer = Color(0xFF211E1B), surfaceContainerHigh = Color(0xFF2A2622),
    surfaceContainerHighest = Color(0xFF34302A),
)
@Composable
fun WildStringApp(model: MusicViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    var servers by rememberSaveable { mutableStateOf(false) }
    val preferences by model.settings.state.collectAsStateWithLifecycle()
    val systemDark = isSystemInDarkTheme()
    val dark = when (preferences.appearance) { "light" -> false; "dark" -> true; else -> systemDark }
    val window = LocalActivity.current?.window
    val view = androidx.compose.ui.platform.LocalView.current
    SideEffect { window?.let { WindowCompat.getInsetsController(it, view).apply {
        isAppearanceLightStatusBars = !dark
        isAppearanceLightNavigationBars = !dark
    } } }
    CompositionLocalProvider(LocalDarkAppearance provides dark,
        LocalSongListSize provides preferences.songListSize,
        LocalTactileFeedback provides rememberTactileFeedback { model.settings.state.value.haptics }) {
        MaterialTheme(colorScheme = if (dark) classicDarkColors else classicLightColors) {
            Surface(Modifier.fillMaxSize().testTag(if (dark) "appearance-dark" else "appearance-light")) {
                key(state.serverSelection) { Crossfade(state.connected, animationSpec = tween(220), label = "connection") { connected ->
                    if (!connected) {
                        val routes by model.repository.session.routes.collectAsStateWithLifecycle()
                        ConnectionScreen(state, model::connect, routes = routes) { servers = true }
                    } else {
                        LibraryApp(model, state)
                    }
                } }
                com.wildstring.app.update.UpdatePrompt()
                LaunchedEffect(state.playing, state.handoff?.version) {
                    if (state.playing && state.current != null && state.handoff != null) model.dismissHandoff()
                }
                AnimatedVisibility(
                    visible = state.handoff != null && !state.playing,
                    enter = fadeIn(tween(260, easing = FastOutSlowInEasing)) +
                        scaleIn(
                            initialScale = 0.86f,
                            transformOrigin = TransformOrigin(0.5f, 1f),
                            animationSpec = tween(260, easing = FastOutSlowInEasing),
                        ) +
                        slideInVertically(
                            animationSpec = tween(260, easing = FastOutSlowInEasing),
                        ) { it / 2 },
                    exit = fadeOut(tween(240, easing = FastOutSlowInEasing)) +
                        scaleOut(
                            targetScale = 0.80f,
                            transformOrigin = TransformOrigin(0.5f, 1f),
                            animationSpec = tween(240, easing = FastOutSlowInEasing),
                        ) +
                        slideOutVertically(
                            animationSpec = tween(240, easing = FastOutSlowInEasing),
                        ) { it / 2 },
                ) {
                    state.handoff?.let { saved ->
                        val action = remember(saved.version) { FeatureAction() }; val scope = rememberCoroutineScope()
                        val countdown = remember(saved.version) { Animatable(1f) }
                        val navBarBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                        val isTablet = LocalConfiguration.current.screenWidthDp >= 600
                        val miniVisible = state.current != null && (state.tab != "assistant" || state.playing || state.buffering)
                        val dockHeight = (if (miniVisible) 62.dp else 0.dp) + (if (!isTablet) 80.dp else 0.dp)
                        val assistantComposer = if (state.tab == "assistant") 72.dp else 0.dp
                        val bottomPad = navBarBottom + dockHeight + assistantComposer + 12.dp
                        Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal)).padding(horizontal = 16.dp).padding(bottom = bottomPad), contentAlignment = Alignment.BottomCenter) {
                            Surface(
                                Modifier.widthIn(max = 380.dp).fillMaxWidth().testTag("playback-handoff-notice"),
                                shape = RoundedCornerShape(20.dp),
                                color = MaterialTheme.colorScheme.surfaceContainerHighest,
                                border = BorderStroke(0.5.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f)),
                                tonalElevation = 3.dp,
                                shadowElevation = 6.dp,
                            ) {
                                Row(
                                    Modifier.padding(start = 14.dp, end = 10.dp, top = 6.dp, bottom = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Icon(Icons.Default.Devices, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                                    Column(Modifier.weight(1f)) {
                                        Text(stringResource(R.string.handoff_available), style = MaterialTheme.typography.labelLarge)
                                        Text(
                                            stringResource(R.string.handoff_position, saved.index + 1, saved.trackIds.size, formatTime(saved.positionMs)),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    Button(
                                        onClick = { scope.launch { action.run { model.acceptHandoff() } } },
                                        enabled = !action.busy,
                                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 2.dp),
                                        modifier = Modifier.height(32.dp),
                                    ) {
                                        Text(stringResource(R.string.load), style = MaterialTheme.typography.labelMedium)
                                    }
                                    Box(
                                        modifier = Modifier.size(28.dp),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        val trackColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f)
                                        val progressColor = MaterialTheme.colorScheme.primary
                                        Canvas(Modifier.fillMaxSize().padding(2.dp)) {
                                            val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round)
                                            drawCircle(color = trackColor, style = stroke)
                                            if (countdown.value > 0.002f) {
                                                drawArc(
                                                    color = progressColor,
                                                    startAngle = -90f,
                                                    sweepAngle = 360f * countdown.value,
                                                    useCenter = false,
                                                    style = stroke,
                                                )
                                            }
                                        }
                                        IconButton(
                                            onClick = model::dismissHandoff,
                                            enabled = !action.busy,
                                            modifier = Modifier.fillMaxSize(),
                                        ) {
                                            Icon(
                                                Icons.Default.Close,
                                                contentDescription = stringResource(R.string.close),
                                                modifier = Modifier.size(13.dp),
                                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
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
fun ConnectionScreen(state: MusicState, connect: (String, String, String, Boolean) -> Unit, routes: List<com.wildstring.app.data.ServerRoute> = emptyList(), manageServers: () -> Unit = {}) {
    var server by rememberSaveable(state.serverSelection) { mutableStateOf(state.server) }
    var username by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var localHttp by rememberSaveable { mutableStateOf(state.localHttp) }
    var insecureHttpWarning by rememberSaveable { mutableStateOf(false) }
    fun submit() {
        if (server.trim().startsWith("http://", ignoreCase = true) && !localHttp) {
            insecureHttpWarning = true
        } else {
            connect(server, username, password, localHttp)
        }
    }
    Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().verticalScroll(rememberScrollState()).padding(28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.size(64.dp), tint = Color.Unspecified)
            Text(stringResource(R.string.brand_name), fontSize = 32.sp, fontWeight = FontWeight.Medium)
            Text(stringResource(R.string.connect_collection), color = Muted)
            TextButton(manageServers, Modifier.testTag("connection-servers")) { Icon(Icons.Default.Dns, null); Spacer(Modifier.width(8.dp)); Text(stringResource(R.string.settings_servers)) }
            if (routes.size > 1) {
                Text(stringResource(R.string.ws_app_choose_saved_route), style = MaterialTheme.typography.bodySmall)
                routes.forEach { route -> TextButton({ server = route.url; localHttp = route.allowHttp; password = "" }, enabled = !state.connecting) { Text(route.name + " · " + route.url) } }
            }
            OutlinedTextField(server, { server = it; localHttp = false }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.server_address)) }, placeholder = { Text("music.your-domain.com") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !state.connecting)
            OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.account)) }, singleLine = true, enabled = !state.connecting)
            OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.password)) }, visualTransformation = PasswordVisualTransformation(), singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), enabled = !state.connecting)
            Row(Modifier.fillMaxWidth().clickable(enabled = !state.connecting) { localHttp = !localHttp }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(localHttp, { localHttp = it }, enabled = !state.connecting)
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.server_allow_http), fontSize = 13.sp)
            }
            state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Button(onClick = ::submit, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = !state.connecting && server.isNotBlank() && username.isNotBlank()) {
                if (state.connecting) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = LocalContentColor.current)
                else Text(stringResource(R.string.connect_sign_in))
            }
            Text(stringResource(R.string.connection_protocol_hint), color = Muted, fontSize = 12.sp)
        }
    }
    if (insecureHttpWarning) AlertDialog(
        onDismissRequest = { insecureHttpWarning = false },
        title = { Text(stringResource(R.string.http_warning_title)) },
        text = { Text(stringResource(R.string.http_warning_message)) },
        confirmButton = { TextButton({ insecureHttpWarning = false; localHttp = true; connect(server, username, password, true) }) { Text(stringResource(R.string.http_warning_confirm)) } },
        dismissButton = { TextButton({ insecureHttpWarning = false }) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun LibraryApp(vm: MusicViewModel, state: MusicState) {
    val resources = androidx.compose.ui.platform.LocalResources.current
    val libraryLifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(libraryLifecycle, state.serverSelection) {
        libraryLifecycle.repeatOnLifecycle(androidx.lifecycle.Lifecycle.State.STARTED) {
            vm.refreshLibraries()
            while (true) { kotlinx.coroutines.delay(30_000); vm.refreshLibraries() }
        }
    }
    val inbox by vm.agent.inbox.collectAsStateWithLifecycle()
    val feedback = LocalTactileFeedback.current
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
    var playerReturnFeature by remember { mutableStateOf<String?>(null) }
    var featureTrack by remember { mutableStateOf<Track?>(null) }
    var featurePlaylist by remember { mutableStateOf<Playlist?>(null) }
    var featureBatchId by remember { mutableStateOf<String?>(null) }
    var sleepDialog by remember { mutableStateOf(false) }
    var refreshAlbum by remember { mutableStateOf<String?>(null) }
    var lyricScanAlbum by remember { mutableStateOf<String?>(null) }
    var deletingPlaylist by remember { mutableStateOf<Playlist?>(null) }
    var playlistActions by remember { mutableStateOf<Playlist?>(null) }
    var albumActions by remember { mutableStateOf<Album?>(null) }
    val playlistAction = remember { FeatureAction() }
    var actions by remember { mutableStateOf<Track?>(null) }
    var playlistChoices by remember { mutableStateOf<List<Playlist>?>(null) }
    var albumPlaylistTracks by remember { mutableStateOf<List<Track>?>(null) }
    var featureAlbumId by remember { mutableStateOf<String?>(null) }
    var chooseTrack by remember { mutableStateOf<Track?>(null) }
    var createAndAddOpen by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    fun collapsePlayer() {
        vm.cancelAlbumNavigation()
        expanded = false
        queue = false
        if (state.current?.isPodcast == true) {
            lyrics = false
            settings = false
            playerFromSettings = false
            vm.openPlayingPodcast()
        } else if (playerFromSettings) settings = true
        // A player opened from a full-screen feature returns to that feature, not the catalog.
        playerReturnFeature?.let { feature = it; playerReturnFeature = null }
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
    fun openTrackArtist(name: String) {
        actions = null
        val fromPlayer = expanded
        val originalLyrics = lyrics
        val originalQueue = queue
        val originalSettings = playerFromSettings
        vm.openArtistName(name) {
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
    val context = LocalContext.current
    var crashReportOpen by rememberSaveable { mutableStateOf(false) }
    val crashDetectedMessage = stringResource(R.string.crash_detected_message)
    val crashViewAction = stringResource(R.string.crash_view_action)
    LaunchedEffect(Unit) {
        if (com.wildstring.app.diagnostics.CrashHandler.hasNewCrash(context)) {
            com.wildstring.app.diagnostics.CrashHandler.clearNewCrashFlag(context)
            val result = mutationSnackbar.showSnackbar(crashDetectedMessage, crashViewAction, duration = SnackbarDuration.Long)
            if (result == SnackbarResult.ActionPerformed) {
                crashReportOpen = true
            }
        }
    }
    val podcastCloud by vm.podcastCloud.collectAsStateWithLifecycle()
    val podcastRetry = stringResource(R.string.podcast_sync_retry)
    LaunchedEffect(state.error, state.mutationMessage, podcastCloud.syncError) {
        val syncError = podcastCloud.syncError
        val message = state.error ?: state.mutationMessage ?: syncError
        if (message != null) {
            try {
                if (syncError != null && message == syncError) {
                    val result = mutationSnackbar.showSnackbar(message, podcastRetry, duration = SnackbarDuration.Long)
                    if (result == SnackbarResult.ActionPerformed) vm.retryPodcastQueueSync()
                } else mutationSnackbar.showSnackbar(message)
            } finally { if (state.error == null) vm.acknowledgeMessage(message) }
        }
    }
    if (podcastCloud.conflict != null) AlertDialog(
            onDismissRequest = {},
            title = { Text(stringResource(R.string.podcast_queue_conflict_title)) },
            text = { Text(stringResource(R.string.podcast_queue_conflict_body)) },
            confirmButton = { TextButton({ vm.resolvePodcastQueueConflict(com.wildstring.app.data.PodcastQueueConflictChoice.USE_SERVER) }) { Text(stringResource(R.string.podcast_queue_use_server)) } },
            dismissButton = { TextButton({ vm.resolvePodcastQueueConflict(com.wildstring.app.data.PodcastQueueConflictChoice.OVERWRITE) }) { Text(stringResource(R.string.podcast_queue_overwrite)) } },
        )
    val savedPages = rememberSaveableStateHolder()
    val pullRefresh = rememberPullToRefreshState()
    val savedKeys = remember { ArrayDeque<String>() }
    LaunchedEffect(state.contentKey) {
        savedKeys.remove(state.contentKey); savedKeys.addLast(state.contentKey)
        if (savedKeys.size > 32) savedPages.removeState(savedKeys.removeFirst())
    }
    val destination = when { settings -> "settings"; expanded && state.current != null -> "player"; else -> "catalog" }
    // Upward pulls reveal the queue sheet and stay in composition; the downward offset is read only
    // while drawing, so following the finger redraws the player without recomposing the app shell.
    var rawPlayerDragY by remember { mutableFloatStateOf(0f) }
    var playerPullingUp by remember { mutableStateOf(false) }
    val playerDismissY = remember { mutableFloatStateOf(0f) }
    val playerSettle = remember { mutableStateOf<Job?>(null) }
    fun settlePlayerDrag() {
        playerSettle.value?.cancel()
        if (playerDismissY.floatValue > 0f) playerSettle.value = scope.launch {
            animate(playerDismissY.floatValue, 0f, animationSpec = spring(stiffness = Spring.StiffnessMediumLow)) { value, _ ->
                playerDismissY.floatValue = value
            }
        }
    }
    fun updatePlayerDrag(offset: Float, active: Boolean) {
        val pullUp = active && offset < 0f
        if (pullUp || playerPullingUp) {
            rawPlayerDragY = if (pullUp) offset else 0f
            playerPullingUp = pullUp
        }
        if (active) {
            playerSettle.value?.cancel()
            playerDismissY.floatValue = offset.coerceAtLeast(0f)
        } else settlePlayerDrag()
    }
    LaunchedEffect(destination) {
        if (destination != "player") {
            rawPlayerDragY = 0f
            playerPullingUp = false
            playerFromSettings = false
            playerReturnFeature = null
        } else settlePlayerDrag()
    }
    val baseIsSettings = settings || (destination == "player" && playerFromSettings)
    val baseSurfaceColor = if (baseIsSettings) MaterialTheme.colorScheme.surfaceContainerLow else Background
    Box(Modifier.fillMaxSize().background(baseSurfaceColor))
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val insets = WindowInsets.safeDrawing.asPaddingValues()
        val safeWidth = (maxWidth - insets.calculateLeftPadding(androidx.compose.ui.unit.LayoutDirection.Ltr) - insets.calculateRightPadding(androidx.compose.ui.unit.LayoutDirection.Ltr)).coerceAtLeast(0.dp)
        val safeHeight = (maxHeight - insets.calculateTopPadding() - insets.calculateBottomPadding()).coerceAtLeast(0.dp)
        val wide = safeWidth >= 840.dp && safeHeight >= 480.dp
        val landscape = safeWidth > safeHeight && !wide
        val rail = safeWidth >= 600.dp && safeHeight >= 480.dp
        val compact = safeHeight < 600.dp
        var wasWide by remember { mutableStateOf(wide) }
        LaunchedEffect(wide) { if (wasWide && !wide && expanded && !queue) lyrics = true; wasWide = wide }
        BackHandler(enabled = !settings && (expanded || queue || state.canGoBack || state.tab != "search")) {
            when { queue && (!wide || state.current?.isPodcast == true) -> queue = false; lyrics && !wide && state.current?.isPodcast != true -> lyrics = false; expanded -> collapsePlayer(); state.tab == "podcast" && state.podcastId != null -> vm.back(); state.canGoBack -> vm.back(); else -> vm.navigate("search") }
        }
        val baseDestinationContent by rememberUpdatedState<@Composable (String) -> Unit> { target ->
            Box(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
            if (target == "settings") savedPages.SaveableStateProvider("settings") { SettingsScreen(vm, bottomBar = {
                MiniPlayer(vm, state, onQueue = { queue = true }, includeBottomInset = true) { playerFromSettings = true; settings = false; expanded = true; lyrics = false; queue = false }
            }) { settings = false } }
            else {
                Row(Modifier.fillMaxSize()) {
                    if (rail) NavigationRail(windowInsets = WindowInsets(0, 0, 0, 0), modifier = Modifier.testTag("navigation-rail")) {
                        Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.padding(vertical = 24.dp).size(36.dp), tint = Color.Unspecified)
                        RailItems(state, vm)
                    }
                    val showMiniPlayer = state.current != null && (state.tab != "assistant" || state.playing || state.buffering)
                    Scaffold(
                        contentWindowInsets = WindowInsets(0, 0, 0, 0),
                        topBar = { if (state.tab != "assistant" && (state.tab != "podcast" || state.podcastId == null)) CatalogTopBar(state, vm::back, { settings = true }, compact = true, unread = unread,
                            notifications = { feature = "notifications" }) },
                        bottomBar = {
                            Surface(
                                color = MaterialTheme.colorScheme.surfaceContainer,
                                tonalElevation = 0.dp,
                            ) {
                                Column(
                                    Modifier.fillMaxWidth().then(
                                        if (!rail) {
                                            Modifier.windowInsetsPadding(WindowInsets.navigationBars.only(WindowInsetsSides.Bottom))
                                        } else {
                                            Modifier
                                        }
                                    )
                                ) {
                                    if (showMiniPlayer) {
                                        MiniPlayer(vm, state, onQueue = { queue = true }, includeBottomInset = rail) {
                                            playerReturnDepth = -1; playerFromSettings = false; expanded = true; lyrics = false; queue = false
                                        }
                                    }
                                    if (!rail) {
                                        NavigationBar(
                                            windowInsets = WindowInsets(0, 0, 0, 0),
                                            containerColor = Color.Transparent,
                                            tonalElevation = 0.dp,
                                            modifier = Modifier.testTag("bottom-navigation"),
                                        ) {
                                            BottomItems(state, vm)
                                        }
                                    }
                                }
                            }
                        },
                    ) { padding ->
                        Box(Modifier.fillMaxSize().padding(padding)) {
                            if (state.tab == "podcast") {
                                savedPages.SaveableStateProvider("podcast") { PodcastChannelPage(vm) }
                            } else if (state.tab == "assistant") {
                                MobileAssistantPage(vm, unread, { feature = "notifications" }, { settings = true }) {
                                    playerReturnDepth = -1; playerFromSettings = false; expanded = true; lyrics = false; queue = false
                                }
                            } else {
                            Column(Modifier.fillMaxSize()) {
                                MusicLibraryChoice(vm)
                                if (state.tab == "library" && state.collection == null) LibraryTabs(state.kind, vm::kind)
                                // Keep the editor outside query-keyed pages and discover/result branches.
                                if (state.tab == "search" && state.collection == null && state.kind != "recent") CatalogSearch(state.query, vm::search)
                                val header: @Composable () -> Unit = {
                                Column(Modifier.fillMaxWidth()) {
                                    if (state.tab == "mine" && state.collection == null && state.kind != "recent") {
                                        PersonalHeader(vm, state, { vm.recent() }, compact = compact)
                                        MobileShortcuts { if (it == "settings") settings = true else feature = it }
                                        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                            Text(stringResource(R.string.my_playlists), style = MaterialTheme.typography.titleMedium)
                                            IconButton({ featurePlaylist = null; feature = "playlist" }) { Icon(Icons.Default.Add, stringResource(R.string.playlist_new)) }
                                        }
                                    }
                                    if (state.kind == "artists" && state.collection == null) {
                                        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                            Row(Modifier.weight(1f).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                                listOf("album_artist" to stringResource(R.string.album_artists), "artist" to stringResource(R.string.artists), "vocalist" to stringResource(R.string.vocalists), "lyricist" to stringResource(R.string.lyricists), "composer" to stringResource(R.string.composers), "arranger" to stringResource(R.string.arrangers)).forEach { (key, name) -> FilterChip(state.role == key, { vm.role(key) }, label = { Text(name) }) }
                                            }
                                            Spacer(Modifier.width(8.dp))
                                            Text(stringResource(R.string.artist_count, state.total), color = Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1, softWrap = false)
                                        }
                                    }
                                    if (state.collection == "artists" && state.albumFilter == null) Row(Modifier.padding(horizontal = if (state.kind == "albums") 0.dp else 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                        FilterChip(state.kind == "albums", { vm.kind("albums") }, label = { Text(stringResource(R.string.albums)) })
                                        FilterChip(state.kind == "tracks", { vm.kind("tracks") }, label = { Text(stringResource(R.string.tracks)) })
                                    }
                                    if (state.tab == "search" && state.kind == "discover") MobileShortcuts(discovery = true) { feature = it }
                                    state.error?.let { ErrorMessage(it, vm::load) }
                                    if (state.offline) Text(stringResource(R.string.catalog_offline), color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = if (state.kind == "albums") 0.dp else 16.dp, vertical = 6.dp))
                                    if (state.kind == "albums") Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                        Text(stringResource(R.string.album_count, state.total), Modifier.weight(1f), color = Muted, style = MaterialTheme.typography.labelMedium, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
                                        CatalogSortControls(state, vm::sort, vm::toggleSortOrder)
                                    }
                                    if (state.kind == "tracks" || state.kind == "recent") CatalogToolbar(state,
                                        play = tactile { vm.playCollection { playerReturnDepth = -1; expanded = true; lyrics = false; queue = false } }, sort = vm::sort, reverse = vm::toggleSortOrder,
                                        multi = { feature = "multi" }, download = { vm.downloadCollection() },
                                        edit = { featurePlaylist = state.activePlaylist; feature = "playlist" },
                                        order = { featurePlaylist = state.activePlaylist; feature = "order" },
                                        delete = { deletingPlaylist = state.activePlaylist },
                                        albumLyrics = null,
                                        albumRefresh = null)
                                }
                            }
                            var manualRefresh by remember { mutableStateOf(false) }
                            LaunchedEffect(state.loading) {
                                if (!state.loading) manualRefresh = false
                            }
                            val showRefreshIndicator = if (manualRefresh) state.loading else delayed(state.loading && state.hasContent, 320)
                            Box(Modifier.weight(1f)) {
                                PullToRefreshBox(isRefreshing = showRefreshIndicator, onRefresh = { if (!state.loading) { manualRefresh = true; vm.load() } },
                                    modifier = Modifier.fillMaxSize().testTag("catalog-refresh-area").semantics {
                                        customActions = listOf(CustomAccessibilityAction(resources.getString(R.string.refresh_page)) {
                                            if (state.loading) false else { manualRefresh = true; vm.load(); true }
                                        })
                                    }, state = pullRefresh,
                                    indicator = { WildRefreshIndicator(showRefreshIndicator, pullRefresh, Modifier.align(Alignment.TopCenter)) }) {
                                    savedPages.SaveableStateProvider(state.contentKey.ifBlank { "initial" }) {
                                        if (state.kind == "discover") DiscoveryPage(vm, state,
                                            play = { tracks, index -> vm.play(tracks, index); playerReturnDepth = -1; expanded = true; lyrics = false; queue = false }, recent = vm::recent, header = header,
                                            albumActions = { albumActions = it })
                                        else CatalogBrowser(vm, state, header,
                                            play = { track -> vm.playCollection(track.id) { playerReturnDepth = -1; expanded = true; lyrics = false; queue = false } },
                                            actions = { actions = it }, playlistActions = { playlistActions = it }, albumActions = { albumActions = it })
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
        // Move each page between its destination and the player backdrop without recreating
        // its saveable registry before the outgoing instance has saved its state.
        val settingsContent = remember { movableContentOf { baseDestinationContent("settings") } }
        val catalogContent = remember { movableContentOf { baseDestinationContent("catalog") } }
        @Composable fun BaseDestination(target: String) {
            if (target == "settings") settingsContent() else catalogContent()
        }
        AnimatedContent(destination, transitionSpec = {
            if (targetState == "settings" || initialState == "settings") {
                (fadeIn(tween(180)) + slideInHorizontally(tween(240)) { if (targetState == "settings") it / 6 else -it / 12 }) togetherWith fadeOut(tween(120))
            } else if (initialState == "player") {
                ContentTransform(
                    targetContentEnter = EnterTransition.None,
                    // Starts at full speed so a released swipe carries on instead of pausing first.
                initialContentExit = fadeOut(tween(200, delayMillis = 60)) + slideOutVertically(tween(260, easing = LinearOutSlowInEasing)) { it },
                    targetContentZIndex = -1f,
                )
            } else (fadeIn(tween(220)) + slideInVertically(tween(280, easing = FastOutSlowInEasing)) { it / 12 }) togetherWith fadeOut(tween(140))
        }, label = "app-destination") { currentDestination ->
            if (currentDestination == "player") {
                Box(Modifier.fillMaxSize()) {
                    // The offset outlives the dismiss so the exit slide continues from the finger.
                    DisposableEffect(Unit) { onDispose { playerSettle.value?.cancel(); playerDismissY.floatValue = 0f } }
                    // Composed ahead of the gesture so the first frame of a pull has nothing to build.
                    if (this@AnimatedContent.transition.currentState == EnterExitState.Visible &&
                        this@AnimatedContent.transition.targetState == EnterExitState.Visible) {
                        Box(
                            Modifier.fillMaxSize()
                                .clearAndSetSemantics {}
                                .drawWithContent {
                                    if (playerDismissY.floatValue > 0.5f) drawContent()
                                }
                        ) {
                            BaseDestination(if (playerFromSettings) "settings" else "catalog")
                        }
                    }
                    PlayerScreen(vm, state, wide, landscape, lyrics, queue, rotation,
                        dragOffset = playerDismissY,
                        onUpdateDrag = ::updatePlayerDrag,
                        onBack = ::collapsePlayer,
                        onDismiss = ::collapsePlayer,
                        onLyrics = { lyrics = !lyrics; queue = false }, onQueue = { queue = !queue },
                        onAlbum = { state.current?.let(::openTrackAlbum) },
                        onArtist = ::openTrackArtist,
                        onAdd = { actions = state.current }, onSleep = { sleepDialog = true })
                }
            } else {
                BaseDestination(currentDestination)
            }
        }
        val usePhoneQueueSheet = state.current?.isPodcast == true || (!wide && !landscape) || !expanded
        val density = LocalDensity.current
        val defaultMaxQueueSheetPx = with(density) { 560.dp.toPx() }
        var measuredQueueSheetPx by remember { mutableFloatStateOf(0f) }
        val maxQueueSheetPx = if (measuredQueueSheetPx > 1f) measuredQueueSheetPx else defaultMaxQueueSheetPx
        var rawQueueDragY by remember { mutableFloatStateOf(0f) }
        var queueDragging by remember { mutableStateOf(false) }
        LaunchedEffect(queue) {
            if (!queue) {
                rawQueueDragY = 0f
                queueDragging = false
            }
        }
        val isActivelyDraggingQueue = usePhoneQueueSheet && (
            (!queue && destination == "player" && playerPullingUp) ||
            (queue && queueDragging)
        )
        val targetQueueRevealPx = when {
            !usePhoneQueueSheet -> 0f
            queue -> (maxQueueSheetPx - rawQueueDragY.coerceAtLeast(0f)).coerceIn(0f, maxQueueSheetPx)
            destination == "player" && playerPullingUp -> (-rawPlayerDragY).coerceIn(0f, maxQueueSheetPx)
            else -> 0f
        }
        val animatedQueueRevealPx = animateFloatAsState(
            targetValue = targetQueueRevealPx,
            animationSpec = if (isActivelyDraggingQueue) snap() else spring(stiffness = Spring.StiffnessMediumLow),
            label = "queue-sheet-reveal",
        )
        if (usePhoneQueueSheet && (queue || animatedQueueRevealPx.value > 0.5f)) {
            val revealPx = animatedQueueRevealPx.value.coerceIn(0f, maxQueueSheetPx)
            val scrimAlpha = (revealPx / maxQueueSheetPx.coerceAtLeast(1f)).coerceIn(0f, 1f) * 0.45f
            val queueDismissModifier = Modifier.dismissPlayerSwipe(
                enabled = queue,
                onDismiss = { queue = false },
                onDragOffset = { offset, active -> rawQueueDragY = offset; queueDragging = active },
                onThresholdCrossed = { feedback(TactileKind.Tap) },
            )
            Box(
                Modifier.fillMaxSize()
                    .then(if (!queue) Modifier.clearAndSetSemantics {} else Modifier)
                    .background(Color.Black.copy(alpha = scrimAlpha))
                    .pointerInput(queue) {
                        if (queue) {
                            detectTapGestures { queue = false }
                        }
                    },
                contentAlignment = Alignment.BottomCenter,
            ) {
                Surface(
                    Modifier.fillMaxWidth().heightIn(min = 280.dp, max = 560.dp)
                        .onSizeChanged { if (it.height > 0) measuredQueueSheetPx = it.height.toFloat() }
                        .graphicsLayer {
                            val sheetH = if (size.height > 1f) size.height else maxQueueSheetPx
                            translationY = (sheetH - animatedQueueRevealPx.value).coerceAtLeast(0f)
                        }
                        .pointerInput(Unit) { detectTapGestures {} },
                    shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerLow,
                    shadowElevation = 12.dp,
                ) {
                    Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
                        Box(
                            Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp)
                                .then(queueDismissModifier),
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(Modifier.size(width = 36.dp, height = 4.dp).clip(RoundedCornerShape(2.dp)).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f)))
                        }
                        QueuePanel(
                            vm = vm,
                            state = state,
                            modifier = Modifier.fillMaxWidth(),
                            headerModifier = queueDismissModifier,
                            onClose = { queue = false },
                        )
                    }
                }
            }
        }
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
            // Features are dialogs above the shell, so close the dialog before expanding the player.
            "player", "queue" -> {
                playerReturnFeature = feature; feature = null
                playerReturnDepth = -1; playerFromSettings = false; expanded = true; lyrics = false; queue = target == "queue"
            }
        }
    }
    feature?.let { route -> FeatureDialog(vm, route, featureTrack, featurePlaylist, albumId = featureAlbumId, dismiss = { feature = null; featureTrack = null; featurePlaylist = null; featureBatchId = null; featureAlbumId = null }, initialBatchId = featureBatchId, onOpenAction = ::openFeatureAction) }
    playlistActions?.let { playlist -> ModalBottomSheet(onDismissRequest = { playlistActions = null }) {
        Text(playlist.name, Modifier.padding(horizontal = 20.dp, vertical = 12.dp), style = MaterialTheme.typography.titleLarge)
        SongAction(stringResource(R.string.playlist_open), Icons.AutoMirrored.Filled.PlaylistPlay) { playlistActions = null; vm.openPlaylist(playlist) }
        SongAction(if (playlist.id in vm.repository.downloads.followedPlaylists()) stringResource(R.string.auto_download_off) else stringResource(R.string.playlist_auto_download), Icons.Default.Download) {
            vm.followPlaylist(playlist, playlist.id !in vm.repository.downloads.followedPlaylists()); playlistActions = null
        }
        if (playlist.kind != "favorites") {
            SongAction(stringResource(R.string.playlist_edit), Icons.Default.Edit) { featurePlaylist = playlist; feature = "playlist"; playlistActions = null }
            if (playlist.kind == "manual") SongAction(stringResource(R.string.playlist_manage_tracks), Icons.AutoMirrored.Filled.QueueMusic) { featurePlaylist = playlist; feature = "order"; playlistActions = null }
            SongAction(stringResource(R.string.playlist_delete), Icons.Default.Delete, destructive = true) { deletingPlaylist = playlist; playlistActions = null }
        }
        Spacer(Modifier.height(24.dp))
    } }
    albumActions?.let { album -> AlbumActionsSheet(
        vm = vm,
        album = album,
        onDismiss = { albumActions = null },
        onAddPlaylist = { tracks ->
            albumActions = null
            albumPlaylistTracks = tracks
            scope.launch { try { playlistChoices = vm.playlistsForAdd() } catch (e: Exception) { localError = friendlyError(e) } }
        },
        onEdit = { albumActions = null; featureAlbumId = album.id; feature = "album-edit" },
        onReview = { albumActions = null; featureAlbumId = album.id; feature = "management" },
        onRefresh = { albumActions = null; refreshAlbum = album.id },
    ) }
    lyricScanAlbum?.let { albumId -> FeatureDialog(vm, "lyric-scans", albumId = albumId, dismiss = { lyricScanAlbum = null }) }
    refreshAlbum?.let { albumId -> MetadataRefreshPrompt(vm, "album", albumId) { refreshAlbum = null } }
    if (sleepDialog) SleepDialog(vm) { sleepDialog = false }
    if (crashReportOpen) CrashReportsDialog { crashReportOpen = false }
    deletingPlaylist?.let { playlist -> AlertDialog(onDismissRequest = { if (!playlistAction.busy) deletingPlaylist = null }, title = { Text(stringResource(R.string.playlist_delete_title)) }, text = { Column { Text(playlist.name); ActionStatus(playlistAction) } }, confirmButton = { TextButton({ scope.launch { playlistAction.run { vm.deletePlaylist(playlist); deletingPlaylist = null } } }, enabled = !playlistAction.busy) { Text(stringResource(R.string.delete)) } }, dismissButton = { TextButton({ deletingPlaylist = null }, enabled = !playlistAction.busy) { Text(stringResource(R.string.cancel)) } }) }
    actions?.let { track -> ModalBottomSheet(
        onDismissRequest = { actions = null },
        modifier = Modifier.testTag("song-actions-sheet"),
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        // Only the list consumes vertical flings; the sheet must not share their velocity.
        sheetGesturesEnabled = false,
        dragHandle = {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.track_actions), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton({ actions = null }) { Icon(Icons.Default.Close, stringResource(R.string.track_actions_close)) }
            }
        },
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 640.dp).testTag("song-actions-scroll").verticalScroll(rememberScrollState(), overscrollEffect = null)) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Cover(vm, track.coverId, track.title, Modifier.size(48.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(track.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(track.artist, style = MaterialTheme.typography.bodySmall, color = Muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        SongAction(stringResource(R.string.open_album), Icons.Default.Album, navigate = true) { openTrackAlbum(track) }
        track.artists.filter { it.isNotBlank() }.forEach { artist ->
            SongAction(if (track.artists.size > 1) stringResource(R.string.open_artist_named, artist) else stringResource(R.string.open_artist), Icons.Default.Person, navigate = true) { openTrackArtist(artist) }
        }
        SongAction(stringResource(R.string.playback_gain), Icons.AutoMirrored.Filled.VolumeUp) { feature = "gain"; featureTrack = track; actions = null }
        if (track.id == state.current?.id) {
            SongAction(stringResource(R.string.lyrics_refresh), Icons.Default.Refresh) { vm.refreshLyrics(); actions = null }
        }
        HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        SongAction(stringResource(R.string.play_next), Icons.AutoMirrored.Filled.PlaylistPlay, onClick = tactile { vm.addToQueue(track, true); actions = null })
        SongAction(stringResource(R.string.queue_add), Icons.AutoMirrored.Filled.QueueMusic, onClick = tactile { vm.addToQueue(track); actions = null })
        SongAction(if (track.loved) stringResource(R.string.favorite_remove) else stringResource(R.string.favorite_add), if (track.loved) Icons.Default.Favorite else Icons.Default.FavoriteBorder, onClick = tactile { vm.favorite(track); actions = null })
        SongAction(stringResource(R.string.playlist_add), Icons.AutoMirrored.Filled.PlaylistAdd) {
            chooseTrack = track; actions = null
            scope.launch { try { playlistChoices = vm.playlistsForAdd() } catch (e: Exception) { localError = friendlyError(e) } }
        }
        SongAction(stringResource(R.string.ws_app_offline_save), Icons.Default.Download) { vm.download(listOf(track)); actions = null }
        state.activePlaylist?.takeIf { it.kind == "manual" }?.let { playlist -> SongAction(stringResource(R.string.playlist_remove_track), Icons.Default.RemoveCircleOutline, destructive = true) { actions = null; scope.launch { try { vm.removePlaylistTrack(track, playlist) } catch (e: Exception) { localError = friendlyError(e) } } } }
        if (state.account?.profile in listOf("owner", "librarian", "editor")) {
            HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            listOf(
                Triple("metadata", stringResource(R.string.track_edit), Icons.Default.Edit),
                Triple("lyrics", stringResource(R.string.lyrics_edit_timing), Icons.Default.Lyrics)
            ).forEach { (route, title, icon) ->
                SongAction(title, icon, navigate = true) { featureTrack = track; feature = route; actions = null }
            }
        }
        Spacer(Modifier.height(24.dp))
        }
    } }
    playlistChoices?.let { choices -> AlertDialog(onDismissRequest = { playlistChoices = null; albumPlaylistTracks = null }, title = { Text(stringResource(R.string.playlist_add)) }, text = {
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
            if (choices.isEmpty()) Text(stringResource(R.string.playlist_empty_hint), color = Muted, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(vertical = 8.dp))
            choices.forEach { p ->
                ListItem(
                    headlineContent = { Text(p.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    supportingContent = { Text(stringResource(R.string.track_count, p.trackCount), fontSize = 12.sp, color = Muted) },
                    leadingContent = { Icon(Icons.AutoMirrored.Filled.QueueMusic, null, tint = Muted) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable {
                        val selectedAlbumTracks = albumPlaylistTracks
                        if (selectedAlbumTracks != null) scope.launch { try { vm.addTracksToPlaylist(selectedAlbumTracks, p) } catch (e: Exception) { localError = friendlyError(e) } finally { albumPlaylistTracks = null; playlistChoices = null } }
                        else { feedback(TactileKind.Tap); chooseTrack?.let { vm.addToPlaylist(it, p) }; playlistChoices = null }
                    },
                )
            }
        }
    }, dismissButton = {
        TextButton({ createAndAddOpen = true }) {
            Icon(Icons.Default.Add, null, Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
            Text(stringResource(R.string.playlist_new))
        }
    }, confirmButton = { TextButton({ playlistChoices = null; albumPlaylistTracks = null }) { Text(stringResource(R.string.close)) } }) }
    if (createAndAddOpen) NameDialog(stringResource(R.string.playlist_create_add), "", { createAndAddOpen = false }) { name ->
        createAndAddOpen = false
        val tracksToAdd = albumPlaylistTracks ?: listOfNotNull(chooseTrack)
        albumPlaylistTracks = null; playlistChoices = null
        scope.launch { try { vm.createPlaylistAndAdd(name, tracksToAdd) } catch (e: Exception) { localError = friendlyError(e) } }
    }
    localError?.let { text -> AlertDialog(onDismissRequest = { localError = null }, text = { Text(text) }, confirmButton = { TextButton({ localError = null }) { Text(stringResource(R.string.close)) } }) }
}

@Composable
private fun AlbumActionsSheet(
    vm: MusicViewModel,
    album: Album,
    onDismiss: () -> Unit,
    onAddPlaylist: (List<Track>) -> Unit,
    onEdit: () -> Unit,
    onReview: () -> Unit = {},
    onRefresh: () -> Unit,
) {
    val accountState by vm.state.collectAsStateWithLifecycle()
    val action = remember { FeatureAction() }
    val resources = androidx.compose.ui.platform.LocalResources.current
    val scope = rememberCoroutineScope()
    suspend fun tracks(): List<Track> = vm.repository.collectionTracks(CatalogQuery(
        tab = "library", kind = "tracks", title = album.title, collection = "albums", collectionId = album.id, sort = "title"
    ))
    fun withTracks(next: Boolean = false, append: (List<Track>) -> Unit) {
        scope.launch { action.run { val items = tracks(); append(items) } }
    }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        sheetGesturesEnabled = false,
        dragHandle = {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.album_actions), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                IconButton(onDismiss) { Icon(Icons.Default.Close, stringResource(R.string.album_actions_close)) }
            }
        },
    ) {
        Column(Modifier.fillMaxWidth().heightIn(max = 680.dp).verticalScroll(rememberScrollState(), overscrollEffect = null)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Cover(vm, album.coverTrackId, album.title, Modifier.size(64.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(album.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(album.artists.joinToString(" / ") + " · " + stringResource(R.string.track_count, album.trackCount), style = MaterialTheme.typography.bodySmall, color = Muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            ActionStatus(action)
            SongAction(stringResource(R.string.album_play), Icons.Default.PlayArrow, onClick = tactile {
                withTracks { items -> vm.play(items); onDismiss() }
            })
            SongAction(stringResource(R.string.play_next), Icons.AutoMirrored.Filled.PlaylistPlay, onClick = tactile {
                withTracks(next = true) { items -> vm.addToQueue(items, next = true); vm.notify(resources.getString(R.string.queued_next)); onDismiss() }
            })
            SongAction(stringResource(R.string.queue_add), Icons.AutoMirrored.Filled.QueueMusic, onClick = tactile {
                withTracks { items -> vm.addToQueue(items); vm.notify(resources.getString(R.string.queued_added)); onDismiss() }
            })
            SongAction(stringResource(R.string.album_save_offline), Icons.Default.Download, onClick = tactile {
                withTracks { items -> vm.download(items); onDismiss() }
            })
            SongAction(stringResource(R.string.playlist_add), Icons.AutoMirrored.Filled.PlaylistAdd, onClick = {
                scope.launch { action.run { onAddPlaylist(tracks()) } }
            })
            HorizontalDivider(Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            if (accountState.account?.profile in listOf("owner", "librarian", "editor")) {
                SongAction(stringResource(R.string.album_edit), Icons.Default.Edit, navigate = true, onClick = onEdit)
            }
            Spacer(Modifier.height(24.dp))
        }
    }
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
private fun MobileAssistantPage(vm: MusicViewModel, unread: Int, onNotifications: () -> Unit, onSettings: () -> Unit, onPlayer: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    var draft by remember { mutableStateOf<String?>(null) }
    AgentChat(vm, onNotifications, onSettings, unread,
        onPlayer = onPlayer.takeIf { state.current != null && !state.playing && !state.buffering }) { draft = it }
    draft?.let { FeatureDialog(vm, "drafts", initialBatchId = it) { draft = null } }
}

/** Main navigation destinations; labels follow the interface language. */
@Composable
private fun navItems() = listOf(
    Triple("search", androidx.compose.ui.res.stringResource(R.string.nav_discover), Icons.Default.Explore),
    Triple("podcast", androidx.compose.ui.res.stringResource(R.string.nav_radio), Icons.Default.Podcasts),
    Triple("assistant", androidx.compose.ui.res.stringResource(R.string.nav_assistant), Icons.Default.AutoAwesome),
    Triple("library", androidx.compose.ui.res.stringResource(R.string.nav_music), Icons.Default.LibraryMusic),
    Triple("mine", androidx.compose.ui.res.stringResource(R.string.nav_mine), Icons.Default.Person),
)

@Composable
private fun RailItems(state: MusicState, vm: MusicViewModel) {
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    navItems().forEach { (id, label, icon) ->
        NavigationRailItem(state.tab == id, { keyboard?.hide(); vm.navigate(id) }, modifier = Modifier.testTag("nav-$id"), icon = { Icon(icon, label) }, label = { Text(label) })
    }
}
@Composable
private fun RowScope.BottomItems(state: MusicState, vm: MusicViewModel) {
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    navItems().forEach { (id, label, icon) ->
        NavigationBarItem(
            selected = state.tab == id,
            onClick = { keyboard?.hide(); vm.navigate(id) },
            modifier = Modifier.testTag("nav-$id"),
            icon = { Icon(icon, label) },
            label = { Text(label, maxLines = 1, softWrap = false) },
        )
    }
}

@Composable
internal fun Cover(vm: MusicViewModel, id: String?, title: String, modifier: Modifier, contentScale: ContentScale = ContentScale.Crop) {
    val profile by vm.repository.session.profiles.collectAsStateWithLifecycle()
    val fallback = painterResource(R.drawable.ic_wildstring)
    AsyncImage(model = id?.let { ImageRequest.Builder(LocalContext.current).data(vm.repository.cover(it)).memoryCacheKey("${profile}:${vm.repository.cover(it)}").crossfade(180).build() }, imageLoader = vm.coverLoader(id), contentDescription = title,
        placeholder = fallback, error = fallback, fallback = fallback,
        contentScale = contentScale, modifier = modifier.clip(RoundedCornerShape(10.dp)))
}
@Composable
internal fun TrackRow(vm: MusicViewModel, track: Track, state: MusicState, index: Int, play: () -> Unit, actions: () -> Unit) {
    val current = state.current?.id == track.id
    val album = state.collection == "albums" || state.albumFilter != null
    val size = LocalSongListSize.current
    val metric = when (state.sort) {
        "play_count" -> stringResource(R.string.play_count_value, track.playCount)
        "listened_ms" -> stringResource(R.string.minutes_value, track.listenedMs / 60_000)
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
            Cover(vm, track.coverId, track.title, Modifier.fillMaxSize())
            if (current) {
                Box(Modifier.matchParentSize().background(Color.Black.copy(alpha = .46f)))
                PlaybackIndicator(state.playing, state.buffering, color = Color.White)
            }
        }
        Column(Modifier.weight(1f).padding(start = 14.dp)) {
            Text(track.title, Modifier.testTag("track-title-$index"), color = if (!track.isAvailable) Muted else if (current) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyLarge, fontSize = size.titleSp.sp, lineHeight = size.titleLineSp.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(track.unavailableReason, if (album && state.discs.size > 1 && state.sort !in listOf("title", "track_number")) "Disc ${track.discNumber ?: 1}" else null, track.artist, metric).joinToString(" · "), Modifier.testTag("track-subtitle-$index"), color = Muted,
                style = MaterialTheme.typography.bodySmall, fontSize = size.artistSp.sp, lineHeight = size.artistLineSp.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(actions, Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).testTag("track-action-$index")) { Icon(Icons.Default.MoreVert, stringResource(R.string.track_actions_named, track.title)) }
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
        val playLabel = if (state.collecting) stringResource(R.string.preparing) else stringResource(R.string.play_all)
        val countLabel = stringResource(R.string.track_count, state.total)
        val sortContext = catalogSortContext(state.kind, state.collection, state.albumFilter)
        val sortLabel = sortContext?.let { stringResource(catalogSortLabel(state.sort, it)) }
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
                IconButton({ more = true }, Modifier.testTag("catalog-more")) { Icon(Icons.Default.MoreVert, stringResource(R.string.list_actions)) }
                DropdownMenu(more, { more = false }) {
                    albumLyrics?.let { open -> DropdownMenuItem(text = { Text(stringResource(R.string.lyrics_scan)) }, leadingIcon = { Icon(Icons.Default.Lyrics, null) }, onClick = { more = false; open() }) }
                    albumRefresh?.let { update -> DropdownMenuItem(text = { Text(stringResource(R.string.album_refresh)) }, leadingIcon = { Icon(Icons.Default.Edit, null) }, onClick = { more = false; update() }) }
                    if (albumLyrics != null || albumRefresh != null) HorizontalDivider()
                    DropdownMenuItem(text = { Text(stringResource(R.string.multi_select_add)) }, onClick = { more = false; multi() })
                    DropdownMenuItem(text = { Text(stringResource(R.string.offline_save)) }, onClick = { more = false; download() }, enabled = !state.collecting)
                    state.activePlaylist?.takeIf { it.kind != "favorites" }?.let { playlist ->
                        DropdownMenuItem(text = { Text(stringResource(R.string.playlist_edit)) }, onClick = { more = false; edit() })
                        if (playlist.kind == "manual") DropdownMenuItem(text = { Text(stringResource(R.string.reorder_drag)) }, onClick = { more = false; order() })
                        DropdownMenuItem(text = { Text(stringResource(R.string.playlist_delete)) }, onClick = { more = false; delete() })
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
private fun PlayerScreen(vm: MusicViewModel, state: MusicState, wide: Boolean, landscape: Boolean, lyrics: Boolean, queue: Boolean, rotation: PlaybackRotation,
    dragOffset: State<Float>, onUpdateDrag: (Float, Boolean) -> Unit,
    onBack: () -> Unit, onDismiss: () -> Unit, onLyrics: () -> Unit, onQueue: () -> Unit, onAlbum: () -> Unit, onArtist: (String) -> Unit,
    onAdd: () -> Unit, onSleep: () -> Unit) {
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val sleep by vm.sleep.state.collectAsStateWithLifecycle()
    val feedback = LocalTactileFeedback.current
    val track = state.current ?: return
    // Draw the drag offset without moving pointer hit targets during the gesture. The empty
    // pointer handler keeps touches from reaching the catalog composed beneath the player.
    val playerModifier = Modifier.fillMaxSize().pointerInput(Unit) {}.drawWithContent {
        withTransform({ translate(top = dragOffset.value.coerceAtLeast(0f)) }) {
            this@drawWithContent.drawContent()
        }
    }
    if (track.isPodcast) {
        Box(playerModifier) {
            PodcastPlayerScreen(vm, state, landscape || wide, !queue,
                onBack, onDismiss, onUpdateDrag, onQueue, onSleep)
        }
        return
    }
    var artworkPreview by rememberSaveable { mutableStateOf(false) }
    val showArtwork = remember { { artworkPreview = true } }
    val dismissArtwork = remember { { artworkPreview = false } }
    val spinning = state.playing && !state.buffering && state.playbackError == null && !artworkPreview
    val thresholdTick = { feedback(TactileKind.Tap) }
    Box(playerModifier) {
    if (preferences.playbackStyle == "vinyl") {
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
    } else {
        ArtworkBackdrop(vm, track)
    }
    Column(Modifier.testTag(if (wide) "player-tablet" else if (landscape) "player-landscape" else "player-phone")
        .fillMaxSize()
        .safeDrawingPadding()
        .padding(horizontal = if (wide) 34.dp else 20.dp)) {
        Row(Modifier.fillMaxWidth().dismissPlayerSwipe(true, onDismiss, onUpdateDrag, thresholdTick), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            IconButton(onBack) {
                Icon(
                    Icons.Default.KeyboardArrowDown,
                    stringResource(R.string.player_collapse),
                )
            }
            Spacer(Modifier.weight(1f))
            IconButton(onSleep) { Icon(Icons.Default.Bedtime, stringResource(R.string.sleep_timer), tint = if (sleep.deadline != null || sleep.entryId != null) Accent else Muted) }
            IconButton(onAdd) { Icon(Icons.Default.MoreVert, stringResource(R.string.current_track_actions)) }
        }
        val openQueueOnSwipeUp = { if (!queue) onQueue() }
        if (landscape) Row(Modifier.weight(1f).fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight().testTag("player-visual-stage")
                .pointerInput(onLyrics, showArtwork, queue) {
                    detectTapGestures(
                        onLongPress = { if (!queue) showArtwork() },
                        onTap = { onLyrics() },
                    )
                }
                .dismissPlayerSwipe(!queue && !lyrics, onDismiss, onUpdateDrag, thresholdTick, openQueueOnSwipeUp)
                .trackSwipeGestures(!queue && !lyrics,
                    onPrevious = { feedback(TactileKind.Tap); vm.previous() },
                    onNext = { feedback(TactileKind.Tap); vm.next() }), contentAlignment = Alignment.Center) {
                when {
                    queue -> QueuePanel(vm, state, Modifier.fillMaxSize())
                    lyrics -> LyricsPanel(vm, state, Modifier.fillMaxSize(), onLyrics, showArtwork)
                    else -> PlaybackVisual(vm, track, preferences.playbackStyle, spinning, true, state.duration, rotation,
                        Modifier.size(minOf(maxWidth, maxHeight)), showArtwork, onLyrics)
                }
            }
            Column(Modifier.weight(1.15f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.Center) {
                    PlaybackControls(vm, state, onQueue, onAlbum, onArtist, compact = true)
            }
        } else if (wide) Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Row(
                Modifier.widthIn(max = 1120.dp).fillMaxSize().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(56.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(
                    Modifier.weight(0.95f).fillMaxHeight(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    BoxWithConstraints(
                        Modifier.weight(1f, fill = false).fillMaxWidth()
                            .dismissPlayerSwipe(!lyrics && !queue, onDismiss, onUpdateDrag, thresholdTick, openQueueOnSwipeUp)
                            .trackSwipeGestures(
                                !lyrics && !queue,
                                onPrevious = { feedback(TactileKind.Tap); vm.previous() },
                                onNext = { feedback(TactileKind.Tap); vm.next() },
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        val visualSize = minOf(480.dp, maxWidth, maxHeight)
                        PlaybackVisual(
                            vm, track, preferences.playbackStyle, spinning, true, state.duration, rotation,
                            Modifier.size(visualSize), showArtwork,
                        ) { if (queue) onQueue() }
                    }
                    Spacer(Modifier.height(28.dp))
                    PlaybackControls(
                        vm, state, onQueue, onAlbum, onArtist,
                        modifier = Modifier.widthIn(max = 480.dp).dismissPlayerSwipe(true, onDismiss, onUpdateDrag, thresholdTick, openQueueOnSwipeUp),
                    )
                }
                Column(
                    Modifier.weight(1.05f).fillMaxHeight().padding(top = 12.dp, bottom = 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(bottom = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        FilterChip(!queue, { if (queue) onQueue() }, label = { Text(stringResource(R.string.lyrics)) })
                        FilterChip(queue, { if (!queue) onQueue() }, label = { Text(stringResource(R.string.queue_count, state.queue.size)) })
                    }
                    if (queue) QueuePanel(vm, state, Modifier.weight(1f).fillMaxWidth())
                    else LyricsPanel(vm, state, Modifier.weight(1f).fillMaxWidth(), onArtwork = showArtwork)
                }
            }
        } else {
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().testTag("player-visual-stage")
                .pointerInput(onLyrics, showArtwork, lyrics) {
                    detectTapGestures(
                        onLongPress = { showArtwork() },
                        onTap = { onLyrics() },
                    )
                }
                .dismissPlayerSwipe(!lyrics, onDismiss, onUpdateDrag, thresholdTick, openQueueOnSwipeUp)
                .trackSwipeGestures(!lyrics,
                    onPrevious = { feedback(TactileKind.Tap); vm.previous() },
                    onNext = { feedback(TactileKind.Tap); vm.next() }), contentAlignment = Alignment.Center) {
                val visualSize = minOf(370.dp, maxWidth, maxHeight)
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    if (lyrics) LyricsPanel(vm, state, Modifier.fillMaxSize().padding(top = 8.dp, bottom = 32.dp), onLyrics, showArtwork)
                    else PlaybackVisual(vm, track, preferences.playbackStyle, spinning, true, state.duration, rotation,
                        Modifier.size(visualSize), showArtwork, onLyrics)
                }
            }
            PlaybackControls(vm, state, onQueue, onAlbum, onArtist,
                modifier = Modifier.dismissPlayerSwipe(true, onDismiss, onUpdateDrag, thresholdTick, openQueueOnSwipeUp))
        }
    }
    }
    if (artworkPreview) ArtworkPreview(vm, track, dismissArtwork)
}

@Composable
private fun PlaybackControls(vm: MusicViewModel, state: MusicState, onQueue: () -> Unit, onAlbum: () -> Unit,
    onArtist: (String) -> Unit = {}, compact: Boolean = false, modifier: Modifier = Modifier) {
    val track = state.current ?: return
    Column(modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(track.title, fontFamily = FontFamily.Serif, fontSize = if (compact) 20.sp else 23.sp, fontWeight = FontWeight.Medium, maxLines = if (compact) 1 else 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(end = 8.dp))
            FavoriteControl(track.loved, track.id in state.pendingFavorites, tactile { vm.favorite(track) })
        }
        Spacer(Modifier.height(if (compact) 2.dp else 4.dp))
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Row(Modifier.weight(1f, fill = false).horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
                if (track.artists.isEmpty()) {
                    Text(stringResource(R.string.unknown_artist), color = Muted, fontSize = 13.sp)
                } else {
                    track.artists.forEachIndexed { index, name ->
                        if (index > 0) Text(" / ", color = Muted, fontSize = 13.sp)
                        Row(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .clickable { onArtist(name) }
                                .padding(vertical = 2.dp)
                                .testTag("player-artist-$name"),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(name, color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.width(2.dp))
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(13.dp), tint = Muted)
                        }
                    }
                }
                Text(" · ", color = Muted, fontSize = 13.sp)
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .clickable { onAlbum() }
                        .padding(vertical = 2.dp)
                        .testTag("player-album"),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(track.album ?: stringResource(R.string.unknown_album), color = Muted, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.width(2.dp))
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, Modifier.size(13.dp), tint = Muted)
                }
            }
            if (state.playbackQuality.isNotBlank()) {
                var qualityDialog by remember { mutableStateOf(false) }
                val feedback = tactile {}
                Spacer(Modifier.width(8.dp))
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = .08f),
                    modifier = Modifier.clickable { feedback(); qualityDialog = true }
                ) {
                    Text(state.playbackQuality, color = Muted, fontFamily = FontFamily.Monospace, fontSize = 12.sp, maxLines = 1,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp).testTag("playback-quality"))
                }
                if (qualityDialog) {
                    val preferences by vm.settings.state.collectAsStateWithLifecycle()
                    val choices = listOf(0 to stringResource(R.string.quality_original), 128 to "AAC · 128 kbps", 192 to "AAC · 192 kbps", 256 to "AAC · 256 kbps", 320 to "AAC · 320 kbps")
                    val format = track.format.uppercase().ifBlank { "MP3" }
                    AlertDialog(
                        onDismissRequest = { qualityDialog = false },
                        title = { Text(stringResource(R.string.settings_quality)) },
                        text = {
                            Column {
                                Text(
                                    stringResource(R.string.current_source, format),
                                    Modifier.padding(bottom = 12.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = Muted
                                )
                                choices.forEach { (rate, label) ->
                                    Row(
                                        Modifier.fillMaxWidth()
                                            .selectable(preferences.aacBitrate == rate, role = Role.RadioButton, onClick = {
                                                feedback()
                                                vm.settings.quality(rate)
                                                qualityDialog = false
                                            })
                                            .padding(vertical = 12.dp),
                                        verticalAlignment = Alignment.CenterVertically
                                    ) {
                                        RadioButton(selected = preferences.aacBitrate == rate, onClick = null)
                                        Text(label, Modifier.padding(start = 16.dp))
                                    }
                                }
                            }
                        },
                        confirmButton = { TextButton({ qualityDialog = false }) { Text(stringResource(R.string.close)) } }
                    )
                }
            }
        }
        Spacer(Modifier.height(if (compact) 4.dp else 8.dp))
        PlaybackSeekSection(vm, state.duration)
        Row(Modifier.fillMaxWidth().padding(vertical = if (compact) 4.dp else 12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            val modeIcon = if (state.shuffle) Icons.Default.Shuffle else if (state.repeatMode == Player.REPEAT_MODE_ONE) Icons.Default.RepeatOne else Icons.Default.Repeat
            IconButton(tactile(vm::cycleMode)) { Icon(modeIcon, stringResource(R.string.play_mode_change), tint = if (state.shuffle || state.repeatMode != Player.REPEAT_MODE_OFF) Accent else Muted) }
            IconButton(tactile(vm::previous)) { Icon(Icons.Default.SkipPrevious, stringResource(R.string.previous_track), Modifier.size(30.dp)) }
            FilledIconButton(tactile(vm::toggle), Modifier.size(if (compact) 56.dp else 64.dp)) {
                Box(contentAlignment = Alignment.Center) {
                    if (delayed(state.buffering, 300)) {
                        CircularProgressIndicator(
                            Modifier.size(if (compact) 46.dp else 52.dp),
                            color = LocalContentColor.current.copy(alpha = 0.88f),
                            trackColor = LocalContentColor.current.copy(alpha = 0.2f),
                            strokeWidth = 2.dp,
                        )
                    }
                    Crossfade(state.playing, animationSpec = tween(130), label = "play-pause") { playing ->
                        Icon(if (playing) Icons.Default.Pause else Icons.Default.PlayArrow, if (playing) stringResource(R.string.pause) else stringResource(R.string.play), Modifier.size(if (compact) 28.dp else 32.dp))
                    }
                }
            }
            IconButton(tactile(vm::next)) { Icon(Icons.Default.SkipNext, stringResource(R.string.next_track), Modifier.size(30.dp)) }
            IconButton(tactile(onQueue)) { Icon(Icons.AutoMirrored.Filled.QueueMusic, stringResource(R.string.play_queue)) }
        }
        state.playbackError?.let { ErrorMessage(it) { vm.toggle() } }
    }
}

@Composable
internal fun PlaybackSeekSection(vm: MusicViewModel, duration: Long) {
    val position by vm.position.collectAsStateWithLifecycle()
    var scrub by remember { mutableStateOf<Float?>(null) }
    val feedback = LocalTactileFeedback.current
    Slider(value = scrub ?: position.coerceAtMost(duration).toFloat(), onValueChange = { scrub = it },
        onValueChangeFinished = { scrub?.let { feedback(TactileKind.Tap); vm.seek(it.toLong()) }; scrub = null }, valueRange = 0f..duration.coerceAtLeast(1).toFloat(), enabled = duration > 0,
        colors = SliderDefaults.colors(thumbColor = Accent, activeTrackColor = Accent,
            inactiveTrackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = .14f),
            activeTickColor = Color.Transparent, inactiveTickColor = Color.Transparent))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(formatTime(scrub?.toLong() ?: position), color = Muted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        Text(formatTime(duration), color = Muted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
    }
}

@Composable
private fun LyricsPanel(vm: MusicViewModel, state: MusicState, modifier: Modifier, onBlank: () -> Unit = {}, onArtwork: () -> Unit = {}) {
    val position by vm.position.collectAsStateWithLifecycle()
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    Box(modifier, contentAlignment = Alignment.Center) {
        when {
            state.lyricsLoading && state.lyrics.lines.isEmpty() -> LyricsSkeleton()
            state.lyricsLoading -> {
                LyricViewport(state.lyrics, position, vm::seek, onBlank, Modifier.fillMaxSize(), onArtwork,
                    followDelayMs = preferences.lyricFollowSeconds * 1_000L, playing = state.playing,
                    lyricSize = preferences.lyricSize)
                LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter))
            }
            state.lyricsError != null -> Text(state.lyricsError, color = Muted)
            state.lyrics.lines.isEmpty() -> Text(stringResource(R.string.no_lyrics), color = Muted)
            else -> LyricViewport(state.lyrics, position, vm::seek, onBlank, Modifier.fillMaxSize(), onArtwork,
                followDelayMs = preferences.lyricFollowSeconds * 1_000L, playing = state.playing,
                lyricSize = preferences.lyricSize)
        }
    }
}

@Composable
private fun ErrorMessage(message: String, retry: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { androidx.compose.foundation.text.selection.SelectionContainer(Modifier.weight(1f)) { Text(message, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }; TextButton(retry) { Text(stringResource(R.string.retry)) } }
}
@Composable
private fun NameDialog(title: String, initial: String, dismiss: () -> Unit, save: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    AlertDialog(onDismissRequest = dismiss, title = { Text(title) }, text = { OutlinedTextField(name, { name = it.take(100) }, label = { Text(stringResource(R.string.playlist_name)) }, singleLine = true) },
        confirmButton = { TextButton({ save(name.trim()) }, enabled = name.isNotBlank()) { Text(stringResource(R.string.save)) } }, dismissButton = { TextButton(dismiss) { Text(stringResource(R.string.cancel)) } })
}
