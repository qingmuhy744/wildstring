package com.wildstring.app

import android.content.Context
import android.content.pm.ActivityInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.AndroidEntryPoint
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.WildStringApp

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val model: MusicViewModel by viewModels()
    override fun attachBaseContext(newBase: Context) { super.attachBaseContext(AppLanguage.wrap(newBase)) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        com.wildstring.app.update.AppUpdater.get(this).checkAutomatically()
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        setContent {
            val preferences by model.settings.state.collectAsStateWithLifecycle()
            LaunchedEffect(preferences.orientation) {
                val isTablet = resources.configuration.smallestScreenWidthDp >= 600
                requestedOrientation = when (preferences.orientation) {
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    "sensor" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR
                    else -> if (isTablet) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                }
            }
            val music by model.state.collectAsStateWithLifecycle()
            // Signed in: the account language wins. Signed out: follow the system language.
            val language = music.account?.language ?: if (music.connecting) null else "auto"
            LaunchedEffect(language) { if (language != null) AppLanguage.apply(this@MainActivity, language) }
            WildStringApp(model)
        }
    }
    override fun onStart() { super.onStart(); model.observeProgress(true) }
    override fun onStop() { model.observeProgress(false); super.onStop() }
}
