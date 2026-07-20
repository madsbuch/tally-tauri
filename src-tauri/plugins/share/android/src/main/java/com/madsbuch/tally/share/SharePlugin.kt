package com.madsbuch.tally.share

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareFileArgs {
    var path: String = ""
    var mime: String = "application/octet-stream"
    var title: String = "Share"
}

@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {

    /**
     * Opens the system share sheet for a file. The file is copied into the
     * cache dir first because the app's FileProvider exposes cache-path — the
     * original may live anywhere in app-private storage.
     */
    @Command
    fun shareFile(invoke: Invoke) {
        val args = invoke.parseArgs(ShareFileArgs::class.java)
        val ctx = activity.applicationContext
        try {
            val src = File(args.path)
            if (!src.isFile) {
                invoke.reject("File not found: ${args.path}")
                return
            }
            val shareDir = File(ctx.cacheDir, "shared")
            shareDir.mkdirs()
            // Stale exports from earlier shares are useless once re-exported.
            shareDir.listFiles()?.forEach { it.delete() }
            val dst = File(shareDir, src.name)
            src.copyTo(dst, overwrite = true)

            val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", dst)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = args.mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, args.title).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(chooser)
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not open the share sheet: ${e.message}")
        }
    }
}
