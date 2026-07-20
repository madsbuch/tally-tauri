package com.madsbuch.tally.fasting

import android.app.Activity
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class StartCountdownArgs {
    var endAtMs: Long = 0
    var startAtMs: Long = 0
    var title: String = "Fasting"
    var body: String = ""
}

@TauriPlugin
class FastingPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun startCountdown(invoke: Invoke) {
        val args = invoke.parseArgs(StartCountdownArgs::class.java)
        val ctx = activity.applicationContext
        ensureFastingChannel(ctx)

        try {
            val intent = Intent(ctx, FastingService::class.java).apply {
                putExtra(FastingService.EXTRA_END_AT_MS, args.endAtMs)
                putExtra(
                    FastingService.EXTRA_START_AT_MS,
                    if (args.startAtMs > 0) args.startAtMs else System.currentTimeMillis()
                )
                putExtra(FastingService.EXTRA_GOAL_LABEL, args.title)
            }
            ContextCompat.startForegroundService(ctx, intent)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not start countdown service: ${e.message}")
        }
    }

    @Command
    fun stopCountdown(invoke: Invoke) {
        val ctx = activity.applicationContext
        ctx.stopService(Intent(ctx, FastingService::class.java))
        NotificationManagerCompat.from(ctx).cancel(FastingService.NOTIFICATION_ID)
        invoke.resolve()
    }
}
