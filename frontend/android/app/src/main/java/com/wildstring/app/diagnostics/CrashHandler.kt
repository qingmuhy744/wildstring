package com.wildstring.app.diagnostics

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Process
import android.util.Log
import com.wildstring.app.BuildConfig
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class CrashReport(
    val file: File,
    val timestamp: Long,
    val summary: String,
    val content: String,
)

object CrashHandler {
    private const val TAG = "WildStringCrash"
    private const val PREFS_NAME = "wildstring_crash"
    private const val KEY_NEW_CRASH = "new_crash"
    private const val KEY_LAST_TIMESTAMP = "last_crash_timestamp"
    private const val CRASH_DIR_NAME = "crash_reports"
    const val MAX_REPORTS = 10

    @Volatile
    private var installed = false

    fun install(context: Context) {
        if (installed) return
        installed = true
        val appContext = context.applicationContext
        val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()

        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                recordCrash(appContext, thread, throwable)
            } catch (e: Throwable) {
                logError("Failed to capture crash", e)
            } finally {
                defaultHandler?.uncaughtException(thread, throwable)
            }
        }
    }

    internal fun recordCrash(
        context: Context,
        thread: Thread,
        throwable: Throwable,
        now: Date = Date(),
    ): File? {
        return try {
            val dir = getCrashDir(context)
            if (!dir.exists()) dir.mkdirs()

            val timeFormat = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.US)
            val timeString = timeFormat.format(now)
            val file = File(dir, "crash_$timeString.log")

            val reportText = buildCrashReport(context, thread, throwable, now)
            file.writeText(reportText)

            pruneOldReports(dir)

            runCatching {
                prefs(context).edit()
                    .putBoolean(KEY_NEW_CRASH, true)
                    .putLong(KEY_LAST_TIMESTAMP, now.time)
                    .apply()
            }

            file
        } catch (e: Throwable) {
            logError("Error writing crash report", e)
            null
        }
    }

    fun hasNewCrash(context: Context): Boolean {
        return runCatching { prefs(context).getBoolean(KEY_NEW_CRASH, false) }.getOrDefault(false)
    }

    fun clearNewCrashFlag(context: Context) {
        runCatching { prefs(context).edit().putBoolean(KEY_NEW_CRASH, false).apply() }
    }

    fun getCrashDir(context: Context): File {
        return File(context.filesDir, CRASH_DIR_NAME)
    }

    fun listReports(context: Context): List<CrashReport> {
        val dir = getCrashDir(context)
        return listReportsFromDir(dir)
    }

    fun listReportsFromDir(dir: File): List<CrashReport> {
        if (!dir.exists() || !dir.isDirectory) return emptyList()

        return dir.listFiles { file -> file.isFile && file.name.startsWith("crash_") && file.name.endsWith(".log") }
            .orEmpty()
            .sortedByDescending { it.lastModified() }
            .mapNotNull { file ->
                runCatching {
                    val content = file.readText()
                    val summary = extractSummary(content)
                    CrashReport(file, file.lastModified(), summary, content)
                }.getOrNull()
            }
    }

    fun clearAllReports(context: Context): Boolean {
        clearNewCrashFlag(context)
        val dir = getCrashDir(context)
        if (!dir.exists()) return true
        return dir.listFiles()?.all { it.delete() } ?: true
    }

    internal fun pruneOldReports(dir: File): Int {
        val files = dir.listFiles { file -> file.isFile && file.name.startsWith("crash_") && file.name.endsWith(".log") }
            .orEmpty()
            .sortedByDescending { it.lastModified() }

        var deleted = 0
        if (files.size > MAX_REPORTS) {
            files.drop(MAX_REPORTS).forEach {
                if (it.delete()) deleted++
            }
        }
        return deleted
    }

    private fun prefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    internal fun extractSummary(content: String): String {
        for (line in content.lineSequence()) {
            if (line.startsWith("Type: ")) {
                val fullType = line.substringAfter("Type: ").trim()
                return fullType.substringAfterLast('.')
            }
        }
        val firstException = content.lines().firstOrNull { it.contains("Exception") || it.contains("Error") }
        return firstException?.substringBefore(':')?.trim()?.substringAfterLast('.') ?: "Crash Report"
    }

    @Suppress("DEPRECATION")
    internal fun buildCrashReport(
        context: Context,
        thread: Thread,
        throwable: Throwable,
        timestamp: Date,
    ): String {
        val runtime = Runtime.getRuntime()
        val maxMemory = runtime.maxMemory() / 1048576L
        val totalMemory = runtime.totalMemory() / 1048576L
        val freeMemory = runtime.freeMemory() / 1048576L

        return formatCrash(
            packageName = context.packageName,
            versionName = BuildConfig.VERSION_NAME,
            versionCode = BuildConfig.VERSION_CODE,
            buildType = BuildConfig.BUILD_TYPE,
            device = "${Build.MANUFACTURER} ${Build.MODEL} (${Build.PRODUCT})",
            os = "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            abis = Build.SUPPORTED_ABIS.joinToString(", "),
            threadName = thread.name,
            // The handler runs on the crashing thread, so the OS tid identifies it
            // and matches logcat/ANR traces. Thread.getId() is deprecated on API 35+.
            threadTid = Process.myTid().toLong(),
            threadPriority = thread.priority,
            freeMb = freeMemory,
            totalMb = totalMemory,
            maxMb = maxMemory,
            throwable = throwable,
            timestamp = timestamp,
        )
    }

    internal fun formatCrash(
        packageName: String,
        versionName: String,
        versionCode: Int,
        buildType: String,
        device: String,
        os: String,
        abis: String,
        threadName: String,
        threadTid: Long,
        threadPriority: Int,
        freeMb: Long,
        totalMb: Long,
        maxMb: Long,
        throwable: Throwable,
        timestamp: Date,
    ): String {
        val sw = StringWriter()
        val pw = PrintWriter(sw)
        throwable.printStackTrace(pw)
        val stackTrace = sw.toString()

        val displayTime = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.getDefault()).format(timestamp)

        return buildString {
            appendLine("=== WildString Crash Report ===")
            appendLine("Time: $displayTime")
            appendLine("Package: $packageName")
            appendLine("Version: $versionName ($versionCode)")
            appendLine("Build Type: $buildType")
            appendLine("Device: $device")
            appendLine("Android: $os")
            appendLine("ABIs: $abis")
            appendLine("Thread: $threadName (tid: $threadTid, priority: $threadPriority)")
            appendLine("Heap Memory: Free ${freeMb}MB / Total ${totalMb}MB / Max ${maxMb}MB")
            appendLine()
            appendLine("=== Exception ===")
            appendLine("Type: ${throwable.javaClass.name}")
            appendLine("Message: ${throwable.message ?: "(none)"}")
            appendLine()
            appendLine("=== Stacktrace ===")
            appendLine(stackTrace.trimEnd())
            appendLine()
            appendLine("=== End of Report ===")
        }
    }

    private fun logError(message: String, throwable: Throwable) {
        try {
            Log.e(TAG, message, throwable)
        } catch (_: Throwable) {
            System.err.println("$TAG: $message: ${throwable.message}")
        }
    }
}
