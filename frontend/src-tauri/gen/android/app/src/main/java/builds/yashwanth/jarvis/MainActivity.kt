package builds.yashwanth.jarvis

import android.Manifest
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

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // JARVIS always paints a dark canvas, including when Android uses light mode.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    attachNotificationBridge()
    requestNotificationPermission()
    startBackend()
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
      JarvisNotificationBridge(applicationContext),
      "JarvisNotifications",
    )
    webView.evaluateJavascript(
      "window.dispatchEvent(new Event('jarvis-native-notifications-ready'))",
      null,
    )
    Log.i(TAG, "native notification bridge ready")
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
        val report = server!!.callAttr("start", filesDir.absolutePath).toString()
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
