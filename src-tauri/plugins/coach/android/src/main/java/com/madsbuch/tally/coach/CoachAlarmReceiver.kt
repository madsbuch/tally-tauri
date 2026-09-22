package com.madsbuch.tally.coach

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/**
 * The daily alarm landing. A receiver gets about ten seconds before Android
 * kills it, which is nowhere near long enough to talk to a model — so it only
 * hands over to the foreground service and re-arms tomorrow's alarm.
 */
class CoachAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val ctx = context.applicationContext
        // Re-arm first: if starting the service throws, the schedule survives.
        CoachSchedule.arm(ctx)
        if (!CoachSchedule.isEnabled(ctx)) return
        try {
            ContextCompat.startForegroundService(
                ctx,
                Intent(ctx, CoachCheckinService::class.java)
            )
        } catch (e: Exception) {
            android.util.Log.w("Tally", "Could not start the coach check-in", e)
        }
    }
}
