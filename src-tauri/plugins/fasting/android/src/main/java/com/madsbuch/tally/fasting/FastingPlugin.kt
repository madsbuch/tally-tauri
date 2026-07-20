package com.madsbuch.tally.fasting

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class StartCountdownArgs {
    var endAtMs: Long = 0
    var title: String = "Fasting"
    var body: String = ""
}

@TauriPlugin
class FastingPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        const val CHANNEL_ID = "fasting_countdown"
        const val NOTIFICATION_ID = 4217
    }

    private fun ensureChannel(ctx: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Fasting countdown",
                NotificationManager.IMPORTANCE_LOW
            )
            channel.description = "Sticky countdown shown while a fast is active"
            channel.setShowBadge(false)
            val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            mgr.createNotificationChannel(channel)
        }
    }

    @Command
    fun startCountdown(invoke: Invoke) {
        val args = invoke.parseArgs(StartCountdownArgs::class.java)
        val ctx = activity.applicationContext
        ensureChannel(ctx)

        val launchIntent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
        val contentIntent = if (launchIntent != null) {
            PendingIntent.getActivity(
                ctx,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        } else {
            null
        }

        val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle(args.title)
            .setContentText(args.body)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(args.endAtMs)
            .setUsesChronometer(true)
            .setChronometerCountDown(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        if (contentIntent != null) {
            builder.setContentIntent(contentIntent)
        }

        try {
            NotificationManagerCompat.from(ctx).notify(NOTIFICATION_ID, builder.build())
            invoke.resolve()
        } catch (e: SecurityException) {
            invoke.reject("Notification permission not granted: ${e.message}")
        }
    }

    @Command
    fun stopCountdown(invoke: Invoke) {
        NotificationManagerCompat.from(activity.applicationContext).cancel(NOTIFICATION_ID)
        invoke.resolve()
    }
}
