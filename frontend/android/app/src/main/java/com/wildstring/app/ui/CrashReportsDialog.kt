package com.wildstring.app.ui

import android.content.Intent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircleOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.wildstring.app.R
import com.wildstring.app.diagnostics.CrashHandler
import com.wildstring.app.diagnostics.CrashReport
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Suppress("DEPRECATION")
@Composable
internal fun CrashReportsDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    var reports by remember { mutableStateOf(CrashHandler.listReports(context)) }
    var selectedIndex by remember { mutableIntStateOf(0) }
    var copied by remember { mutableStateOf(false) }

    val selectedReport: CrashReport? = reports.getOrNull(selectedIndex)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(stringResource(R.string.settings_crash_reports))
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 520.dp)
            ) {
                if (reports.isEmpty()) {
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 28.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.CheckCircleOutline,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(48.dp)
                        )
                        Text(
                            text = stringResource(R.string.crash_reports_empty_title),
                            style = MaterialTheme.typography.titleMedium
                        )
                        Text(
                            text = stringResource(R.string.crash_reports_empty_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                } else {
                    Text(
                        text = stringResource(R.string.crash_reports_count, reports.size),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 8.dp)
                    )

                    if (reports.size > 1) {
                        val dateFormat = remember { SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()) }
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState())
                                .padding(bottom = 8.dp),
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            reports.forEachIndexed { index, report ->
                                val timeText = dateFormat.format(Date(report.timestamp))
                                FilterChip(
                                    selected = selectedIndex == index,
                                    onClick = {
                                        selectedIndex = index
                                        copied = false
                                    },
                                    label = {
                                        Text(
                                            "$timeText · ${report.summary}",
                                            fontSize = 11.sp,
                                            maxLines = 1
                                        )
                                    }
                                )
                            }
                        }
                    }

                    selectedReport?.let { report ->
                        Surface(
                            modifier = Modifier
                                .fillMaxWidth()
                                .weight(1f, fill = false),
                            shape = RoundedCornerShape(8.dp),
                            color = MaterialTheme.colorScheme.surfaceContainerHighest
                        ) {
                            val vScroll = rememberScrollState()
                            val hScroll = rememberScrollState()
                            SelectionContainer {
                                Text(
                                    text = report.content,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
                                    lineHeight = 15.sp,
                                    modifier = Modifier
                                        .verticalScroll(vScroll)
                                        .horizontalScroll(hScroll)
                                        .padding(10.dp)
                                        .testTag("crash-report-text")
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (reports.isNotEmpty() && selectedReport != null) {
                TextButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(selectedReport.content))
                        copied = true
                    },
                    modifier = Modifier.testTag("copy-crash-report")
                ) {
                    Text(if (copied) stringResource(R.string.copied) else stringResource(R.string.diagnostics_copy))
                }
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (reports.isNotEmpty()) {
                    TextButton(onClick = {
                        selectedReport?.let { report ->
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, report.content)
                                putExtra(Intent.EXTRA_SUBJECT, "WildString Crash Report")
                            }
                            context.startActivity(Intent.createChooser(intent, null))
                        }
                    }) {
                        Text(stringResource(R.string.crash_share))
                    }
                    TextButton(onClick = {
                        CrashHandler.clearAllReports(context)
                        reports = emptyList()
                        selectedIndex = 0
                        copied = false
                    }) {
                        Text(stringResource(R.string.crash_clear))
                    }
                }
                TextButton(onClick = onDismiss) {
                    Text(stringResource(R.string.close))
                }
            }
        }
    )
}
