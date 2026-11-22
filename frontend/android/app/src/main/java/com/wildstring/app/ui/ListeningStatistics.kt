package com.wildstring.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.wildstring.app.R
import com.wildstring.app.data.ListeningRankingItem
import com.wildstring.app.data.ListeningSummary
import java.text.NumberFormat

@Composable
internal fun StatisticsPanel(vm: MusicViewModel) {
    var summary by remember { mutableStateOf<ListeningSummary?>(null) }
    var ranking by remember { mutableStateOf<List<ListeningRankingItem>?>(null) }
    val summaryAction = remember { FeatureAction() }
    val rankingAction = remember { FeatureAction() }
    var summaryRequest by remember { mutableIntStateOf(0) }
    var rankingRequest by remember { mutableIntStateOf(0) }
    LaunchedEffect(summaryRequest) {
        summaryAction.run { summary = vm.repository.api().listeningSummary() }
    }
    LaunchedEffect(rankingRequest) {
        rankingAction.run {
            ranking = vm.repository.api().listeningRankings(period = "all", limit = 5)
                .items.filter { it.playCount > 0 }
        }
    }
    val locale = LocalConfiguration.current.locales[0]
    val number = remember(locale) { NumberFormat.getIntegerInstance(locale) }
    val rows = ranking.orEmpty()
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
        LazyColumn(
            Modifier.widthIn(max = 760.dp).fillMaxWidth().testTag("listening-statistics"),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
        ) {
            item {
                val summaryError = summaryAction.message?.takeUnless { it == DONE_STATUS }
                ListeningTotals(summary, number)
                if (summaryError != null) {
                    StatisticsRetry(summaryError) { summaryRequest++ }
                } else if (summary == null) {
                    LinearProgressIndicator(Modifier.fillMaxWidth().padding(top = 8.dp))
                }
            }
            item {
                Text(
                    stringResource(R.string.statistics_top_tracks),
                    Modifier.padding(top = 24.dp, bottom = 8.dp),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
            itemsIndexed(rows, key = { _, entry -> entry.track.id }) { index, entry ->
                val track = entry.track
                Row(
                    Modifier.fillMaxWidth()
                        .clickable(onClickLabel = stringResource(R.string.play)) {
                            vm.play(rows.map { it.track }, index)
                        }
                        .padding(vertical = 8.dp)
                        .testTag("statistics-track-${track.id}"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text(
                        number.format(entry.rank),
                        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Cover(vm, track.coverId, "", Modifier.size(48.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(track.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            track.artist, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Text(
                        stringResource(R.string.play_count_value, entry.playCount),
                        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Icon(Icons.Default.PlayArrow, null, tint = MaterialTheme.colorScheme.primary)
                }
            }
            if (rows.isEmpty()) item {
                val rankingError = rankingAction.message?.takeUnless { it == DONE_STATUS }
                when {
                    rankingError != null -> StatisticsRetry(rankingError) { rankingRequest++ }
                    ranking == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
                    else -> Text(
                        stringResource(R.string.statistics_no_records),
                        Modifier.padding(vertical = 8.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun ListeningTotals(summary: ListeningSummary?, number: NumberFormat) {
    val minutes = summary?.listenedMs?.div(60_000)
    val duration = when {
        minutes == null -> "—"
        minutes >= 60 -> stringResource(R.string.statistics_hours_minutes, minutes / 60, minutes % 60)
        else -> stringResource(R.string.statistics_duration_minutes, minutes)
    }
    val metrics = listOf(
        R.string.statistics_play_count to summary?.playCount,
        R.string.statistics_played_tracks to summary?.playedTracks?.toLong(),
        R.string.statistics_loved_tracks to summary?.lovedTracks?.toLong(),
    )
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(
                Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        stringResource(R.string.statistics_total_listening),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(duration, style = MaterialTheme.typography.headlineLarge.copy(fontFeatureSettings = "tnum"))
                }
                Icon(
                    Icons.Default.Headphones, null, Modifier.size(32.dp),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                metrics.forEach { (label, value) ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            value?.let(number::format) ?: "—",
                            style = MaterialTheme.typography.titleLarge.copy(fontFeatureSettings = "tnum"),
                        )
                        Text(
                            stringResource(label), style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun StatisticsRetry(message: String, retry: () -> Unit) {
    Column(Modifier.padding(top = 8.dp)) {
        Text(message, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        TextButton(retry) { Text(stringResource(R.string.retry)) }
    }
}
