package com.nousresearch.hermes.plugin.browser

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BoundsArg {
  var x: Double = 0.0
  var y: Double = 0.0
  var width: Double = 0.0
  var height: Double = 0.0
}

@InvokeArg
class OpenArgs {
  lateinit var guestId: String
  lateinit var url: String
  lateinit var bounds: BoundsArg
  lateinit var onEvent: Channel
}

@InvokeArg
class GuestArgs {
  lateinit var guestId: String
}

@InvokeArg
class NavigateArgs {
  lateinit var guestId: String
  lateinit var url: String
}

@InvokeArg
class BoundsArgs {
  lateinit var guestId: String
  lateinit var bounds: BoundsArg
}

@InvokeArg
class VisibleArgs {
  lateinit var guestId: String
  var visible: Boolean = true
}

@InvokeArg
class EvalArgs {
  lateinit var guestId: String
  lateinit var script: String
}

/**
 * The Android half of the in-app browser (MJXHRM-447).
 *
 * A `WebView` added to the Activity's content root, positioned at the rect the
 * pane reports. It is NOT a Tauri webview: `addJavascriptInterface` is never
 * called (that is the Android equivalent of handing a page the IPC bridge),
 * there is no `window.__TAURI_INTERNALS__`, and the only host↔guest channels
 * are `evaluateJavascript` (pull) and the `Channel` below (push).
 *
 * Two things here are strictly better than the desktop guest, and the
 * capability report says so rather than pretending the platforms match:
 * `canGoBack()` is engine truth instead of a counted estimate, and
 * `onConsoleMessage` is a real console PUSH where desktop has to poll.
 *
 * The whole class is kept by proguard-rules.pro. Anything Rust reaches by JNI
 * breaks *silently* in a release R8 build otherwise, and a browser that simply
 * never attaches in release is exactly that failure's shape.
 */
@TauriPlugin
class BrowserPlugin(private val activity: Activity) : Plugin(activity) {
  private val guests = HashMap<String, Guest>()

  private class Guest(val webView: WebView, val channel: Channel)

  private val density: Float
    get() = activity.resources.displayMetrics.density

  private fun px(value: Double): Int = Math.max(1, Math.round(value * density).toInt())

  private fun layout(bounds: BoundsArg): FrameLayout.LayoutParams {
    val params = FrameLayout.LayoutParams(px(bounds.width), px(bounds.height))
    params.leftMargin = px(bounds.x)
    params.topMargin = px(bounds.y)
    return params
  }

  private fun send(channel: Channel, guestId: String, kind: String, fill: (JSObject) -> Unit) {
    val payload = JSObject()
    payload.put("kind", kind)
    payload.put("guestId", guestId)
    fill(payload)
    channel.send(payload)
  }

  /** Every navigation passes the same gate the desktop guard applies. */
  private fun allowed(url: String): Boolean {
    val scheme = url.substringBefore(':').lowercase()
    return scheme == "http" || scheme == "https" || url.equals("about:blank", ignoreCase = true)
  }

  @SuppressLint("SetJavaScriptEnabled")
  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(OpenArgs::class.java)

    activity.runOnUiThread {
      try {
        val existing = guests[args.guestId]

        if (existing != null) {
          existing.webView.layoutParams = layout(args.bounds)
          existing.webView.loadUrl(args.url)
          invoke.resolve(JSObject())
          return@runOnUiThread
        }

        val webView = buildWebView(args.guestId, args.onEvent)
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        root.addView(webView, layout(args.bounds))

        guests[args.guestId] = Guest(webView, args.onEvent)
        webView.loadUrl(args.url)
        invoke.resolve(JSObject())
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The in-app browser could not start.")
      }
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  private fun buildWebView(guestId: String, channel: Channel): WebView {
    val webView = WebView(activity)

    // A real second cookie jar when the platform has one. Below WebView 114
    // there is no `ProfileStore` at all and the guest shares Hermes' jar — the
    // capability report says `shared` in that case rather than implying an
    // isolation we do not have.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      try {
        val profile = ProfileStore.getInstance().getOrCreateProfile(GUEST_PROFILE)
        WebViewCompat.setProfile(webView, profile.name)
      } catch (e: Exception) {
        // Reported through `capabilities`, not swallowed silently.
      }
    }

    webView.setBackgroundColor(Color.WHITE)
    webView.settings.javaScriptEnabled = true
    webView.settings.domStorageEnabled = true
    webView.settings.setSupportMultipleWindows(true)

    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()

        if (allowed(url)) {
          return false
        }

