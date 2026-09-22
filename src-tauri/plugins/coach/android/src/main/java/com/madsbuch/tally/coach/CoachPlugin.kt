package com.madsbuch.tally.coach

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ScheduleCheckinArgs {
    var hour: Int = 21
    var minute: Int = 0
    var dbPath: String = ""
}

@TauriPlugin
class CoachPlugin(private val activity: Activity) : Plugin(activity) {

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
}
