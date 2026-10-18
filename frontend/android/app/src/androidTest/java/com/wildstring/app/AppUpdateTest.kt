package com.wildstring.app

import android.content.ComponentName
import android.content.pm.PackageManager
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.core.content.FileProvider
import androidx.test.platform.app.InstrumentationRegistry
import com.wildstring.app.update.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class AppUpdateTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun release(version: String) = AppRelease(version, "v$version", "测试版本说明", ReleaseAsset("wildstring-$version-release.apk", "${UpdatePolicy.REPOSITORY}/releases/download/v$version/wildstring-$version-release.apk", 1024), ReleaseAsset("SHA256SUMS", "${UpdatePolicy.REPOSITORY}/releases/download/v$version/SHA256SUMS", 100))
    @Test fun actualApkPackageAndSignerAreValidatedWithoutReadingAnySigningKey() {
        val installed = ApkVerifier.installed(context)
        val candidate = ApkVerifier.archive(context, File(context.applicationInfo.sourceDir))
        assertEquals(context.packageName, candidate.name); assertEquals(installed.certificates, candidate.certificates); assertFalse(candidate.certificates.isEmpty())
        assertTrue(candidate.certificates.all { Regex("[a-f0-9]{64}").matches(it) })
        UpdatePolicy.verifyPackage(candidate, installed.copy(versionCode = installed.versionCode - 1), release(installed.versionName))
        assertThrows(UpdateFailure::class.java) { UpdatePolicy.verifyPackage(candidate, installed, release(installed.versionName)) }
        assertThrows(UpdateFailure::class.java) { UpdatePolicy.verifyPackage(candidate.copy(certificates = setOf("wrong")), installed.copy(versionCode = installed.versionCode - 1), release(installed.versionName)) }
    }
    @Suppress("DEPRECATION")
    @Test fun installerProviderExposesOnlyPrivateUpdateFolder() {
        val provider = context.packageManager.resolveContentProvider("${context.packageName}.updates", 0)!!
        assertFalse(provider.exported); assertTrue(provider.grantUriPermissions)
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
        assertTrue(packageInfo.requestedPermissions?.contains("android.permission.REQUEST_INSTALL_PACKAGES") == true)
        val service = context.packageManager.getServiceInfo(ComponentName(context, UpdateDownloadService::class.java), 0)
        assertFalse(service.exported)
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }; val file = File(directory, "provider-test.apk").apply { writeText("test") }
        try {
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", file); assertEquals("content", uri.scheme)
            assertThrows(IllegalArgumentException::class.java) { FileProvider.getUriForFile(context, "${context.packageName}.updates", File(context.filesDir, "private-session")) }
        } finally { file.delete() }
    }
    @Test fun settingsShowOfficialRepositoryAndUpdateControlsRespectRealPhases() {
        val state = mutableStateOf(UpdateState(UpdatePhase.Checking)); var checks = 0; var detail = 0; var cancels = 0; var installs = 0; var repository = 0
        compose.setContent { MaterialTheme { Column { UpdateSettingsContent(state.value, { checks++ }, { detail++ }, { cancels++ }, { installs++ }, { repository++ }) } } }
        compose.onNodeWithTag("app-check-update").performClick(); compose.runOnIdle { assertEquals(0, checks); state.value = UpdateState(UpdatePhase.Available, release("0.3.2")) }
        compose.onNodeWithText("发现 0.3.2 · 当前 ${BuildConfig.VERSION_NAME}").assertIsDisplayed()
        compose.onNodeWithTag("app-update-action").performClick(); compose.onNodeWithTag("app-repository").performClick()
        compose.runOnIdle { assertEquals(1, detail); assertEquals(1, repository); state.value = state.value.copy(phase = UpdatePhase.Downloading, downloaded = 512, total = 1024) }
        compose.onNodeWithTag("app-cancel-update").performClick(); compose.runOnIdle { assertEquals(1, cancels); state.value = state.value.copy(phase = UpdatePhase.Ready) }
        compose.onNodeWithText("安装更新").assertIsDisplayed(); compose.onNodeWithTag("app-update-action").performClick()
        compose.runOnIdle { assertEquals(1, installs) }
    }
}
