@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.testTag
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import com.wildstring.app.data.CacheLimits
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalResources
import com.wildstring.app.R
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.wildstring.app.BuildConfig
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable internal fun delayed(active: Boolean, delayMs: Long): Boolean {
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(active) { visible = false; if (active) { delay(delayMs); visible = true } }
    return active && visible
}

private val LocalSettingsFeedback = staticCompositionLocalOf<() -> Unit> { {} }

internal enum class SettingsSection(@androidx.annotation.StringRes val title: Int, @androidx.annotation.StringRes val summary: Int, val icon: ImageVector) {
    Account(R.string.settings_category_account, R.string.settings_account_summary, Icons.Default.AccountCircle),
    Playback(R.string.settings_category_playback, R.string.settings_playback_summary, Icons.Default.GraphicEq),
    Podcast(R.string.settings_category_podcast, R.string.settings_podcast_summary, Icons.Default.Podcasts),
    Appearance(R.string.settings_category_appearance, R.string.settings_appearance_summary, Icons.Default.Palette),
    Storage(R.string.settings_category_storage, R.string.settings_storage_summary, Icons.Default.Storage),
    Assistant(R.string.settings_group_assistant, R.string.settings_assistant_summary, Icons.Default.AutoAwesome),
    About(R.string.settings_group_about, R.string.settings_about_summary, Icons.Default.Info),
}

