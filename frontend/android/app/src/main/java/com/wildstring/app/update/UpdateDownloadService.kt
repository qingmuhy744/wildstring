package com.wildstring.app.update

import android.Manifest
import android.app.*
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.wildstring.app.MainActivity
import com.wildstring.app.R
import kotlinx.coroutines.*

class UpdateDownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var job: Job? = null
    private val updater by lazy { AppUpdater.get(this) }
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL, "应用更新", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == CANCEL) { updater.cancelDownload(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        startForeground(ID, notification(0, 0))
        if (job?.isActive != true) job = scope.launch {
            try { updater.download { bytes, total ->
                if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this@UpdateDownloadService, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
                    getSystemService(NotificationManager::class.java).notify(ID, notification(bytes, total))
            } } finally { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
        }
        return START_NOT_STICKY
    }
    private fun notification(bytes: Long, total: Long): Notification = NotificationCompat.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_wildstring).setContentTitle("野弦 · 下载更新")
        .setContentText(if (total > 0) "${bytes / 1024} / ${total / 1024} KB" else "正在获取并校验安装包")
        .setOngoing(true).setProgress(100, if (total > 0) (bytes * 100 / total).toInt() else 0, total <= 0)
        .setContentIntent(PendingIntent.getActivity(this, 61, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE))
        .addAction(0, "取消下载", PendingIntent.getService(this, 62, Intent(this, UpdateDownloadService::class.java).setAction(CANCEL), PendingIntent.FLAG_IMMUTABLE)).build()
    override fun onTimeout(startId: Int, fgsType: Int) { updater.cancelDownload(); scope.cancel(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
    override fun onDestroy() { if (job?.isActive == true) updater.cancelDownload(); scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object { private const val CHANNEL = "app-update"; private const val ID = 23; private const val CANCEL = "cancel-update" }
}
