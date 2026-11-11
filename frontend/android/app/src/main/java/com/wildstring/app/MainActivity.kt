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
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dagger.hilt.android.AndroidEntryPoint
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.WildStringApp
import com.wildstring.app.ui.AndroidLayoutMode
import com.wildstring.app.ui.currentAndroidLayoutMode

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
            val playerLandscape by model.playerLandscape.collectAsStateWithLifecycle()
            val isTablet = currentAndroidLayoutMode() == AndroidLayoutMode.Pad
            LaunchedEffect(preferences.orientation, playerLandscape, isTablet) {
                requestedOrientation = if (playerLandscape) ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE else when (preferences.orientation) {
                    "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    "sensor" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR
                    else -> if (isTablet) ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                }
            }
            // Manual landscape is a docked listening mode: hide the system bars, and swipe from an edge to bring them back.
            LaunchedEffect(playerLandscape) {
                val controller = WindowCompat.getInsetsController(window, window.decorView)
                if (playerLandscape) {
                    controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                    controller.hide(WindowInsetsCompat.Type.systemBars())
                } else controller.show(WindowInsetsCompat.Type.systemBars())
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
