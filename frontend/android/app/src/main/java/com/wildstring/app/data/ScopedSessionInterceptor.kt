package com.wildstring.app.data

import java.io.IOException
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.Response

data class ServerRequestState(val selection: String, val endpoint: HttpUrl)

/** Bind both request cookies and response cookies to the same selection, including A -> B -> A. */
class ScopedSessionInterceptor(private val state: () -> ServerRequestState?, private val read: (ServerRequestState) -> String?,
    private val save: (ServerRequestState, String?) -> Unit) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val captured = state() ?: throw IOException("尚未配置服务器。")
        val url = chain.request().url
        if (!ServerAddress.contains(captured.endpoint, url)) throw IOException("拒绝请求其他服务器或路径。")
        val cookie = read(captured)?.let { Cookie.parse(captured.endpoint, it) }?.takeIf { it.expiresAt > System.currentTimeMillis() && it.matches(url) }
        val request = chain.request().newBuilder().apply {
            // Explicit cookies are used only by password change on this validated origin.
            if (chain.request().header("Cookie") == null && cookie != null) header("Cookie", "${cookie.name}=${cookie.value}")
        }.build()
        val response = chain.proceed(request)
        if (state()?.selection != captured.selection) { response.close(); throw IOException("服务器或会话已切换。") }
        Cookie.parseAll(url, response.headers).lastOrNull { it.name == "wildstring_session" && it.matches(url) }?.let {
            save(captured, if (it.expiresAt <= System.currentTimeMillis()) null else it.toString())
        }
        return response
    }
}

/** Retrofit instances are bound to their selection, even while an OkHttp call waits to execute. */
class SelectionRequestInterceptor(private val selection: String, private val current: () -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        if (selection != current()) throw IOException("服务器或会话已切换。")
        val response = chain.proceed(chain.request())
        if (selection != current()) { response.close(); throw IOException("服务器或会话已切换。") }
        return response
    }
}
