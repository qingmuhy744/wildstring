@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import com.wildstring.app.R
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.QueueMusic
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp

@Composable internal fun CatalogTopBar(state: MusicState, back: () -> Unit, settings: () -> Unit, compact: Boolean = false,
    unread: Int = 0, notifications: (() -> Unit)? = null, queue: (() -> Unit)? = null,
    recent: (() -> Unit)? = null, offline: (() -> Unit)? = null) {
    var menu by remember(state.contentKey) { mutableStateOf(false) }
    val title: @Composable () -> Unit = { Text(catalogTitle(state), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }
    val actions: @Composable RowScope.() -> Unit = {
        notifications?.let { open -> IconButton(open, Modifier.testTag("open-notifications")) {
            BadgedBox(badge = { if (unread > 0) Badge { Text(if (unread > 99) "99+" else unread.toString()) } }) { Icon(Icons.Default.NotificationsNone, stringResource(R.string.notifications)) }
        } }
        IconButton(settings) { Icon(Icons.Default.Settings, stringResource(R.string.settings_title)) }
        if (queue != null || recent != null || offline != null) Box {
            IconButton({ menu = true }, Modifier.testTag("catalog-global-more")) { Icon(Icons.Default.MoreVert, stringResource(R.string.more_options)) }
            DropdownMenu(menu, { menu = false }) {
                queue?.let { open -> DropdownMenuItem(text = { Text(stringResource(R.string.play_queue)) }, modifier = Modifier.testTag("catalog-open-queue"),
                    leadingIcon = { Icon(Icons.AutoMirrored.Filled.QueueMusic, null) }, onClick = { menu = false; open() }) }
                recent?.let { open -> DropdownMenuItem(text = { Text(stringResource(R.string.recently_played)) }, modifier = Modifier.testTag("catalog-open-recent"),
                    leadingIcon = { Icon(Icons.Default.History, null) }, onClick = { menu = false; open() }) }
                offline?.let { open -> DropdownMenuItem(text = { Text(stringResource(R.string.offline_music)) }, modifier = Modifier.testTag("catalog-open-offline"),
                    leadingIcon = { Icon(Icons.Default.Download, null) }, onClick = { menu = false; open() }) }
            }
        }
    }
    val barColors = TopAppBarDefaults.topAppBarColors(
        containerColor = androidx.compose.ui.graphics.Color.Transparent,
        scrolledContainerColor = androidx.compose.ui.graphics.Color.Transparent,
    )
    if (state.canGoBack || compact) TopAppBar(title, navigationIcon = {
        if (state.canGoBack) IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.back_previous)) }
    }, actions = actions, colors = barColors, windowInsets = WindowInsets(0, 0, 0, 0))
    else MediumTopAppBar(title, actions = actions, colors = barColors, windowInsets = WindowInsets(0, 0, 0, 0))
}

@Composable internal fun LibraryTabs(kind: String, change: (String) -> Unit) {
    val tabs = listOf("albums" to stringResource(R.string.albums), "tracks" to stringResource(R.string.tracks), "artists" to stringResource(R.string.artists))
    val feedback = LocalTactileFeedback.current
    CompositionLocalProvider(LocalRippleConfiguration provides null) {
        PrimaryTabRow(tabs.indexOfFirst { it.first == kind }.coerceAtLeast(0)) {
            tabs.forEach { (id, label) ->
                Tab(
                    selected = kind == id,
                    onClick = {
                        if (kind != id) feedback(TactileKind.Tap)
                        change(id)
                    },
                    text = { Text(label) },
                    modifier = Modifier.testTag("catalog-$id"),
                )
            }
        }
    }
}

@Composable internal fun CatalogSearch(query: String, search: (String) -> Unit) {
    val keyboard = androidx.compose.ui.platform.LocalSoftwareKeyboardController.current
    var input by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue(query)) }
    // Query results may replace the catalogue, but must not replace an IME's composing buffer.
    LaunchedEffect(query) {
        if (input.text != query && input.composition == null) input = TextFieldValue(query, TextRange(query.length))
    }
    TextField(input, { value ->
        input = value
        if (value.composition == null && value.text != query) search(value.text)
    }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("catalog-search"),
        placeholder = { Text(stringResource(R.string.search_music)) }, singleLine = true, shape = RoundedCornerShape(28.dp),
        leadingIcon = { Icon(Icons.Default.Search, null) }, trailingIcon = {
            if (input.text.isNotEmpty()) IconButton({ input = TextFieldValue(""); search("") }) { Icon(Icons.Default.Close, stringResource(R.string.clear_search)) }
        }, colors = TextFieldDefaults.colors(unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
            focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest, unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
            focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent),
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Search),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onSearch = {
            input = input.copy(composition = null)
            if (input.text != query) search(input.text)
            keyboard?.hide()
        }))
}

@Composable internal fun PersonalHeader(vm: MusicViewModel, state: MusicState, recent: () -> Unit, compact: Boolean = false) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (!compact) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            AccountAvatar(vm, Modifier.size(56.dp))
            Column {
                Text(state.account?.username ?: stringResource(R.string.my_music), style = MaterialTheme.typography.titleLarge)
                Text(stringResource(R.string.personal_music_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
            ListItem(headlineContent = { Text(stringResource(R.string.recently_played)) }, supportingContent = { Text(stringResource(R.string.resume_music_hint)) },
                leadingContent = { Icon(Icons.Default.History, null) }, trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), modifier = Modifier.clickable(onClick = recent))
        }
    }
}

@Composable internal fun catalogTitle(state: MusicState): String = when {
    state.collection != null -> state.title
    state.kind == "recent" -> stringResource(R.string.recently_played)
    state.title == "最近添加的专辑" -> stringResource(R.string.recently_added_albums)
    state.title == "最近添加的歌曲" -> stringResource(R.string.recently_added_tracks)
    else -> stringResource(when (state.tab) {
        "mine" -> R.string.nav_mine
        "podcast" -> R.string.nav_radio
        "assistant" -> R.string.nav_assistant
        "library" -> R.string.nav_music
        else -> R.string.nav_discover
    })
}
