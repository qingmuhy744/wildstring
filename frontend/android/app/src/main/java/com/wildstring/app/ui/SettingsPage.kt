@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** A destination with one scroll owner. The toolbar never participates in content dragging. */
@Composable internal fun SettingsPage(
    back: () -> Unit,
    bottomBar: @Composable () -> Unit = {},
    scrollState: ScrollState = rememberSaveable(saver = ScrollState.Saver) { ScrollState(0) },
    content: @Composable ColumnScope.() -> Unit,
) {
    BackHandler(onBack = back)
    Scaffold(modifier = Modifier.fillMaxSize().testTag("settings-page"),
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
        bottomBar = {
            bottomBar()
        },
        topBar = {
            TopAppBar(title = { Text("设置") }, navigationIcon = {
                IconButton(back, Modifier.testTag("settings-back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
            }, windowInsets = WindowInsets(0, 0, 0, 0),
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow))
        }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            Column(Modifier.widthIn(max = 720.dp).fillMaxHeight().fillMaxWidth()
                .verticalScroll(scrollState, overscrollEffect = null)
                .testTag("settings-scroll").padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp), content = content)
        }
    }
}
