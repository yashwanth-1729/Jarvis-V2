package builds.yashwanth.jarvis

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

class MainActivity : TauriActivity() {
  private var server: PyObject? = null

  /** Tauri's WebView once the bridges are on it, to announce notification taps. */
  private var bridgedWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // JARVIS always paints a dark canvas, including when Android uses light mode.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    // A notification's Start, Done or Check in may have launched JARVIS (cold
    // start). Not when Android re-creates the activity or reopens it from
    // Recents: those replay the original intent, and that tap was handled.
    if (
      savedInstanceState == null &&
      (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) == 0
    ) {
      JarvisPendingAction.capture(applicationContext, intent)
    }
    attachNotificationBridge()
    // Create the current notification channel (and retire the old one) now,
    // so it shows in system Settings before the first alarm rings.
    try {
      JarvisNotificationCard.ensureChannel(applicationContext)
    } catch (error: Throwable) {
      Log.w(TAG, "notification channel: ${error.javaClass.simpleName}: ${error.message}")
    }
    // The public app asks during onboarding, after explaining why
    // (window.JarvisNotifications.requestPermission()); JARVIS asks at launch.
    if (BuildConfig.JARVIS_EDITION != "public") requestNotificationPermission()
    startBackend()
  }

  /**
   * MainActivity is singleTask, so a notification tap while JARVIS is running
   * (foreground or background) arrives here instead of a new activity.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (JarvisPendingAction.capture(applicationContext, intent)) announceNotificationAction()
  }

  /**
   * Tell the page a notification action may be waiting; it collects it with
   * `JarvisNotifications.takeAction()` (lib/notificationActions.ts). Before the
   * bridge is attached there is no page to tell: attaching announces it then.
   */
  private fun announceNotificationAction() {
    bridgedWebView?.evaluateJavascript(
      "window.dispatchEvent(new Event('jarvis-notification-action'))",
      null,
    )
  }

  private fun requestNotificationPermission() {
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), NOTIFICATION_PERMISSION_REQUEST)
    }
  }

  /** Attach after Tauri creates its WebView, retrying without blocking startup. */
  private fun attachNotificationBridge(attempt: Int = 0) {
    val webView = findWebView(window.decorView)
    if (webView == null) {
      if (attempt < 80) window.decorView.postDelayed({ attachNotificationBridge(attempt + 1) }, 50L)
      return
    }
    webView.addJavascriptInterface(
      JarvisNotificationBridge(applicationContext, this),
      "JarvisNotifications",
    )
    webView.addJavascriptInterface(JarvisHapticsBridge(webView), "JarvisHaptics")
    webView.addJavascriptInterface(JarvisAppIconBridge(applicationContext), "JarvisAppIcon")
    webView.evaluateJavascript(
      "window.dispatchEvent(new Event('jarvis-native-notifications-ready'))",
      null,
    )
    bridgedWebView = webView
    // A cold-start tap is waiting in JarvisPendingAction. The page also asks
    // when it subscribes, so whichever of the two comes later delivers it.
    announceNotificationAction()
    Log.i(TAG, "native notification bridge ready")
    // The on-device Piper/sherpa-onnx voice (JarvisTts.kt) was removed
    // 2026-09-18: speech runs in the cloud, and it added ~206 MB to the APK
    // plus a 106 MB model loaded into memory at every launch for nothing.
    // `window.JarvisTts` is now simply absent; nativeTts.ts treats that as
    // "unavailable", which realtime.ts already assumed.
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      findWebView(view.getChildAt(index))?.let { return it }
    }
    return null
  }

  /**
   * Bring up the embedded JARVIS backend.
   *
   * This device hosts its own JARVIS rather than reaching a machine on the
   * network, so uvicorn runs here, in this process, on loopback. The WebView
   * then talks to 127.0.0.1:8000 exactly as the desktop app talks to its own
   * local backend.
   *
   * Started off the main thread: bringing up CPython, importing FastAPI and
   * opening the database takes long enough to stutter the first frame, and the
   * UI does not need the backend to render — it paints from local storage and
   * upgrades once the backend answers.
   */
  private fun startBackend() {
    Thread({
      try {
        if (!Python.isStarted()) {
          Python.start(AndroidPlatform(this))
        }
        val python = Python.getInstance()
        server = python.getModule("jarvis_server")

        // filesDir is app-private and writable; the backend's own default
        // path would land in Chaquopy's read-only asset directory.
        // The edition comes from the build (Gradle -PjarvisEdition); see
        // jarvis_server.start.
        val report = server!!.callAttr(
          "start", filesDir.absolutePath, BuildConfig.JARVIS_EDITION, BuildConfig.HOLO_GATEWAY_URL,
        ).toString()
        Log.i(TAG, "backend: $report")
      } catch (error: Throwable) {
        // A missing backend costs the assistant and voice, not the board.
        // Local data still renders, so this must not be fatal.
        Log.e(TAG, "backend failed to start: ${error.javaClass.simpleName}: ${error.message}")
      }
    }, "jarvis-backend-start").start()
  }

  /**
   * Tear the backend down with the activity.
   *
   * Foreground-only is a product decision, not an accident: closing JARVIS ends
   * the Python process's work rather than leaving a socket listening and a
   * database open in the background.
   */
  override fun onDestroy() {
    bridgedWebView = null
    try {
      server?.callAttr("stop")?.let { Log.i(TAG, "backend: $it") }
    } catch (error: Throwable) {
      Log.w(TAG, "backend shutdown: ${error.javaClass.simpleName}: ${error.message}")
    } finally {
      server = null
    }
    super.onDestroy()
  }

  companion object {
    /** Grep-able in logcat: `adb logcat -s JarvisPython`. */
    private const val TAG = "JarvisPython"
    private const val NOTIFICATION_PERMISSION_REQUEST = 3201
  }
}
