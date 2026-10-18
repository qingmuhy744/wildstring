@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
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

@Composable internal fun CatalogTopBar(state: MusicState, back: () -> Unit, refresh: () -> Unit, settings: () -> Unit, compact: Boolean = false, albumRefresh: (() -> Unit)? = null,
    unread: Int = 0, notifications: (() -> Unit)? = null) {
    var menu by remember { mutableStateOf(false) }
    val title: @Composable () -> Unit = { Text(state.title, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }
    val actions: @Composable RowScope.() -> Unit = {
        notifications?.let { open -> IconButton(open, Modifier.testTag("open-notifications")) {
            BadgedBox(badge = { if (unread > 0) Badge { Text(if (unread > 99) "99+" else unread.toString()) } }) { Icon(Icons.Default.NotificationsNone, "通知") }
        } }
        IconButton(settings) { Icon(Icons.Default.Settings, "设置") }
        Box {
            IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, "更多选项") }
            DropdownMenu(menu, { menu = false }) {
                albumRefresh?.let { update -> DropdownMenuItem(text = { Text("更新专辑元数据") }, leadingIcon = { Icon(Icons.Default.Edit, null) }, onClick = { menu = false; update() }) }
                DropdownMenuItem(text = { Text("刷新曲库") }, leadingIcon = { Icon(Icons.Default.Refresh, null) }, onClick = { menu = false; refresh() })
            }
        }
    }
    if (state.canGoBack || compact) TopAppBar(title, navigationIcon = {
        if (state.canGoBack) IconButton(back) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回上一页") }
    }, actions = actions, windowInsets = WindowInsets(0, 0, 0, 0))
    else MediumTopAppBar(title, actions = actions, windowInsets = WindowInsets(0, 0, 0, 0))
}

@Composable internal fun LibraryTabs(kind: String, change: (String) -> Unit) {
    val tabs = listOf("albums" to "专辑", "tracks" to "歌曲", "artists" to "艺人")
    PrimaryTabRow(tabs.indexOfFirst { it.first == kind }.coerceAtLeast(0)) {
        tabs.forEach { (id, label) -> Tab(kind == id, { change(id) }, text = { Text(label) }, modifier = Modifier.testTag("catalog-$id")) }
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
        placeholder = { Text("搜索歌曲、艺人或专辑") }, singleLine = true, shape = RoundedCornerShape(28.dp),
        leadingIcon = { Icon(Icons.Default.Search, null) }, trailingIcon = {
            if (input.text.isNotEmpty()) IconButton({ input = TextFieldValue(""); search("") }) { Icon(Icons.Default.Close, "清空搜索") }
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
                Text(state.account?.username ?: "我的音乐", style = MaterialTheme.typography.titleLarge)
                Text("音乐，留在自己的收藏里", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
            ListItem(headlineContent = { Text("最近听过") }, supportingContent = { Text("继续上次的旋律") },
                leadingContent = { Icon(Icons.Default.History, null) }, trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null) },
                colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow), modifier = Modifier.clickable(onClick = recent))
        }
    }
}
