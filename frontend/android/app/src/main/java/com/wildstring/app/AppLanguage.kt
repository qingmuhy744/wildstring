package com.wildstring.app

import android.app.Activity
import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import java.util.Locale

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

    fun normalize(preference: String?): String = when (preference) { "zh", "en" -> preference; else -> "auto" }

    private fun tag(preference: String): String = if (preference == "auto") "" else preference

    /** Returns true when the visible language changed and the activity is being recreated. */
    fun apply(activity: Activity, preference: String?): Boolean {
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return base
        val target = base.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "").orEmpty()
        if (target.isEmpty()) return base
        val configuration = Configuration(base.resources.configuration)
        configuration.setLocales(LocaleList(Locale.forLanguageTag(target)))
        return base.createConfigurationContext(configuration)
    }
}
