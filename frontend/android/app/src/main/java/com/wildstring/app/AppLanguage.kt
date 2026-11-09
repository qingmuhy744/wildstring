package com.wildstring.app

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.annotation.StringRes
import java.io.File
import java.util.Locale
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Applies the account's interface language ("auto" | "zh" | "en").
 *
 * Android 13+ uses the framework per-app locale (also editable in system settings via
 * locales_config.xml). Older versions keep the choice in private preferences and
 * MainActivity wraps its base context. "auto" leaves resource resolution to the system,
 * so any non-Chinese system language falls back to the English default resources.
 */
object AppLanguage {
    private const val PREFS = "wildstring-language"
    private const val KEY = "language"
    @Volatile private var appContext: Context? = null

    fun install(context: Context) {
        appContext = context.applicationContext ?: context
    }

    fun normalize(preference: String?): String = when (preference) { "zh", "en" -> preference; else -> "auto" }

    private fun tag(preference: String): String = if (preference == "auto") "" else preference

    /** Returns true when the visible language changed and the activity is being recreated. */
    fun apply(activity: Activity, preference: String?): Boolean {
        install(activity)
        val target = tag(normalize(preference))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val manager = activity.getSystemService(LocaleManager::class.java) ?: return false
            if (manager.applicationLocales.toLanguageTags() == target) return false
            // The framework recreates the activity with the new configuration.
            manager.applicationLocales = LocaleList.forLanguageTags(target)
            return true
        }
        val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY, "").orEmpty() == target) return false
        prefs.edit().putString(KEY, target).apply()
        activity.recreate()
        return true
    }

    /** Pre-Android 13 only: wraps the activity context with the stored language. */
    fun wrap(base: Context): Context {
        install(base)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return base
        val target = base.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "").orEmpty()
        if (target.isEmpty()) return base
        val configuration = Configuration(base.resources.configuration)
        configuration.setLocales(LocaleList(Locale.forLanguageTag(target)))
        return base.createConfigurationContext(configuration)
    }

    /** Resolves a string resource in non-Composable code, with JVM unit-test fallback to values-zh/strings.xml. */
    fun string(@StringRes id: Int, vararg args: Any): String {
        val base = appContext
        if (base != null) {
            val localized = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val locales = base.getSystemService(LocaleManager::class.java)?.applicationLocales
                if (locales != null && !locales.isEmpty) {
                    val config = Configuration(base.resources.configuration)
                    config.setLocales(locales)
                    base.createConfigurationContext(config)
                } else base
            } else wrap(base)
            return if (args.isEmpty()) localized.getString(id) else localized.getString(id, *args)
        }
        val raw = jvmZhStrings[id] ?: return ""
        return if (args.isEmpty()) raw else String.format(Locale.US, raw, *args)
    }

    private val jvmZhStrings: Map<Int, String> by lazy {
        runCatching {
            val candidates = listOf(
                File("src/main/res/values-zh/strings.xml"),
                File("app/src/main/res/values-zh/strings.xml"),
                File("frontend/android/app/src/main/res/values-zh/strings.xml")
            )
            val xml = candidates.firstOrNull { it.isFile } ?: return@runCatching emptyMap()
            val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml)
            val nodes = doc.getElementsByTagName("string")
            val byName = HashMap<String, String>(nodes.length)
            for (i in 0 until nodes.length) {
                val el = nodes.item(i)
                val name = el.attributes?.getNamedItem("name")?.nodeValue ?: continue
                byName[name] = el.textContent.replace("\\'", "'").replace("\\\"", "\"").replace("\\n", "\n")
            }
            val result = HashMap<Int, String>(byName.size)
            for (field in R.string::class.java.declaredFields) {
                val text = byName[field.name] ?: continue
                if (field.type == Int::class.javaPrimitiveType) {
                    result[field.getInt(null)] = text
                }
            }
            result
        }.getOrDefault(emptyMap())
    }
}
