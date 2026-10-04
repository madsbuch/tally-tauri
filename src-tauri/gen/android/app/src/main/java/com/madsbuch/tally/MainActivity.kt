package com.madsbuch.tally

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
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
    // in. Matches --bg in App.css rather than the theme's white or black.
    content.setBackgroundColor(Color.parseColor("#F3F5EE"))
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