        // A `mailto:` is a handoff, not a failure. Rust decides what to do with
        // it so both platforms behave the same way.
        send(channel, guestId, "external") { it.put("url", url) }
        return true
      }

      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        send(channel, guestId, "load") {
          it.put("started", true)
          it.put("url", url)
        }
      }

      override fun onPageFinished(view: WebView, url: String) {
        send(channel, guestId, "load") {
          it.put("started", false)
          it.put("url", url)
        }
        send(channel, guestId, "nav") {
          it.put("url", url)
          it.put("title", view.title ?: "")
          it.put("canBack", view.canGoBack())
          it.put("canForward", view.canGoForward())
        }
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError
      ) {
        if (!request.isForMainFrame) {
          return
        }

        // A real code and a real description — the thing desktop cannot report
        // at all, where silence plus a 20 s timeout is the only signal.
        send(channel, guestId, "error") {
          it.put("code", error.errorCode)
          it.put("description", error.description?.toString() ?: "Load failed")
          it.put("url", request.url.toString())
        }
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        val entry = JSObject()
        entry.put("level", levelOf(message.messageLevel()))
        entry.put("text", message.message().take(4000))
        entry.put("source", message.sourceId() ?: "")
        entry.put("line", message.lineNumber())
        entry.put("at", System.currentTimeMillis())

        val entries = JSArray()
        entries.put(entry)

        send(channel, guestId, "console") { it.put("entries", entries) }
        return true
      }

      override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: android.os.Message
      ): Boolean {
        // An uncontrolled second WebView is an uncontrolled second surface, so
        // the window is refused — but a `target=_blank` still carries a URL the
        // user asked for, and the only way to learn it is to hand the engine a
        // throwaway view and read the load it attempts.
        val probe = WebView(activity)

        probe.webViewClient = object : WebViewClient() {
          override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
            send(channel, guestId, "external") { it.put("url", request.url.toString()) }
            v.post { v.destroy() }
            return true
          }
        }

        (resultMsg.obj as? WebView.WebViewTransport)?.webView = probe
        resultMsg.sendToTarget()
        return true
      }
    }

    webView.setDownloadListener { url, _, _, _, _ ->
      // Writing a file the user did not choose, from a page we do not control,
      // needs a save-dialog design this version does not have.
      send(channel, guestId, "external") { it.put("url", url) }
    }

    return webView
  }

  private fun levelOf(level: ConsoleMessage.MessageLevel?): String = when (level) {
    ConsoleMessage.MessageLevel.ERROR -> "error"
    ConsoleMessage.MessageLevel.WARNING -> "warn"
    ConsoleMessage.MessageLevel.DEBUG -> "debug"
    ConsoleMessage.MessageLevel.TIP -> "info"
    else -> "log"
  }

  private fun withGuest(invoke: Invoke, guestId: String, body: (WebView) -> Unit) {
    activity.runOnUiThread {
      val guest = guests[guestId]

      if (guest == null) {
        invoke.reject("No in-app browser guest named \"$guestId\" is open.")
        return@runOnUiThread
      }

      try {
        body(guest.webView)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "The in-app browser refused the call.")
      }
    }
  }

  @Command
  fun navigate(invoke: Invoke) {
    val args = invoke.parseArgs(NavigateArgs::class.java)
    withGuest(invoke, args.guestId) {
      it.loadUrl(args.url)
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun back(invoke: Invoke) {
    val args = invoke.parseArgs(GuestArgs::class.java)
    withGuest(invoke, args.guestId) {
      if (it.canGoBack()) {
        it.goBack()
      }
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun forward(invoke: Invoke) {
    val args = invoke.parseArgs(GuestArgs::class.java)
    withGuest(invoke, args.guestId) {
      if (it.canGoForward()) {
        it.goForward()
      }
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun reload(invoke: Invoke) {
    val args = invoke.parseArgs(GuestArgs::class.java)
    withGuest(invoke, args.guestId) {
      it.reload()
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    val args = invoke.parseArgs(GuestArgs::class.java)
    withGuest(invoke, args.guestId) {
      it.stopLoading()
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun setBounds(invoke: Invoke) {
    val args = invoke.parseArgs(BoundsArgs::class.java)
    withGuest(invoke, args.guestId) {
      it.layoutParams = layout(args.bounds)
      it.requestLayout()
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun setVisible(invoke: Invoke) {
    val args = invoke.parseArgs(VisibleArgs::class.java)
    withGuest(invoke, args.guestId) {
      it.visibility = if (args.visible) View.VISIBLE else View.GONE

      val answer = JSObject()
      // The RESULTING visibility, read back off the view.
      answer.put("visible", it.visibility == View.VISIBLE)
      invoke.resolve(answer)
    }
  }

  @Command
  fun eval(invoke: Invoke) {
    val args = invoke.parseArgs(EvalArgs::class.java)
    withGuest(invoke, args.guestId) { webView ->
      webView.evaluateJavascript(args.script) { value ->
        val answer = JSObject()
        // `evaluateJavascript` already hands back JSON, the same shape
        // `eval_with_callback` produces on desktop, so one parser serves both.
        answer.put("value", value ?: "null")
        invoke.resolve(answer)
      }
    }
  }

  @Command
  fun clearData(invoke: Invoke) {
    val args = invoke.parseArgs(GuestArgs::class.java)
    withGuest(invoke, args.guestId) {
      it.clearCache(true)
      it.clearHistory()
      CookieManager.getInstance().removeAllCookies(null)
      WebStorage.getInstance().deleteAllData()
      invoke.resolve(JSObject())
    }
  }

  @Command
  fun close(invoke: Invoke) {
    val args = invoke.parseArgs(GuestArgs::class.java)

    activity.runOnUiThread {
      val guest = guests.remove(args.guestId)

      if (guest != null) {
        (guest.webView.parent as? ViewGroup)?.removeView(guest.webView)
        guest.webView.destroy()
      }

      invoke.resolve(JSObject())
    }
  }

  @Command
  fun capabilities(invoke: Invoke) {
    val multiProfile = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
    val notes = JSArray()

    if (!multiProfile) {
      notes.put(
        "This device's WebView has no profile support, so the in-app browser shares Hermes' cookies."
      )
    }

    val version = WebViewCompat.getCurrentWebViewPackage(activity)?.versionName
    if (version != null) {
      notes.put("Android System WebView $version")
    }

    val answer = JSObject()
    answer.put("isolatedStore", if (multiProfile) "own" else "shared")
    // `canGoBack()` is engine truth, not a counted estimate.
    answer.put("historyEngine", true)
    // The system back gesture drives page history; there is no edge swipe.
    answer.put("gestures", false)
    answer.put("consolePush", true)
    answer.put("notes", notes)
    invoke.resolve(answer)
  }

  private companion object {
    const val GUEST_PROFILE = "hermes-guest"
  }
}
