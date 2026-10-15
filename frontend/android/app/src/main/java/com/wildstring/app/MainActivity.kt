package com.wildstring.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import dagger.hilt.android.AndroidEntryPoint
import com.wildstring.app.ui.MusicViewModel
import com.wildstring.app.ui.WildStringApp

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private val model: MusicViewModel by viewModels()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT))
        setContent { WildStringApp(model) }
    }
    override fun onStart() { super.onStart(); model.observeProgress(true) }
    override fun onStop() { model.observeProgress(false); super.onStop() }
}
