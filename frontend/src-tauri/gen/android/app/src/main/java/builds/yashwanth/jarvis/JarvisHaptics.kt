package builds.yashwanth.jarvis

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.JavascriptInterface

/**
 * Touch feedback for the web UI (`window.JarvisHaptics.perform(kind)`).
 *
 * Uses the platform's own haptic patterns through `performHapticFeedback`, so
 * it needs no VIBRATE permission and follows the user's system "Touch
 * feedback" setting: if they turned haptics off, this stays silent. Newer
 * constants fall back to older ones on older Android versions.
 */
class JarvisHapticsBridge(private val view: View) {
  @JavascriptInterface
  fun perform(kind: String) {
    val constant = when (kind) {
      "select" ->
        if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.SEGMENT_TICK else HapticFeedbackConstants.CLOCK_TICK
      "success" ->
        if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
      "warning" ->
        if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
      "heavy" -> HapticFeedbackConstants.LONG_PRESS
      "toggle-on" ->
        if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.CLOCK_TICK
      "toggle-off" ->
        if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.TOGGLE_OFF else HapticFeedbackConstants.CLOCK_TICK
      "gesture" ->
        if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.GESTURE_START else HapticFeedbackConstants.CLOCK_TICK
      else -> HapticFeedbackConstants.VIRTUAL_KEY
    }
    // JavaScript calls arrive on a binder thread; views belong to the UI thread.
    view.post { view.performHapticFeedback(constant) }
  }
}
