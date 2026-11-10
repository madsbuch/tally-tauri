package com.madsbuch.tally

import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var keyboardOpen = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Drawing edge to edge, Android no longer shrinks the window for the
    // keyboard — left to itself it slid the whole app up instead, pushing the
    // top of the page under the status bar while the keys still covered the
    // bottom. So make the room here: pad the content by the keyboard's height
    // (adjustResize in the manifest stops the slide), and the WebView ends
    // where the keys begin, which is what 100dvh then measures.
    val content = findViewById<View>(android.R.id.content)
    // Shows for a moment between the WebView and the keyboard while it slides
    // in. Matches --bg in App.css rather than the theme's white or black; the
    // page corrects it through setDark() once it knows the theme.
    content.setBackgroundColor(Color.parseColor(if (isSystemDark()) BG_DARK else BG_LIGHT))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(0, 0, 0, ime)
      setKeyboardOpen(ime > 0)
      // The padded strip isn't under the WebView any more, so neither is the
      // navigation bar the keyboard covers — don't let it claim a safe area.
      insets.inset(0, 0, 0, ime)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(ThemeBridge(), "TallyTheme")
  }

  private fun isSystemDark(): Boolean =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
      Configuration.UI_MODE_NIGHT_YES

  /**
   * The phone's dark mode flipped. The manifest handles uiMode itself, so the
   * activity isn't recreated and the WebView keeps answering
   * `prefers-color-scheme` as it did at launch — tell the page instead; it
   * asks isSystemDark() and re-themes (src/lib/theme.ts).
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    webView?.evaluateJavascript(
      "window.dispatchEvent(new Event('tally:system-theme'))",
      null,
    )
  }

  /**
   * The page can pin light or dark regardless of the system (src/lib/theme.ts),
   * and edge-to-edge only picks bar icon colours from the system — so the page
   * says which theme it's showing and the icons and backing follow it.
   */
  private inner class ThemeBridge {
    /**
     * Whether the phone is in dark mode, read from the configuration rather
     * than left to the WebView's media query, which only reports dark when the
     * app theme declares itself dark and never updates while the app runs.
     */
    @JavascriptInterface
    fun isSystemDark(): Boolean = this@MainActivity.isSystemDark()

    @JavascriptInterface
    fun setDark(dark: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
        findViewById<View>(android.R.id.content)
          .setBackgroundColor(Color.parseColor(if (dark) BG_DARK else BG_LIGHT))
      }
    }
  }

  private companion object {
    const val BG_LIGHT = "#F3F5EE"
    const val BG_DARK = "#141A16"
  }

  // The page hides the tab bar while you type; only this side knows when.
  private fun setKeyboardOpen(open: Boolean) {
    if (open == keyboardOpen) return
    keyboardOpen = open
    webView?.evaluateJavascript(
      "document.documentElement.classList.toggle('keyboard-open', $open)",
      null,
    )
  }
}