@Composable internal fun SettingsScreen(vm: MusicViewModel, wide: Boolean = false, bottomBar: @Composable () -> Unit = {}, back: () -> Unit) {
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    val settingsOwner = vm.repository.session.cacheScope()
    var section by rememberSaveable(settingsOwner) { mutableStateOf<SettingsSection?>(null) }
    val activeSection = section ?: if (wide) SettingsSection.Account else null
    val sidebarScroll = rememberSaveable(saver = ScrollState.Saver) { ScrollState(0) }
    val pages = rememberSaveableStateHolder()
    val scope = rememberCoroutineScope()
    val feedback = LocalTactileFeedback.current
    var usage by remember(settingsOwner) { mutableStateOf(Triple(0L, 0L, 0L)) }
    var message by remember(settingsOwner) { mutableStateOf<String?>(null) }
    var clearing by remember(settingsOwner) { mutableStateOf(false) }
    var profile by remember(settingsOwner) { mutableStateOf(false) }
    var password by remember(settingsOwner) { mutableStateOf(false) }
    var servers by remember(settingsOwner) { mutableStateOf(false) }
    var logout by remember(settingsOwner) { mutableStateOf(false) }
    var diagnostics by remember(settingsOwner) { mutableStateOf(false) }
    var crashReports by remember(settingsOwner) { mutableStateOf(false) }
    var downloadTasks by remember(settingsOwner) { mutableStateOf(false) }
    var feature by remember(settingsOwner) { mutableStateOf<String?>(null) }
    var podcastPlayback by remember(settingsOwner) { mutableStateOf<com.wildstring.app.data.PodcastPlaybackSettings?>(null) }
    var savingPodcastPlayback by remember(settingsOwner) { mutableStateOf(false) }
    val inbox by vm.agent.inbox.collectAsStateWithLifecycle()
    LaunchedEffect(activeSection, preferences, clearing, feature, state.current?.id) {
        if (activeSection == SettingsSection.Storage) usage = vm.cacheUsage()
    }
    LaunchedEffect(settingsOwner, activeSection) {
        if (activeSection != SettingsSection.Podcast) return@LaunchedEffect
        try {
            val loaded = vm.repository.podcastPlaybackSettings()
            if (settingsOwner == vm.repository.session.cacheScope()) podcastPlayback = loaded
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { if (settingsOwner == vm.repository.session.cacheScope()) podcastPlayback = null }
    }
    fun mb(bytes: Long) = "%.1f MB".format(bytes / 1048576.0)
    val resources = LocalResources.current
    val sidebar: (@Composable () -> Unit)? = if (wide) {
        {
            SettingsSection.entries.forEach { item ->
                NavigationDrawerItem(
                    label = { Text(stringResource(item.title)) },
                    selected = activeSection == item,
                    onClick = { section = item; message = null },
                    icon = { Icon(item.icon, null) },
                    modifier = Modifier.fillMaxWidth().testTag("setting-category-${item.name.lowercase()}"),
                )
            }
        }
    } else null
    CompositionLocalProvider(LocalSettingsFeedback provides tactile {}) {
        pages.SaveableStateProvider("$settingsOwner:${activeSection?.name ?: "home"}") {
            SettingsPage(back = { if (wide || section == null) back() else { section = null; message = null } }, bottomBar = bottomBar,
                sidebarScrollState = sidebarScroll, sidebar = sidebar,
                title = stringResource(if (wide) R.string.settings_title else activeSection?.title ?: R.string.settings_title)) {
            when (activeSection) {
                null -> Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
                    Column {
                        SettingsSection.entries.forEach { item ->
                            SettingsAction(stringResource(item.title), item.icon,
                                subtitle = if (item == SettingsSection.Account) state.account?.let {
                                    "${it.displayName?.takeIf(String::isNotBlank) ?: it.username} · ${stringResource(roleLabel(it.profile))}"
                                } ?: stringResource(item.summary) else stringResource(item.summary),
                                tag = "category-${item.name.lowercase()}") { section = item }
                        }
                    }
                }
                SettingsSection.Account -> {
                    SettingsGroup(stringResource(R.string.settings_group_account)) {
                        val acc = state.account
                        val role = acc?.let { stringResource(roleLabel(it.profile)) }
                        val header = if (acc != null) {
                            if (!acc.displayName.isNullOrBlank()) "${acc.displayName} (${acc.username}) · $role"
                            else "${acc.username} · $role"
                        } else stringResource(R.string.settings_connected)
                        ListItem(headlineContent = { Text(header) },
                            supportingContent = { Text(state.server) }, leadingContent = { Icon(Icons.Default.AccountCircle, null) })
                        SettingsAction(stringResource(R.string.settings_servers), Icons.Default.Dns) { servers = true }
                        if (state.account != null) SettingsAction(stringResource(R.string.settings_profile), Icons.Default.Badge) { profile = true }
                        if (state.account != null) AvatarSettings(vm)
                        if (state.account != null) SettingsAction(stringResource(R.string.settings_change_password), Icons.Default.Lock) { password = true }
                        SettingsAction(stringResource(R.string.logout), Icons.AutoMirrored.Filled.Logout) { logout = true }
                    }
                    SettingsGroup("Last.fm") { LastfmSettings(vm) }
                    if (state.account?.isOwner == true) SettingsGroup(stringResource(R.string.settings_group_server_admin)) {
                        Text(
                            stringResource(R.string.settings_server_admin_hint),
                            Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                SettingsSection.Playback -> {
                    SettingsGroup(stringResource(R.string.settings_group_playback)) {
                        val qualityLabel: (Int) -> String = { rate -> if (rate == 0) resources.getString(R.string.quality_original) else resources.getString(R.string.quality_aac, rate) }
                        SettingsChoice(stringResource(R.string.settings_quality), qualityLabel(preferences.aacBitrate), Icons.Default.GraphicEq,
                            com.wildstring.app.data.PlaybackRequest.bitrates.map { it to qualityLabel(it) }, preferences.aacBitrate,
                            stringResource(R.string.settings_quality_hint), vm.settings::quality, tag = "quality")
                        SettingsChoice(stringResource(R.string.settings_lyric_follow), stringResource(R.string.seconds_value, preferences.lyricFollowSeconds), Icons.Default.Lyrics,
                            listOf(1, 2, 3, 5, 10).map { it to resources.getString(R.string.seconds_value, it) }, preferences.lyricFollowSeconds,
                            stringResource(R.string.settings_lyric_follow_hint), vm.settings::lyricFollowSeconds)
                        SettingsChoice(stringResource(R.string.settings_lyric_size), stringResource(lyricSizeLabel(preferences.lyricSize)), Icons.Default.FormatSize,
                            com.wildstring.app.data.LyricSize.entries.map { it to resources.getString(lyricSizeLabel(it)) }, preferences.lyricSize,
                            stringResource(R.string.settings_lyric_size_hint), vm.settings::lyricSize)
                        SettingsAction(stringResource(R.string.settings_diagnostics), Icons.Default.Troubleshoot, subtitle = stringResource(R.string.settings_diagnostics_hint)) { diagnostics = true }
                    }
                    SettingsGroup(stringResource(R.string.settings_group_handoff)) {
                        val syncMode by vm.sharing.mode.collectAsStateWithLifecycle()
                        val syncSubtitle = stringResource(when (syncMode) {
                            "off" -> R.string.handoff_off
                            "auto" -> R.string.handoff_auto
                            else -> R.string.handoff_hint
                        })
                        SettingsAction(stringResource(R.string.settings_music_handoff), Icons.Default.Devices, subtitle = syncSubtitle) { feature = "devices" }
                    }
                }
                SettingsSection.Podcast -> {
                    SettingsGroup(stringResource(R.string.settings_podcast_resume)) {
                        val podcastMode by vm.podcastProgress.mode.collectAsStateWithLifecycle()
                        SettingsChoice(stringResource(R.string.settings_podcast_resume), stringResource(when(podcastMode) { "auto" -> R.string.podcast_resume_auto_value; "restart" -> R.string.podcast_resume_restart_value; else -> R.string.podcast_resume_ask_value }), Icons.Default.Podcasts,
                            listOf("ask" to stringResource(R.string.podcast_resume_ask), "auto" to stringResource(R.string.podcast_resume_auto), "restart" to stringResource(R.string.podcast_resume_restart)), podcastMode,
                            stringResource(R.string.podcast_resume_hint), vm.podcastProgress::mode)
                    }
                    SettingsGroup(stringResource(R.string.podcast_continue_group)) {
                        val cloud by vm.podcastCloud.collectAsStateWithLifecycle()
                        LaunchedEffect(settingsOwner) { vm.refreshPodcastQueuePreferences() }
                        val autoContinue = cloud.preferences?.autoContinue ?: vm.settings.podcastContinuePreference().autoContinue
                        ListItem(
                            headlineContent = { Text(stringResource(R.string.podcast_continue)) },
                            supportingContent = { Text(stringResource(R.string.podcast_continue_hint)) },
                            leadingContent = { Icon(Icons.Default.Podcasts, null) },
                            trailingContent = { Switch(autoContinue, vm::updatePodcastAutoContinue) },
                        )
                        cloud.preferencesError?.let { message ->
                            Text(message, Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                            TextButton({ vm.updatePodcastAutoContinue(autoContinue) }, Modifier.padding(horizontal = 8.dp)) { Text(stringResource(R.string.podcast_sync_retry)) }
                        }
                    }
                    podcastPlayback?.let { playback ->
                        SettingsGroup(stringResource(R.string.settings_group_podcast_cache)) {
                            val savePodcastPlayback: (com.wildstring.app.data.PodcastPlaybackSettings) -> Unit = save@{ next ->
                                if (savingPodcastPlayback || settingsOwner != vm.repository.session.cacheScope()) return@save
                                podcastPlayback = next; savingPodcastPlayback = true
                                scope.launch {
                                    try {
                                        val saved = vm.repository.updatePodcastPlaybackSettings(next, settingsOwner)
                                        if (settingsOwner == vm.repository.session.cacheScope()) {
                                            podcastPlayback = saved; message = resources.getString(R.string.podcast_cache_saved)
                                        }
                                    } catch (e: kotlinx.coroutines.CancellationException) { throw e }
                                    catch (_: Exception) {
                                        if (settingsOwner == vm.repository.session.cacheScope()) {
                                            podcastPlayback = playback; message = resources.getString(R.string.podcast_cache_failed)
                                        }
                                    } finally { if (settingsOwner == vm.repository.session.cacheScope()) savingPodcastPlayback = false }
                                }
                            }
                            ListItem(
                                headlineContent = { Text(stringResource(R.string.podcast_cache_current)) },
                                supportingContent = { Text(stringResource(R.string.podcast_cache_current_hint)) },
                                leadingContent = { Icon(Icons.Default.Podcasts, null) },
                                trailingContent = { Switch(playback.autoCacheCurrent, { enabled -> savePodcastPlayback(playback.copy(autoCacheCurrent = enabled)) }, enabled = !savingPodcastPlayback) },
                            )
                            ListItem(
                                headlineContent = { Text(stringResource(R.string.podcast_prefetch)) },
                                supportingContent = { Text(stringResource(R.string.podcast_prefetch_hint)) },
                                leadingContent = { Icon(Icons.Default.SkipNext, null) },
                                trailingContent = { Switch(playback.prefetchNext, { enabled -> savePodcastPlayback(playback.copy(prefetchNext = enabled)) }, enabled = !savingPodcastPlayback) },
                            )
                            SettingsChoice(
                                stringResource(R.string.podcast_cache_network),
                                stringResource(when (playback.networkPolicy) { "off" -> R.string.network_off; "any" -> R.string.network_any; else -> R.string.network_wifi }),
                                Icons.Default.NetworkCheck,
                                listOf("off" to stringResource(R.string.network_off), "wifi" to stringResource(R.string.network_wifi_recommended), "any" to stringResource(R.string.network_any)),
                                playback.networkPolicy,
                                stringResource(R.string.podcast_cache_network_hint),
                                change = { policy -> savePodcastPlayback(playback.copy(networkPolicy = policy)) },
                            )
                        }
                    }
                    SettingsGroup(stringResource(R.string.podcast_download_tasks)) {
                        SettingsAction(stringResource(R.string.podcast_download_tasks), Icons.Default.Downloading, tag = "podcast-download-tasks") {
                            downloadTasks = true
                        }
                    }
                }
                SettingsSection.Appearance -> {
                    SettingsGroup(stringResource(R.string.settings_group_appearance)) {
                        state.account?.let { account -> LanguageChoice(vm, account.language) { message = it } }
                        Text(
                            stringResource(R.string.settings_appearance_note),
                            Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )

                        SettingsChoice(stringResource(R.string.settings_song_list_size), stringResource(songListSizeLabel(preferences.songListSize)), Icons.Default.FormatSize,
                            com.wildstring.app.data.SongListSize.entries.map { it to resources.getString(songListSizeLabel(it)) }, preferences.songListSize,
                            stringResource(R.string.settings_song_list_size_hint), vm.settings::songListSize, tag = "song-list-size")
                        val styles = playbackStyles.map { (id, _) -> id to resources.getString(playbackStyleLabel(id)) }
                        SettingsChoice(stringResource(R.string.settings_playback_style), styles.first { it.first == preferences.playbackStyle }.second, Icons.Default.Style,
                            styles, preferences.playbackStyle, change = vm.settings::playbackStyle, tag = "playback-style")
                        SettingsChoice(stringResource(R.string.settings_day_night), stringResource(when (preferences.appearance) { "light" -> R.string.appearance_light; "dark" -> R.string.appearance_dark; else -> R.string.appearance_system }), Icons.Default.BrightnessAuto,
                            listOf("system" to stringResource(R.string.appearance_system), "light" to stringResource(R.string.appearance_light), "dark" to stringResource(R.string.appearance_dark)), preferences.appearance, change = vm.settings::appearance, tag = "day-night")
                        SettingsChoice(stringResource(R.string.settings_orientation), stringResource(when (preferences.orientation) { "portrait" -> R.string.orientation_portrait; "sensor" -> R.string.orientation_sensor; else -> R.string.orientation_auto }), Icons.Default.ScreenRotation,
                            listOf("auto" to stringResource(R.string.orientation_auto_option), "portrait" to stringResource(R.string.orientation_portrait), "sensor" to stringResource(R.string.orientation_sensor_option)), preferences.orientation,
                            stringResource(R.string.settings_orientation_hint), change = vm.settings::orientation)
                        ListItem(headlineContent = { Text(stringResource(R.string.settings_haptics)) }, supportingContent = { Text(stringResource(R.string.settings_haptics_hint)) },
                            leadingContent = { Icon(Icons.Default.Vibration, null) },
                            trailingContent = { Switch(preferences.haptics, { enabled -> vm.settings.haptics(enabled); if (enabled) feedback(TactileKind.Tap) }) },
                            modifier = Modifier.clickable {
                                val enabled = !preferences.haptics
                                vm.settings.haptics(enabled)
                                if (enabled) feedback(TactileKind.Tap)
                            })
                    }
                }
                SettingsSection.Storage -> {
                    SettingsGroup(stringResource(R.string.settings_group_cache)) {
                        CacheLimit(stringResource(R.string.cache_metadata), usage.first, preferences.metadataMb, CacheLimits.metadataMb) { vm.settings.limits(it, preferences.artworkMb, preferences.audioMb) }
                        CacheLimit(stringResource(R.string.cache_artwork), usage.second, preferences.artworkMb, CacheLimits.artworkMb) { vm.settings.limits(preferences.metadataMb, it, preferences.audioMb) }
                        CacheLimit(stringResource(R.string.cache_audio), usage.third, preferences.audioMb, CacheLimits.audioMb, tag = "audio-cache") { vm.settings.limits(preferences.metadataMb, preferences.artworkMb, it) }
                        SettingsAction(stringResource(if (clearing) R.string.cache_clearing else R.string.cache_clear), Icons.Default.DeleteOutline, enabled = !clearing) {
                            clearing = true
                            scope.launch { vm.clearCache().join(); clearing = false; message = resources.getString(R.string.cache_cleared) }
                        }
                        Text(stringResource(R.string.cache_summary, mb(usage.first + usage.second + usage.third)),
                            Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    SettingsGroup(stringResource(R.string.settings_downloads)) {
                        SettingsAction(stringResource(R.string.offline_music), Icons.Default.Download,
                            subtitle = stringResource(R.string.settings_downloads_summary), tag = "downloads") { feature = "offline" }
                    }
                }
                SettingsSection.Assistant -> {
                    SettingsGroup(stringResource(R.string.settings_group_assistant)) {
                        SettingsAction(stringResource(R.string.notifications), Icons.Default.Notifications,
                            tag = "inbox") { feature = "notifications" }
                        Text(if (inbox.owner == vm.repository.session.cacheScope() && inbox.unread > 0) stringResource(R.string.settings_unread, inbox.unread) else stringResource(R.string.settings_assistant_hint),
                            Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        SettingsAction(stringResource(R.string.settings_research), Icons.Default.TravelExplore) { feature = "research" }
                        SettingsAction(stringResource(R.string.settings_notifications), Icons.Default.Notifications) { feature = "channels" }
                    }
                }
                SettingsSection.About -> {
                    SettingsGroup(stringResource(R.string.settings_group_about)) {
                        com.wildstring.app.update.UpdateSettings()
                        SettingsAction(
                            stringResource(R.string.settings_crash_reports),
                            Icons.Default.BugReport,
                            subtitle = stringResource(R.string.settings_crash_reports_summary),
                            tag = "crash-reports",
                        ) { crashReports = true }
                        ListItem(headlineContent = { Text(stringResource(R.string.brand_name)) }, supportingContent = { Text(stringResource(R.string.about_version, BuildConfig.VERSION_NAME) + (state.serverVersion?.let { stringResource(R.string.about_server_version, it) } ?: "")) },
                            leadingContent = { Icon(painterResource(R.drawable.ic_wildstring), null, Modifier.size(36.dp), tint = Color.Unspecified) })
                    }
                }
            }
            message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Spacer(Modifier.height(8.dp))
            }
        }
    }
    if (servers) ServersScreen(vm) { servers = false }
    if (diagnostics) PlaybackDiagnosticsDialog(vm) { diagnostics = false }
    if (crashReports) CrashReportsDialog { crashReports = false }
    if (downloadTasks) PodcastDownloadQueueDialog(vm = vm, onDismiss = { downloadTasks = false })
    feature?.let { route -> FeatureDialog(vm, route) { feature = null } }
    if (logout) AlertDialog(onDismissRequest = { logout = false }, title = { Text(stringResource(R.string.logout_title)) }, text = { Text(stringResource(R.string.logout_message)) }, confirmButton = { TextButton({ logout = false; back(); vm.logout() }) { Text(stringResource(R.string.logout)) } }, dismissButton = { TextButton({ logout = false }) { Text(stringResource(R.string.cancel)) } })
    if (profile) ProfileDialog(vm) { profile = false }
    if (password) PasswordDialog(vm) { password = false }
}

@Composable private fun SettingsGroup(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, Modifier.padding(start = 16.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxWidth(), content = content)
        }
    }
}

@Composable private fun SettingsAction(title: String, icon: ImageVector, enabled: Boolean = true, subtitle: String? = null, tag: String = title, action: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) },
        supportingContent = subtitle?.let { { Text(it) } },
        leadingContent = { Icon(icon, null) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
        modifier = Modifier.testTag("setting-$tag").clickable(enabled = enabled, onClick = action),
    )
}

@Composable private fun <T> SettingsChoice(title: String, value: String, icon: ImageVector, choices: List<Pair<T, String>>, selected: T,
    description: String? = null, change: (T) -> Unit, tag: String = title) {
    var open by rememberSaveable { mutableStateOf(false) }
    val feedback = LocalSettingsFeedback.current
    ListItem(headlineContent = { Text(title) }, supportingContent = { Text(value) }, leadingContent = { Icon(icon, null) },
        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) }, modifier = Modifier.testTag("setting-$tag").clickable { open = true })
    if (open) AlertDialog(onDismissRequest = { open = false }, title = { Text(title) }, text = {
        Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()).testTag("setting-choices-$tag")) {
            description?.let { Text(it, Modifier.padding(bottom = 12.dp), style = MaterialTheme.typography.bodySmall) }
            choices.forEach { (id, label) ->
                Row(Modifier.fillMaxWidth().testTag("setting-option-$tag-$id").selectable(selected == id, role = Role.RadioButton, onClick = { feedback(); change(id); open = false })
                    .padding(vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected == id, onClick = null)
                    Text(label, Modifier.padding(start = 16.dp))
                }
            }
        }
    }, confirmButton = { TextButton({ open = false }) { Text(stringResource(R.string.cancel)) } })
}

