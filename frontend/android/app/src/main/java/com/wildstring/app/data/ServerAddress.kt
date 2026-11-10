package com.wildstring.app.data

import com.wildstring.app.AppLanguage
import com.wildstring.app.R
import java.io.IOException
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

object ServerAddress {
    fun normalize(raw: String, allowInsecureHttp: Boolean = false): HttpUrl {
        val value = raw.trim()
        val input = if (
            value.startsWith("http://", ignoreCase = true) ||
                value.startsWith("https://", ignoreCase = true)
        ) {
            value
        } else {
            "https://$value"
        }
        val url = input.toHttpUrlOrNull()
            ?: throw IllegalArgumentException(AppLanguage.string(R.string.srv_addr_invalid_url))
        require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) {
            AppLanguage.string(R.string.srv_addr_no_credentials_or_query)
        }
        require(url.isHttps || allowInsecureHttp) {
            AppLanguage.string(R.string.srv_addr_require_https)
        }
        return url.newBuilder().encodedPath(url.encodedPath.trimEnd('/') + "/").build()
    }
    fun contains(base: HttpUrl, target: HttpUrl): Boolean =
        base.scheme == target.scheme && base.host == target.host && base.port == target.port &&
            target.encodedPath.startsWith(base.encodedPath)
}

data class RequestOwner(val profile: String?)

class OriginGuard(private val endpoint: () -> HttpUrl?, private val profile: () -> String? = { "" }, private val unauthorized: () -> Unit = {}) : Interceptor {
    @Volatile private var legacyOrigin: String? = null
    override fun intercept(chain: Interceptor.Chain): Response {
        val base = endpoint() ?: throw IOException(AppLanguage.string(R.string.srv_addr_server_not_configured))
        if (!ServerAddress.contains(base, chain.request().url)) throw IOException(AppLanguage.string(R.string.srv_addr_foreign_origin_rejected))
        val requestProfile = profile()
        chain.request().tag(RequestOwner::class.java)?.let { if (it.profile == null || it.profile != requestProfile) throw IOException(AppLanguage.string(R.string.srv_addr_session_changed)) }
        val client = if (legacyOrigin == base.toString()) "web" else "android"
        var response = chain.proceed(chain.request().newBuilder().header("X-Wildstring-Client", client).build())
        // Compatibility with existing Web-only servers, on the same validated origin.
        if (client == "android" && response.code == 403 && response.peekBody(4096).string().contains("client_header_required")) {
            response.close()
            legacyOrigin = base.toString()
            response = chain.proceed(chain.request().newBuilder().header("X-Wildstring-Client", "web").build())
        }
        if (response.code == 401 && !response.request.url.encodedPath.endsWith("/auth/login") && !response.request.url.encodedPath.endsWith("/auth/logout") && requestProfile != null && endpoint() == base && profile() == requestProfile) unauthorized()
        return response
    }
}
