package com.wildstring.app.update

import com.google.gson.JsonParser
import java.io.File
import java.security.MessageDigest
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

data class ReleaseAsset(val name: String, val url: String, val size: Long, val digest: String? = null)
data class AppRelease(val version: String, val tag: String, val notes: String, val apk: ReleaseAsset, val checksums: ReleaseAsset)
data class PackageIdentity(val name: String, val versionCode: Long, val versionName: String, val certificates: Set<String>)
class UpdateFailure(val reason: String) : Exception(reason)

/** Only this repository's universal, stable, release-signed APK is an update candidate. */
object UpdatePolicy {
    const val REPOSITORY = "https://github.com/qingmuhy744/wildstring"
    const val LATEST = "https://api.github.com/repos/qingmuhy744/wildstring/releases/latest"
    const val MAX_APK = 200L * 1024 * 1024
    const val MAX_METADATA = 1024L * 1024
    private val versionPattern = Regex("^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$")
    fun version(value: String): List<Int> {
        if (!versionPattern.matches(value)) throw UpdateFailure("release_invalid")
        return value.split('.').map(String::toInt)
    }
    fun isNewer(next: String, current: String): Boolean {
        val a = version(next); val b = version(current)
        for (i in 0..2) if (a[i] != b[i]) return a[i] > b[i]
        return false
    }
    fun release(json: String): AppRelease {
        try {
            val root = JsonParser.parseString(json).asJsonObject
            if (root["draft"].asBoolean || root["prerelease"].asBoolean) throw UpdateFailure("release_unstable")
            val tag = root["tag_name"].asString
            if (!tag.startsWith("v")) throw UpdateFailure("release_invalid")
            val value = tag.substring(1); version(value)
            val assets = root["assets"].asJsonArray
            fun asset(name: String, maximum: Long): ReleaseAsset {
                val matching = assets.map { it.asJsonObject }.filter { it["name"].asString == name }
                if (matching.size != 1) throw UpdateFailure("asset_missing")
                val item = matching.single(); val size = item["size"].asLong
                val url = item["browser_download_url"].asString
                if (size !in 1..maximum || item["state"]?.asString != "uploaded" || url != "$REPOSITORY/releases/download/$tag/$name") throw UpdateFailure("asset_invalid")
                val digest = item["digest"]?.takeUnless { it.isJsonNull }?.asString
                if (digest != null && !Regex("sha256:[a-fA-F0-9]{64}").matches(digest)) throw UpdateFailure("asset_invalid")
                return ReleaseAsset(name, url, size, digest?.removePrefix("sha256:")?.lowercase())
            }
            return AppRelease(value, tag, root["body"]?.takeUnless { it.isJsonNull }?.asString?.take(16000) ?: "暂无版本说明。",
                asset("wildstring-$value-release.apk", MAX_APK), asset("SHA256SUMS", 128 * 1024))
        } catch (error: UpdateFailure) { throw error }
        catch (_: Exception) { throw UpdateFailure("release_invalid") }
    }
    fun allowedUrl(value: String, asset: ReleaseAsset?): Boolean {
        val url = value.toHttpUrlOrNull() ?: return false
        if (!url.isHttps || url.port != 443 || url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null) return false
        if (asset == null) return value == LATEST
        val original = asset.url.toHttpUrlOrNull() ?: return false
        val tag = original.pathSegments.getOrNull(4) ?: return false
        val releaseVersion = tag.removePrefix("v")
        if (!tag.startsWith("v") || !versionPattern.matches(releaseVersion) || asset.name !in setOf("SHA256SUMS", "wildstring-$releaseVersion-release.apk") || asset.url != "$REPOSITORY/releases/download/$tag/${asset.name}") return false
        if (url.host == "github.com") return value == asset.url
        return url.host in setOf("release-assets.githubusercontent.com", "github-releases.githubusercontent.com", "objects.githubusercontent.com")
    }
    fun checksum(text: String, filename: String): String {
        val matches = text.lineSequence().mapNotNull { line ->
            val found = Regex("^([a-fA-F0-9]{64}) [ *]([^\\r\\n]+)$").matchEntire(line) ?: return@mapNotNull null
            if (found.groupValues[2] == filename) found.groupValues[1].lowercase() else null
        }.toList()
        if (matches.size != 1) throw UpdateFailure("checksum_missing")
        return matches.single()
    }
    fun hash(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buffer = ByteArray(64 * 1024); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    fun verifyPackage(candidate: PackageIdentity, installed: PackageIdentity, release: AppRelease) {
        if (candidate.name != installed.name) throw UpdateFailure("package_mismatch")
        if (candidate.versionCode <= installed.versionCode) throw UpdateFailure("version_not_newer")
        if (candidate.versionName != release.version) throw UpdateFailure("version_mismatch")
        if (candidate.certificates.isEmpty() || candidate.certificates != installed.certificates) throw UpdateFailure("signature_mismatch")
    }
}