@Composable private fun PasswordDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val count = next.codePointCount(0, next.length)
    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text(stringResource(R.string.settings_change_password)) },
        text = { Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.password_note), fontSize = 12.sp)
            listOf(stringResource(R.string.current_password) to current, stringResource(R.string.new_password) to next, stringResource(R.string.confirm_password) to confirm).forEachIndexed { index, (label, value) ->
                OutlinedTextField(value, { text -> when (index) { 0 -> current = text.take(256); 1 -> next = text.take(256); else -> confirm = text.take(256) } }, label = { Text(label) },
                    singleLine = true, enabled = !busy, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password))
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        } },
        confirmButton = { TextButton({
            busy = true; error = null
            scope.launch {
                try { vm.changePassword(current, next); dismiss() }
                catch (e: kotlinx.coroutines.CancellationException) { throw e }
                catch (e: Exception) { error = com.wildstring.app.data.friendlyError(e) }
                finally { busy = false }
            }
        }, enabled = !busy && current.isNotEmpty() && count in 12..128 && confirm == next) { Text(stringResource(if (busy) R.string.password_changing else R.string.password_save)) } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text(stringResource(R.string.cancel)) } })
}

@Composable private fun ProfileDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    val account = vm.state.value.account ?: return
    var username by remember { mutableStateOf(account.username) }
    var displayName by remember { mutableStateOf(account.displayName.orEmpty()) }
    var email by remember { mutableStateOf(account.email.orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val usernameValid = username.trim().length in 1..32 && username.trim().all { it.isLetterOrDigit() || it in "_-." }
    val emailValid = email.isBlank() || (email.contains('@') && email.length <= 254)
    val changed = username.trim() != account.username || displayName.trim() != account.displayName.orEmpty() || email.trim() != account.email.orEmpty()

    AlertDialog(onDismissRequest = { if (!busy) dismiss() }, title = { Text(stringResource(R.string.profile_title)) },
        text = { Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.profile_note), fontSize = 12.sp)
            OutlinedTextField(username, { username = it.take(32) }, label = { Text(stringResource(R.string.login_id)) },
                singleLine = true, enabled = !busy)
            OutlinedTextField(displayName, { displayName = it.take(50) }, label = { Text(stringResource(R.string.display_name)) },
                singleLine = true, enabled = !busy)
            OutlinedTextField(email, { email = it.take(254) }, label = { Text(stringResource(R.string.email_profile)) },
                singleLine = true, enabled = !busy,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Email))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        } },
        confirmButton = { TextButton({
            busy = true; error = null
            scope.launch {
                try {
                    vm.updateProfile(username.trim(), displayName.trim(), email.trim())
                    dismiss()
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = com.wildstring.app.data.friendlyError(e)
                } finally {
                    busy = false
                }
            }
        }, enabled = !busy && usernameValid && emailValid && changed) { Text(stringResource(if (busy) R.string.saving else R.string.profile_save)) } },
        dismissButton = { TextButton(dismiss, enabled = !busy) { Text(stringResource(R.string.cancel)) } })
}

