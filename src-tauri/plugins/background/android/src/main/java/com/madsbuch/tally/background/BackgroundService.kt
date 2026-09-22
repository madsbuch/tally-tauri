package com.madsbuch.tally.background

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

internal fun ensureBackgroundChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
            BackgroundService.CHANNEL_ID,
            "Background work",
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Shown while Tally finishes AI work with the app closed"
        channel.setShowBadge(false)
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(channel)
    }
}

/**
 * Foreground service that keeps Tally's process running while AI work is in
 * flight.
 *
 * Android freezes a backgrounded app's process and eventually kills it, which
 * is what dropped an OpenRouter request the moment the user switched away
 * mid-answer. While this service is up the process stays in the foreground
 * importance class, so the WebView keeps executing and the request in Rust
 * finishes — the diary entry lands even with the app closed.
 *
 * It holds no state: the frontend begins a task before starting AI work and
 * ends it in a `finally`, ref-counted in src/lib/background.ts. The watchdog
 * below is the backstop for the one case that can't clean up after itself —
 * the WebView being wedged or torn down without ever sending the end.
 */
class BackgroundService : Service() {
    companion object {
        const val EXTRA_LABEL = "label"
        const val CHANNEL_ID = "background_work"
        const val NOTIFICATION_ID = 4218

        /**
         * Longest a task may hold the process. Generous on purpose: ten rounds
         * of a 90 s request, each retried on a failing network, can legitimately
         * run long, and cutting that short would drop the work back to being
         * freezable. It exists only so a frontend that died without ending its
         * task can't leave the notification up forever.
         */
        const val WATCHDOG_MS = 30 * 60 * 1000L
    }

    private val handler = Handler(Looper.getMainLooper())
    private var label: String = "Working…"

    private val watchdog = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureBackgroundChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra(EXTRA_LABEL)?.let { if (it.isNotBlank()) label = it }
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            }
        )
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, WATCHDOG_MS)
        // Nothing to resume if the process dies: the work died with it.
        return START_NOT_STICKY
    }

    /**
     * The app was swiped out of recents. The WebView went with it, so no end
     * is ever coming and the work it was protecting is already gone — stop
     * rather than leave the notification up. Declared in the manifest too;
     * this is the belt to that braces, since OEMs differ on which fires.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        stopForegroundAndDropNotification()
        super.onDestroy()
    }

    /**
     * Every path out of this service goes through onDestroy, so taking the
     * notification down here means it can't outlive the service however the
     * service ended — stopped by the frontend, by the watchdog, or by the task
     * being removed.
     */
    private fun stopForegroundAndDropNotification() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = if (launchIntent != null) {
            PendingIntent.getActivity(
                this, 0, launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else {
            null
        }

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(label)
            .setContentText("Tally is finishing this in the background")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setProgress(0, 0, true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (contentIntent != null) builder.setContentIntent(contentIntent)
        return builder.build()
    }
}
