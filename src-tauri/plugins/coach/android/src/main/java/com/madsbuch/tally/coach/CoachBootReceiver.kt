package com.madsbuch.tally.coach

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Alarms don't survive a reboot or an app update, and the user may not open
 * Tally for days afterwards — so the schedule is restored from preferences
 * rather than waiting for the app to re-register it.
 */
class CoachBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            return
        }
        CoachSchedule.arm(context.applicationContext)
    }
}