@Composable private fun CacheLimit(label: String, used: Long, value: Int, options: List<Int>, tag: String = label, change: (Int) -> Unit) {
    val resources = LocalResources.current
    val limit: (Int) -> String = { mb -> when {
        mb == 0 -> resources.getString(R.string.cache_off)
        mb >= 1024 -> resources.getString(R.string.cache_gb, mb / 1024)
        else -> resources.getString(R.string.cache_mb, mb)
    } }
    SettingsChoice(label, stringResource(R.string.cache_limit_value, limit(value), "%.1f".format(used / 1048576.0)), Icons.Default.Storage,
        options.map { it to limit(it) }, value, change = change, tag = tag)
}

/** Account-wide interface language; saved on the server so every device follows it. */
@Composable private fun LanguageChoice(vm: MusicViewModel, current: String?, report: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val resources = LocalResources.current
    var saving by remember { mutableStateOf(false) }
    val selected = com.wildstring.app.AppLanguage.normalize(current)
    val choices = listOf("auto" to stringResource(R.string.language_auto), "zh" to stringResource(R.string.language_zh), "en" to stringResource(R.string.language_en))
    SettingsChoice(stringResource(R.string.settings_language), choices.first { it.first == selected }.second, Icons.Default.Language,
        choices, selected, stringResource(R.string.settings_language_hint), change = { next ->
            if (!saving && next != selected) {
                saving = true
                scope.launch {
                    // MainActivity applies the saved account language, so no local apply here.
                    try { vm.updateLanguage(next) }
                    catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (_: Exception) { report(resources.getString(R.string.language_failed)) }
                    finally { saving = false }
                }
            }
        }, tag = "language")
}

