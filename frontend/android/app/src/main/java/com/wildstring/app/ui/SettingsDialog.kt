@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package com.wildstring.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.painterResource
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

@Composable internal fun SettingsDialog(vm: MusicViewModel, dismiss: () -> Unit) {
    val preferences by vm.settings.state.collectAsStateWithLifecycle()
    val state by vm.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var usage by remember { mutableStateOf(Triple(0L, 0L, 0L)) }
    var message by remember { mutableStateOf<String?>(null) }
    var clearing by remember { mutableStateOf(false) }
    LaunchedEffect(preferences, clearing) { while (true) { usage = vm.cacheUsage(); delay(2_000) } }
    fun mb(bytes: Long) = "%.1f MB".format(bytes / 1048576.0)
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().heightIn(max = 680.dp).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Text("设置", style = MaterialTheme.typography.headlineSmall)
                TextButton(dismiss) { Text("完成") }
            }
            Text("外观", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FilterChip(!preferences.redCloth, tactile(vm) { vm.settings.theme(false) }, label = { Text("经典野弦") })
                FilterChip(preferences.redCloth, tactile(vm) { vm.settings.theme(true) }, label = { Text("一块红布") })
            }
            if (!preferences.redCloth) {
                Text("日夜模式", style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色").forEach { (mode, label) ->
                        FilterChip(preferences.appearance == mode, tactile(vm) { vm.settings.appearance(mode) }, label = { Text(label) })
                    }
                }
            } else Text("红布彩蛋保持固定配色。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text("桌面图标", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf(false to "经典", true to "红布").forEach { (red, label) ->
                    FilterChip(preferences.redIcon == red, tactile(vm) {
                        runCatching { vm.settings.icon(red) }.onFailure { message = "图标切换失败，请重试。" }
                    }, label = { Text(label) }, leadingIcon = { Icon(painterResource(if (red) R.drawable.ic_red_cloth else R.drawable.ic_wildstring), null, Modifier.size(28.dp), tint = Color.Unspecified) })
                }
            }
            Text("桌面可能需要片刻更新图标。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            HorizontalDivider()
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("轻触反馈", style = MaterialTheme.typography.titleMedium)
                    Text("关键按钮轻震一下，遵循系统触感设置", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(preferences.haptics, vm.settings::haptics)
            }
            HorizontalDivider()
            Text("缓存", style = MaterialTheme.typography.titleMedium)
            CacheLimit("曲库与歌词 · ${mb(usage.first)}", preferences.metadataMb, listOf(0, 8, 32, 64)) { vm.settings.limits(it, preferences.artworkMb, preferences.audioMb) }
            CacheLimit("封面 · ${mb(usage.second)}", preferences.artworkMb, listOf(0, 32, 64, 128)) { vm.settings.limits(preferences.metadataMb, it, preferences.audioMb) }
            CacheLimit("最近播放音频 · ${mb(usage.third)}", preferences.audioMb, listOf(0, 128, 256, 512, 1024)) { vm.settings.limits(preferences.metadataMb, preferences.artworkMb, it) }
            Text("已看过的内容会优先显示，联网后刷新。音频随播放缓存，短时断网可继续读取已缓存片段；尚未缓存的部分仍需联网。缓存可能被系统回收。", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(tactile(vm) { clearing = true; scope.launch { vm.clearCache().join(); clearing = false; message = "缓存已清理，播放过程中可能继续产生缓存。" } }, enabled = !clearing) { Text(if (clearing) "正在清理…" else "清理缓存") }
            message?.let { Text(it, fontSize = 12.sp) }
            HorizontalDivider()
            Text("野弦 ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.titleMedium)
            Text(state.server, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton({ dismiss(); vm.logout() }) { Text("退出登录 / 更换服务器") }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable private fun CacheLimit(label: String, value: Int, options: List<Int>, change: (Int) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, Modifier.weight(1f), fontSize = 13.sp)
        Box {
            TextButton({ expanded = true }) { Text(if (value == 0) "关闭" else "$value MB") }
            DropdownMenu(expanded, { expanded = false }) { options.forEach { option ->
                DropdownMenuItem(text = { Text(if (option == 0) "关闭" else "$option MB") }, onClick = { change(option); expanded = false })
            } }
        }
    }
}

/** Static vector folds keep the theme inexpensive while music is playing. */
@Composable internal fun RedClothBackdrop() {
    Canvas(Modifier.fillMaxSize().background(Color(0xFFD21A25))) {
        drawRect(Brush.linearGradient(listOf(Color(0xFFE3252B), Color(0xFFD11722), Color(0xFFB40816)),
            start = Offset.Zero, end = Offset(size.width, size.height)))
        // Broad vertical folds, with their own light/shadow gradient, read as draped fabric.
        for (fold in 0..8) {
            val x = size.width * (fold / 8f)
            val width = size.width * .18f
            val path = Path().apply {
                moveTo(x - width * .55f, 0f)
                cubicTo(x + width * .30f, size.height * .28f, x - width * .70f, size.height * .70f, x - width * .05f, size.height)
                lineTo(x + width * .75f, size.height)
                cubicTo(x + width * .10f, size.height * .70f, x + width * 1.10f, size.height * .28f, x + width * .25f, 0f)
                close()
            }
            drawPath(path, Brush.horizontalGradient(listOf(Color(0x00FF6255), Color(0x66FF6255), Color(0x0090000A), Color(0x66800009), Color(0x0090000A)),
                startX = x - width * .55f, endX = x + width * .9f))
        }
        // A faint stationary weave adds cloth texture without a continuously running animation.
        for (thread in 0..100) {
            val x = size.width * thread / 100f
            drawLine(Color.White.copy(alpha = .018f), Offset(x, 0f), Offset(x, size.height), strokeWidth = 1f)
        }
    }
}
