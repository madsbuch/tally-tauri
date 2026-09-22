package com.madsbuch.tally.coach

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Runs the scheduled check-in with the app closed.
 *
 * A foreground service rather than a bare thread: the alarm wakes a process
 * Android is otherwise free to freeze mid-request, which is the same thing
 * that used to drop in-app requests when you switched away. The progress
 * notification it needs anyway is replaced by the check-in itself when one is
 * produced, so the user sees one notification rather than two.
 */
class CoachCheckinService : Service() {
    companion object {
        const val WORKING_CHANNEL_ID = "coach_working"
        const val CHECKIN_CHANNEL_ID = "coach_checkin"
        const val WORKING_NOTIFICATION_ID = 4221
        const val CHECKIN_NOTIFICATION_ID = 4219
    }

    private var worker: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            WORKING_NOTIFICATION_ID,
            workingNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            },
        )

        if (worker?.isAlive == true) return START_NOT_STICKY

        val dbPath = CoachSchedule.dbPath(applicationContext)
        if (dbPath.isNullOrBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }

        // Off the main thread: this opens SQLite and makes a network call.
        worker = Thread {
            var result: CoachWorker.Result? = null
            try {
                result = CoachWorker.run(dbPath)
            } catch (e: Exception) {
                android.util.Log.w("Tally", "Coach check-in failed", e)
            } finally {
                val r = result
                if (r != null && r.sent && r.message != null) {
                    postCheckin(r.title ?: "Your coach", r.message)
                }
                stopSelf()
            }
        }.also { it.start() }

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    private fun contentIntent(): PendingIntent? {
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return null
        return PendingIntent.getActivity(
            this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun workingNotification(): Notification {
        val b = NotificationCompat.Builder(this, WORKING_CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle("Checking in")
            .setContentText("Your coach is looking at your day")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setProgress(0, 0, true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        contentIntent()?.let { b.setContentIntent(it) }
        return b.build()
    }

    /** The check-in itself — the one notification the user should actually see. */
    private fun postCheckin(title: String, message: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val plain = message.replace(Regex("[*_`#]"), "")
        val b = NotificationCompat.Builder(this, CHECKIN_CHANNEL_ID)
            .setSmallIcon(applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(plain)
            .setStyle(NotificationCompat.BigTextStyle().bigText(plain))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        contentIntent()?.let { b.setContentIntent(it) }
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(CHECKIN_NOTIFICATION_ID, b.build())
    }
}

internal fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    // Silent and minimal: this one only exists because a foreground service
    // must show something.
    val working = NotificationChannel(
        CoachCheckinService.WORKING_CHANNEL_ID,
        "Coach working",
        NotificationManager.IMPORTANCE_MIN,
    )
    working.description = "Shown briefly while the coach prepares a check-in"
    working.setShowBadge(false)
    mgr.createNotificationChannel(working)

    val checkin = NotificationChannel(
        CoachCheckinService.CHECKIN_CHANNEL_ID,
        "Coach check-ins",
        NotificationManager.IMPORTANCE_DEFAULT,
    )
    checkin.description = "When your coach has something to say"
    mgr.createNotificationChannel(checkin)
}