@androidx.annotation.StringRes internal fun roleLabel(profile: String): Int = when (profile) {
    "owner" -> R.string.role_owner
    "librarian" -> R.string.role_librarian
    "editor" -> R.string.role_editor
    else -> R.string.role_listener
}

@androidx.annotation.StringRes internal fun lyricSizeLabel(size: com.wildstring.app.data.LyricSize): Int = when (size) {
    com.wildstring.app.data.LyricSize.SMALL -> R.string.size_small
    com.wildstring.app.data.LyricSize.MEDIUM -> R.string.size_medium_default
    com.wildstring.app.data.LyricSize.LARGE -> R.string.size_large
}

@androidx.annotation.StringRes internal fun songListSizeLabel(size: com.wildstring.app.data.SongListSize): Int = when (size) {
    com.wildstring.app.data.SongListSize.SMALL -> R.string.size_small
    com.wildstring.app.data.SongListSize.MEDIUM -> R.string.size_medium_recommended
    com.wildstring.app.data.SongListSize.LARGE -> R.string.size_large
}

@androidx.annotation.StringRes internal fun playbackStyleLabel(id: String): Int = when (id) {
    "vinyl" -> R.string.style_vinyl
    "cassette" -> R.string.style_cassette
    else -> R.string.style_cover
}
