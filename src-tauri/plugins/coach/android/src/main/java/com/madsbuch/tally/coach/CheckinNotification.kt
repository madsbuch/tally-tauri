package com.madsbuch.tally.coach

import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The check-in notification, and the tap on it.
 *
 * Both paths that produce a check-in post it through here — the service that
 * runs the scheduled one with the app closed, and the plugin on behalf of the
 * in-app run — so it looks the same, lives on one channel, and always carries
 * the id of the chat it announces. Tapping it opens the app with that id, and
 * the app goes straight to that conversation (src/lib/coachInbox.ts).
 *
 * The tap reaches the app by one of three doors, depending on the state the
 * app was in:
 *
 * - not running: it's the intent that launched the activity, read when the
 *   plugin loads;
 * - running: it's delivered to the (singleTask) activity as a new intent;
 * - process alive but activity gone — swiped away while the fasting timer's
 *   service kept the process up: a new activity is created, which Tauri's
 *   plugins never hear about, so an activity-lifecycle callback watches for it.
 *
 * Whichever door it came through, the id waits here until the app asks for it,
 * and is handed out once.
 */
internal object CheckinNotification {
    private const val EXTRA_CHAT_ID = "com.madsbuch.tally.coach.CHECKIN_CHAT_ID"

    /**
     * Distinct from every other PendingIntent on the launch intent. Extras
     * don't make two PendingIntents different, so sharing a request code with
     * the fasting and background notifications (0, FLAG_UPDATE_CURRENT) would
     * let theirs wipe this one's chat id — or hand them ours.
     */
    private const val REQUEST_CODE = 4219

    private const val PREFS = "tally_coach"
    private const val KEY_LAST_OPENED = "lastOpenedCheckinChat"

    /** The chat a tap asked for and the app hasn't taken yet; 0 for none. */
    private val pending = AtomicLong(0)
    private val watching = AtomicBoolean(false)

    /**
     * Post the check-in for `chatId`, replacing any earlier one. False when
     * notifications aren't allowed.
     */
    fun post(ctx: Context, chatId: Long, title: String, message: String): Boolean {
        if (Build.VERSION.SDK_INT >= 33 &&
            ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        ensureChannels(ctx)
        val plain = message.replace(Regex("[*_`#]"), "")
        val b = NotificationCompat.Builder(ctx, CoachCheckinService.CHECKIN_CHANNEL_ID)
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(plain)
            .setStyle(NotificationCompat.BigTextStyle().bigText(plain))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
        tapIntent(ctx, chatId)?.let { b.setContentIntent(it) }
        val mgr = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        mgr.notify(CoachCheckinService.CHECKIN_NOTIFICATION_ID, b.build())
        return true
    }

    private fun tapIntent(ctx: Context, chatId: Long): PendingIntent? {
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        launch.putExtra(EXTRA_CHAT_ID, chatId)
        return PendingIntent.getActivity(
            ctx, REQUEST_CODE, launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Note the chat an activity intent asks for, if it came from tapping a
     * check-in. True when it did.
     */
    fun capture(ctx: Context, intent: Intent?): Boolean {
        if (intent == null) return false
        // Reopened from Recents: the intent is whatever first started the task.
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false
        val chatId = intent.getLongExtra(EXTRA_CHAT_ID, 0L)
        if (chatId <= 0L) return false
        // An activity rebuilt after its process died is handed the intent it
        // was first started with — an old tap, already followed.
        if (prefs(ctx).getLong(KEY_LAST_OPENED, 0L) == chatId) return false
        pending.set(chatId)
        return true
    }

    /** The chat a tap asked for since the last call, if any. */
    fun take(ctx: Context): Long? {
        val chatId = pending.getAndSet(0)
        if (chatId <= 0L) return null
        prefs(ctx).edit().putLong(KEY_LAST_OPENED, chatId).apply()
        return chatId
    }

    /** Catch taps that create a new activity in a process that's still alive. */
    fun watch(app: Application) {
        if (!watching.compareAndSet(false, true)) return
        app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
                // A restored activity carries the intent it was first started with.
                if (savedInstanceState == null) capture(activity, activity.intent)
            }

            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
