package builds.yashwanth.jarvis

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface

/**
 * Switches the launcher icon for the web UI (`window.JarvisAppIcon`).
 *
 * The manifest declares one activity-alias per icon, all opening MainActivity;
 * exactly one is enabled at a time. Launchers pick the change up within a few
 * seconds. A home-screen shortcut that pointed at the old alias can vanish and
 * need re-adding from the app drawer: that is how Android treats a disabled
 * launcher entry, not something the app can prevent.
 */
class JarvisAppIconBridge(private val context: Context) {
  /** The icon currently shown by the launcher: classic, holo, orb or bubble. */
  @JavascriptInterface
  fun current(): String {
    val packages = context.packageManager
    for ((name, alias) in ALIASES) {
      val enabled = when (packages.getComponentEnabledSetting(component(alias))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> name == DEFAULT
        else -> false
      }
      if (enabled) return name
    }
    return DEFAULT
  }

  /** Show [name] on the launcher; false if it is not one of the known icons. */
  @JavascriptInterface
  fun set(name: String): Boolean {
    if (ALIASES.none { it.first == name }) return false
    val packages = context.packageManager
    // The new entry is enabled before the others are disabled, so the app is
    // never left without any launcher entry, even for a moment.
    for ((alias, component) in ALIASES.sortedBy { if (it.first == name) 0 else 1 }) {
      val state = if (alias == name) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED
      } else {
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      }
      packages.setComponentEnabledSetting(component(component), state, PackageManager.DONT_KILL_APP)
    }
    return true
  }

  private fun component(alias: String): ComponentName {
    // Aliases live in the code namespace, which differs from the application
    // id on debug builds (`…jarvis` vs `…jarvis.debug`).
    val namespace = MainActivity::class.java.name.substringBeforeLast('.')
    return ComponentName(context.packageName, "$namespace.$alias")
  }

  companion object {
    private const val DEFAULT = "classic"
    private val ALIASES = listOf(
      "classic" to "LauncherClassic",
      "holo" to "LauncherHolo",
      "orb" to "LauncherOrb",
      "bubble" to "LauncherBubble",
    )
  }
}
