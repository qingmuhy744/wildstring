package com.wildstring.app

import com.wildstring.app.diagnostics.CrashHandler
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Date

class CrashHandlerTest {
    @Test
    fun formatCrashContainsExpectedSystemAndExceptionSections() {
        val date = Date(1730970000000L)
        val exception = IllegalStateException("synthetic state error", NullPointerException("nested cause"))
        val report = CrashHandler.formatCrash(
            packageName = "com.wildstring.app",
            versionName = "0.8.6",
            versionCode = 42,
            buildType = "debug",
            device = "Google Pixel 8 (shiba)",
            os = "14 (API 34)",
            abis = "arm64-v8a",
            threadName = "main",
            threadTid = 1L,
            threadPriority = 5,
            freeMb = 128L,
            totalMb = 256L,
            maxMb = 512L,
            throwable = exception,
            timestamp = date,
        )

        assertTrue(report.startsWith("=== WildString Crash Report ==="))
        assertTrue(report.contains("Package: com.wildstring.app"))
        assertTrue(report.contains("Version: 0.8.6 (42)"))
        assertTrue(report.contains("Device: Google Pixel 8 (shiba)"))
        assertTrue(report.contains("Thread: main (tid: 1, priority: 5)"))
        assertTrue(report.contains("Heap Memory: Free 128MB / Total 256MB / Max 512MB"))
        assertTrue(report.contains("Type: java.lang.IllegalStateException"))
        assertTrue(report.contains("Message: synthetic state error"))
        assertTrue(report.contains("Caused by: java.lang.NullPointerException: nested cause"))
        assertTrue(report.endsWith("=== End of Report ===\n"))
    }

    @Test
    fun extractSummaryFindsExceptionClassName() {
        val sample = """
            === WildString Crash Report ===
            Time: 2026-11-07 10:00:00.000 +0800
            Package: com.wildstring.app

            === Exception ===
            Type: java.lang.IllegalArgumentException
            Message: bad argument

            === Stacktrace ===
            java.lang.IllegalArgumentException: bad argument
                at com.wildstring.app.Test.run(Test.kt:10)
        """.trimIndent()

        val summary = CrashHandler.extractSummary(sample)
        assertEquals("IllegalArgumentException", summary)
    }

    @Test
    fun pruneOldReportsKeepsAtMostMaxReports() {
        val tmpDir = Files.createTempDirectory("crash_test").toFile()
        try {
            // Create 15 synthetic crash log files with staggered timestamps
            for (i in 1..15) {
                val file = File(tmpDir, "crash_2026-11-07_${String.format("%02d", i)}-00-00.log")
                file.writeText("report $i")
                file.setLastModified(1000L * i)
            }

            assertEquals(15, tmpDir.listFiles()?.size)
            val deleted = CrashHandler.pruneOldReports(tmpDir)
            assertEquals(5, deleted)

            val remaining = tmpDir.listFiles()?.toList().orEmpty()
            assertEquals(CrashHandler.MAX_REPORTS, remaining.size)

            val reports = CrashHandler.listReportsFromDir(tmpDir)
            assertEquals(10, reports.size)
            // The newest report should be report 15
            assertEquals("report 15", reports.first().content)
        } finally {
            tmpDir.deleteRecursively()
        }
    }
}
