package com.madsbuch.tally.background

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
class BeginTaskArgs {
    var label: String = "Working…"
}

@TauriPlugin
class BackgroundPlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Hold the process open, or re-label an already-held one.
     *
     * Always called while the app is still in the foreground — the frontend
     * begins a task at the moment the user taps, before they can switch away.
     * That matters: Android forbids starting a foreground service from the
     * background, so beginning it any later would be refused outright.
     */
    @Command
    fun beginTask(invoke: Invoke) {
        val args = invoke.parseArgs(BeginTaskArgs::class.java)
        val ctx = activity.applicationContext
        ensureBackgroundChannel(ctx)

        try {
            val intent = Intent(ctx, BackgroundService::class.java).apply {
                putExtra(BackgroundService.EXTRA_LABEL, args.label)
            }
            ContextCompat.startForegroundService(ctx, intent)
            invoke.resolve()
        } catch (e: Exception) {
            // Refused (background start, or a restricted OEM build). The work
            // still runs — it just isn't protected from being frozen — so the
            // frontend logs this and carries on.
            invoke.reject("Could not hold the app awake: ${e.message}")
        }
    }

    @Command
    fun endTask(invoke: Invoke) {
        val ctx = activity.applicationContext
        ctx.stopService(Intent(ctx, BackgroundService::class.java))
        NotificationManagerCompat.from(ctx).cancel(BackgroundService.NOTIFICATION_ID)
        invoke.resolve()
    }
}
