package com.madsbuch.tally.coach

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import java.util.Calendar

/**
 * The daily alarm, and the handful of settings the worker needs to survive a
 * reboot without the app being opened.
 *
 * Deliberately inexact (`setAndAllowWhileIdle`): a check-in at 21:00 ± a few
 * minutes is worth nothing less than one at exactly 21:00, and an exact alarm
 * costs battery and, on newer Android, a permission the app would have to
 * justify. `AllowWhileIdle` is the part that matters — without it Doze holds
 * the alarm until the phone is next picked up, which for an evening check-in
 * could be the following morning.
 *
 * Android has no repeating allow-while-idle alarm, so each firing schedules
 * the next one.
 */
internal object CoachSchedule {
    private const val PREFS = "tally_coach"
    private const val KEY_HOUR = "hour"
    private const val KEY_MINUTE = "minute"
    private const val KEY_DB_PATH = "dbPath"
    private const val KEY_ENABLED = "enabled"
    private const val REQUEST_CODE = 4220

    fun save(ctx: Context, hour: Int, minute: Int, dbPath: String) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putInt(KEY_HOUR, hour.coerceIn(0, 23))
            .putInt(KEY_MINUTE, minute.coerceIn(0, 59))
            .putString(KEY_DB_PATH, dbPath)
            .putBoolean(KEY_ENABLED, true)
            .apply()
    }

    fun disable(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_ENABLED, false)
            .apply()
    }

    fun isEnabled(ctx: Context): Boolean =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false)

    fun dbPath(ctx: Context): String? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_DB_PATH, null)

    private fun hour(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_HOUR, 21)

    private fun minute(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getInt(KEY_MINUTE, 0)

    private fun pendingIntent(ctx: Context): PendingIntent {
        val intent = Intent(ctx, CoachAlarmReceiver::class.java)
        return PendingIntent.getBroadcast(
            ctx,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** Next occurrence of the configured time, always strictly in the future. */
    private fun nextTriggerAt(ctx: Context): Long {
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, hour(ctx))
            set(Calendar.MINUTE, minute(ctx))
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        if (cal.timeInMillis <= System.currentTimeMillis()) {
            cal.add(Calendar.DAY_OF_YEAR, 1)
        }
        return cal.timeInMillis
    }

    /** Arm the next firing. No-op when the user has turned check-ins off. */
    fun arm(ctx: Context) {
        if (!isEnabled(ctx)) return
        val mgr = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val at = nextTriggerAt(ctx)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                mgr.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pendingIntent(ctx))
            } else {
                mgr.set(AlarmManager.RTC_WAKEUP, at, pendingIntent(ctx))
            }
        } catch (e: Exception) {
            // Some OEM builds cap how many alarms an app may hold. Losing the
            // schedule costs a check-in, never the app.
            android.util.Log.w("Tally", "Could not arm the coach alarm", e)
        }
    }

    fun cancel(ctx: Context) {
        disable(ctx)
        val mgr = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        try {
            mgr.cancel(pendingIntent(ctx))
        } catch (e: Exception) {
            android.util.Log.w("Tally", "Could not cancel the coach alarm", e)
        }
    }
}
