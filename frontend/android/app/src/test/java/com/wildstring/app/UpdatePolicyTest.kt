package com.wildstring.app

import com.wildstring.app.update.*
import java.io.File
import okhttp3.CookieJar
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test

class UpdatePolicyTest {
    private val hash = "a".repeat(64)
    private fun json(version: String = "0.3.2", draft: Boolean = false, prerelease: Boolean = false, repository: String = UpdatePolicy.REPOSITORY): String = """{
        "tag_name":"v$version","draft":$draft,"prerelease":$prerelease,"body":"Release notes",
        "assets":[{"name":"wildstring-$version-release.apk","browser_download_url":"$repository/releases/download/v$version/wildstring-$version-release.apk","size":4,"state":"uploaded","digest":"sha256:$hash"},
        {"name":"SHA256SUMS","browser_download_url":"$repository/releases/download/v$version/SHA256SUMS","size":100,"state":"uploaded"}]}"""
    @Test fun onlyCompleteOfficialStableRelease() {
        val release = UpdatePolicy.release(json()); assertEquals("0.3.2", release.version); assertEquals(hash, release.apk.digest)
        listOf(json(draft = true), json(prerelease = true), json("0.3.2-beta"), json(repository = "https://github.com/other/project"), json().replace("release.apk", "debug.apk"), json().replace("\"uploaded\"", "\"new\""), json().replace("\"size\":4", "\"size\":999999999")).forEach { raw ->
            assertThrows(UpdateFailure::class.java) { UpdatePolicy.release(raw) }
        }
    }
    @Test fun semanticOrderingDoesNotCompareVersionStringsLexically() {
        assertTrue(UpdatePolicy.isNewer("0.3.10", "0.3.9")); assertTrue(UpdatePolicy.isNewer("1.0.0", "0.99.99"))
        assertFalse(UpdatePolicy.isNewer("0.3.1", "0.3.1")); assertFalse(UpdatePolicy.isNewer("0.2.9", "0.3.0"))
        assertThrows(UpdateFailure::class.java) { UpdatePolicy.version("0.03.2") }
    }
    @Test fun allDownloadsUseHttpsAndFixedRepositoryOrApprovedAssetRedirects() {
        val asset = UpdatePolicy.release(json()).apk
        assertTrue(UpdatePolicy.allowedUrl(asset.url, asset))
        assertTrue(UpdatePolicy.allowedUrl("https://release-assets.githubusercontent.com/github-production-release-asset/opaque?token=temporary", asset))
        listOf("http://release-assets.githubusercontent.com/file", "https://release-assets.githubusercontent.com.evil.invalid/file", "https://user:password@release-assets.githubusercontent.com/file", "https://github.com/other/project/releases/download/v0.3.2/test.apk", "https://music.example.com/api/v1/auth/status").forEach { assertFalse(UpdatePolicy.allowedUrl(it, asset)) }
        assertFalse(UpdatePolicy.allowedUrl("https://api.github.com/repos/other/project/releases/latest", null))
        val forged = asset.copy(url = "https://github.com/other/project/releases/download/v0.3.2/${asset.name}")
        assertFalse(UpdatePolicy.allowedUrl(forged.url, forged))
    }
    @Test fun checksumRequiresExactlyOneMatchingAssetAndNeverUsesOtherFileHash() {
        assertEquals(hash, UpdatePolicy.checksum("$hash  ignored.zip\n$hash  app.apk\n", "app.apk"))
        assertEquals(hash, UpdatePolicy.checksum("$hash *app.apk", "app.apk"))
        assertThrows(UpdateFailure::class.java) { UpdatePolicy.checksum("$hash  other.apk", "app.apk") }
        assertThrows(UpdateFailure::class.java) { UpdatePolicy.checksum("$hash  app.apk\n$hash  app.apk", "app.apk") }
        assertThrows(UpdateFailure::class.java) { UpdatePolicy.checksum("$hash  ../app.apk", "app.apk") }
    }
    @Test fun installedPackageCertificateAndIncreasingCodeAreAllRequired() {
        val release = UpdatePolicy.release(json())
        val installed = PackageIdentity("com.wildstring.app", 8, "0.3.1", setOf("installed-cert"))
        val candidate = installed.copy(versionCode = 9, versionName = "0.3.2")
        UpdatePolicy.verifyPackage(candidate, installed, release)
        listOf(candidate.copy(name = "com.wildstring.app.debug"), candidate.copy(versionCode = 8), candidate.copy(versionCode = 7), candidate.copy(versionName = "0.3.3"), candidate.copy(certificates = setOf("unknown-cert")), candidate.copy(certificates = emptySet())).forEach {
            assertThrows(UpdateFailure::class.java) { UpdatePolicy.verifyPackage(it, installed, release) }
        }
    }
    @Test fun dedicatedHttpClientDoesNotUseMusicSessionOrRedirectAutomatically() {
        val client = ReleaseClient.publicClient(); assertSame(CookieJar.NO_COOKIES, client.cookieJar)
        assertTrue(client.interceptors.isEmpty()); assertTrue(client.networkInterceptors.isEmpty()); assertFalse(client.followRedirects); assertFalse(client.followSslRedirects)
        var requests = 0
        val fake = client.newBuilder().addInterceptor { chain ->
            requests++; assertNull(chain.request().header("Cookie")); assertNull(chain.request().header("Authorization")); assertNull(chain.request().header("X-Wildstring-Client"))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .header("Set-Cookie", "wildstring_session=not-a-music-session; Path=/; Secure")
                .body(json().toResponseBody()).build()
        }.build()
        val api = ReleaseClient(fake); api.latest(null); api.latest(null); assertEquals(2, requests)
    }
    @Test fun unknownRedirectIsRejectedBeforeSecondRequest() {
        var count = 0
        val fake = ReleaseClient.publicClient().newBuilder().addInterceptor { chain -> count++
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(302).message("Moved").header("Location", "https://evil.invalid/file").body("".toResponseBody()).build()
        }.build()
        assertThrows(UpdateFailure::class.java) { ReleaseClient(fake).latest(null) }; assertEquals(1, count)
    }
    @Test fun downloadChecksDeclaredLengthAndSupportsCancellation() {
        val release = UpdatePolicy.release(json()); val output = File.createTempFile("wildstring-update-", ".part")
        try {
            val fake = ReleaseClient.publicClient().newBuilder().addInterceptor { chain -> Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body("test".toResponseBody()).build() }.build()
            val api = ReleaseClient(fake); var downloaded = 0L; api.download(release.apk, output) { bytes, _ -> downloaded = bytes }
            assertEquals(4, downloaded); assertEquals("test", output.readText())
            assertThrows(UpdateFailure::class.java) { api.download(release.apk.copy(size = 3), output) { _, _ -> } }
            api.cancel(); assertThrows(UpdateFailure::class.java) { api.latest(null) }
            api.begin(); assertThrows(UpdateFailure::class.java) { api.download(release.apk, output) { _, _ -> api.cancel() } }; assertTrue(api.wasCancelled())
        } finally { output.delete() }
    }
}
