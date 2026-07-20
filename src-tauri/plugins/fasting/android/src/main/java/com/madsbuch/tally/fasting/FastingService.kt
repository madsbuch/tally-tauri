package com.madsbuch.tally.fasting

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.text.DateFormat
import java.util.Date

internal fun ensureFastingChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(
            FastingService.CHANNEL_ID,
            "Fasting countdown",
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = "Persistent countdown while a fast is active"
        channel.setShowBadge(false)
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.createNotificationChannel(channel)
    }
}

/**
 * Foreground service backing the fasting countdown notification.
 *
 * The notification re-renders every minute (aligned to minute boundaries) and
 * immediately on screen-on, with the remaining time as the headline and a
 * progress bar. Because the service keeps running, a swipe-dismissed
 * notification (possible on Android 14+ even for ongoing ones) reappears on
 * the next tick.
 */
class FastingService : Service() {
    companion object {
        const val EXTRA_END_AT_MS = "endAtMs"
        const val EXTRA_START_AT_MS = "startAtMs"
        const val EXTRA_GOAL_LABEL = "goalLabel"
        const val CHANNEL_ID = "fasting_countdown"
        const val NOTIFICATION_ID = 4217
    }

    private val handler = Handler(Looper.getMainLooper())
    private var endAtMs: Long = 0
    private var startAtMs: Long = 0
    private var goalLabel: String = "Fasting"

    private val tick = object : Runnable {
        override fun run() {
            updateNotification()
            if (System.currentTimeMillis() < endAtMs) {
                val delay = 60_000L - (System.currentTimeMillis() % 60_000L)
                handler.postDelayed(this, delay)
            } else {
                // Goal reached: leave the final "goal reached" render up; the
                // scheduled completion alert handles the celebratory ping.
                handler.postDelayed({ stopSelf() }, 60_000L)
            }
        }
    }

    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            updateNotification()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureFastingChannel(this)
        ContextCompat.registerReceiver(
            this,
            screenOnReceiver,
            IntentFilter(Intent.ACTION_SCREEN_ON),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent != null) {
            endAtMs = intent.getLongExtra(EXTRA_END_AT_MS, 0)
            startAtMs = intent.getLongExtra(EXTRA_START_AT_MS, System.currentTimeMillis())
            goalLabel = intent.getStringExtra(EXTRA_GOAL_LABEL) ?: "Fasting"
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        handler.removeCallbacks(tick)
        handler.post(tick)
        return START_REDELIVER_INTENT
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        unregisterReceiver(screenOnReceiver)
        super.onDestroy()
    }

    /** "14h 32m left" / "2d 3h 12m left" / "Goal reached 🎉" */
    private fun remainingHeadline(): String {
        val left = endAtMs - System.currentTimeMillis()
        if (left <= 0) return "Goal reached 🎉"
        val totalMin = (left + 59_999) / 60_000
        val d = totalMin / (60 * 24)
        val h = (totalMin % (60 * 24)) / 60
        val m = totalMin % 60
        return when {
            d > 0 -> "${d}d ${h}h ${m}m left"
            h > 0 -> "${h}h ${m}m left"
            else -> "${m}m left"
        }
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

        val endLabel = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(endAtMs))
        val totalMin = ((endAtMs - startAtMs) / 60_000).toInt().coerceAtLeast(1)
        val elapsedMin =
            ((System.currentTimeMillis() - startAtMs) / 60_000).toInt().coerceIn(0, totalMin)
        val done = System.currentTimeMillis() >= endAtMs

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(remainingHeadline())
            .setContentText("$goalLabel · ends $endLabel")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(!done)
            .setWhen(endAtMs)
            .setUsesChronometer(!done)
            .setChronometerCountDown(true)
            .setProgress(totalMin, elapsedMin, false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (contentIntent != null) builder.setContentIntent(contentIntent)
        return builder.build()
    }

    private fun updateNotification() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(NOTIFICATION_ID, buildNotification())
    }
}
