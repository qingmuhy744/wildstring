package com.wildstring.app.playback

import android.app.*
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.wildstring.app.MainActivity
import com.wildstring.app.R
import com.wildstring.app.data.OfflineDownloads
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject
import kotlinx.coroutines.*

/** User-started full-file downloads continue when the activity leaves the foreground. */
@AndroidEntryPoint
class DownloadService : Service() {
    @Inject lateinit var downloads: OfflineDownloads
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "离线保存", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "pause") { downloads.pauseAll(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        startForeground(ID, notification("正在准备离线保存"))
        if (job?.isActive != true) job = scope.launch {
            try { downloads.run { item -> if (android.os.Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this@DownloadService, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                getSystemService(NotificationManager::class.java).notify(ID, notification("${item.track.title} · ${item.bytes / 1024 / 1024} MiB")) } }
            finally { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
        }
        return START_NOT_STICKY
    }
    override fun onTimeout(startId: Int, fgsType: Int) { downloads.pauseAll(); scope.cancel(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
    private fun notification(text: String): Notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_wildstring).setContentTitle("野弦 · 离线保存").setContentText(text).setOngoing(true)
        .setContentIntent(PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .addAction(0, "暂停全部", PendingIntent.getService(this, 2, Intent(this, DownloadService::class.java).setAction("pause"), PendingIntent.FLAG_IMMUTABLE)).build()
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() { downloads.pauseAll(); scope.cancel(); super.onDestroy() }
    companion object { private const val CHANNEL = "offline-downloads"; private const val ID = 22 }
}
