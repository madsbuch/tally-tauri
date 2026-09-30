package com.madsbuch.tally.coach

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class ScheduleCheckinArgs {
    var hour: Int = 21
    var minute: Int = 0
    var dbPath: String = ""
}

@InvokeArg
class NotifyCheckinArgs {
    var chatId: Long = 0
    var title: String = ""
    var body: String = ""
}

@TauriPlugin
class CoachPlugin(private val activity: Activity) : Plugin(activity) {

    override fun load(webView: WebView) {
        super.load(webView)
        // Launched by tapping a check-in: the activity's own intent is the tap.
        CheckinNotification.capture(activity.applicationContext, activity.intent)
        CheckinNotification.watch(activity.application)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Tapped while the app was running. The app also asks on every resume;
        // this is for a tap that never took it out of the foreground.
        if (CheckinNotification.capture(activity.applicationContext, intent)) {
            trigger("checkinOpened", JSObject())
        }
    }

    @Command
    fun scheduleCheckin(invoke: Invoke) {
        val args = invoke.parseArgs(ScheduleCheckinArgs::class.java)
        if (args.dbPath.isBlank()) {
            invoke.reject("No database path was given")
            return
        }
        val ctx = activity.applicationContext
        CoachSchedule.save(ctx, args.hour, args.minute, args.dbPath)
        CoachSchedule.arm(ctx)
        invoke.resolve()
    }

    @Command
    fun cancelCheckin(invoke: Invoke) {
        CoachSchedule.cancel(activity.applicationContext)
        invoke.resolve()
    }

    /** The chat whose check-in notification was tapped, once; `{}` when none. */
    @Command
    fun takeOpenedCheckin(invoke: Invoke) {
        val ret = JSObject()
        CheckinNotification.take(activity.applicationContext)?.let { ret.put("chatId", it) }
        invoke.resolve(ret)
    }

    /** Post the in-app check-in the same way the scheduled one is posted. */
    @Command
    fun notifyCheckin(invoke: Invoke) {
        val args = invoke.parseArgs(NotifyCheckinArgs::class.java)
        val posted = args.chatId > 0 &&
            CheckinNotification.post(activity.applicationContext, args.chatId, args.title, args.body)
        val ret = JSObject()
        ret.put("posted", posted)
        invoke.resolve(ret)
    }
}
