package com.wildstring.app

import android.app.LocaleManager
import android.os.Build
import android.os.Bundle
import android.os.LocaleList
import androidx.test.runner.AndroidJUnitRunner
import java.util.Locale

/** Pins "auto" language fallback to Chinese for instrumented tests without restarting system_server. */
class WildStringTestRunner : AndroidJUnitRunner() {
    override fun onCreate(arguments: Bundle?) {
        val localeTag = (arguments?.getString("testLocale") ?: "zh").trim()
        if (localeTag.isNotEmpty()) {
            AppLanguage.testAutoLocaleTag = localeTag
            if (localeTag.startsWith("zh")) {
                Locale.setDefault(Locale.SIMPLIFIED_CHINESE)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                val manager = targetContext.getSystemService(LocaleManager::class.java)
                val desired = LocaleList.forLanguageTags(localeTag)
                if (manager != null && manager.applicationLocales != desired) {
                    manager.applicationLocales = desired
                }
            }
        }
        super.onCreate(arguments)
    }
}
