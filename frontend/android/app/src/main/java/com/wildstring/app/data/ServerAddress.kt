package com.wildstring.app.data

import java.io.IOException
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response

object ServerAddress {
    private val localHosts = setOf("10.0.2.2", "127.0.0.1", "localhost")
    fun normalize(raw: String, allowLocalHttp: Boolean = false): HttpUrl {
        val url = raw.trim().toHttpUrlOrNull() ?: throw IllegalArgumentException("请输入完整的 HTTPS 服务器地址。")
        require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null) {
            "服务器地址不能包含账号、密码、查询参数或片段。"
        }
        require(url.isHttps || (allowLocalHttp && url.host in localHosts)) {
            "请使用 HTTPS。HTTP 仅支持已明确启用的本机调试地址。"
        }
        return url.newBuilder().encodedPath(url.encodedPath.trimEnd('/') + "/").build()
    }
    fun contains(base: HttpUrl, target: HttpUrl): Boolean =
        base.scheme == target.scheme && base.host == target.host && base.port == target.port &&
            target.encodedPath.startsWith(base.encodedPath)
}

class OriginGuard(private val endpoint: () -> HttpUrl?, private val profile: () -> String? = { null }, private val unauthorized: () -> Unit = {}) : Interceptor {
    @Volatile private var legacyOrigin: String? = null
    override fun intercept(chain: Interceptor.Chain): Response {
        val base = endpoint() ?: throw IOException("尚未配置服务器。")
        if (!ServerAddress.contains(base, chain.request().url)) throw IOException("拒绝请求其他服务器或路径。")
        val requestProfile = profile()
        val client = if (legacyOrigin == base.toString()) "web" else "android"
        var response = chain.proceed(chain.request().newBuilder().header("X-Wildstring-Client", client).build())
        // Compatibility with existing Web-only servers, on the same validated origin.
        if (client == "android" && response.code == 403 && response.peekBody(4096).string().contains("client_header_required")) {
            response.close()
            legacyOrigin = base.toString()
            response = chain.proceed(chain.request().newBuilder().header("X-Wildstring-Client", "web").build())
        }
        if (response.code == 401 && !response.request.url.encodedPath.endsWith("/auth/login") && !response.request.url.encodedPath.endsWith("/auth/logout") && endpoint() == base && profile() == requestProfile) unauthorized()
        return response
    }
}
