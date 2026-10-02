package builds.yashwanth.jarvis

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface

/**
 * The switchable launcher icon (Settings → Design lab).
 *
 * The manifest declares one activity-alias per icon, all opening MainActivity;
 * exactly one is enabled at a time. Launchers pick the change up within a few
 * seconds. A home-screen shortcut that pointed at the old alias can vanish and
 * need re-adding from the app drawer: that is how Android treats a disabled
 * launcher entry, not something the app can prevent.
 *
 * Notifications ask [current] every time they ring, so their status-bar glyph
 * and large icon always match the icon the user picked.
 */
object JarvisAppIcon {
  private const val DEFAULT = "classic"
  private val ALIASES = listOf(
    "classic" to "LauncherClassic",
    "holo" to "LauncherHolo",
    "orb" to "LauncherOrb",
    "bubble" to "LauncherBubble",
  )

  /** The icon currently shown by the launcher: classic, holo, orb or bubble. */
  fun current(context: Context): String {
    val packages = context.packageManager
    for ((name, alias) in ALIASES) {
      val enabled = when (packages.getComponentEnabledSetting(component(context, alias))) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
        PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> name == DEFAULT
        else -> false
      }
      if (enabled) return name
    }
    return DEFAULT
  }

  /** Show [name] on the launcher; false if it is not one of the known icons. */
  fun set(context: Context, name: String): Boolean {
    if (ALIASES.none { it.first == name }) return false
    val packages = context.packageManager
    // The new entry is enabled before the others are disabled, so the app is
    // never left without any launcher entry, even for a moment.
    for ((icon, alias) in ALIASES.sortedBy { if (it.first == name) 0 else 1 }) {
      val state = if (icon == name) {
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED
      } else {
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      }
      packages.setComponentEnabledSetting(component(context, alias), state, PackageManager.DONT_KILL_APP)
    }
    return true
  }

  /**
   * Status-bar glyph for [icon]: a white silhouette derived from that icon's
   * own launcher art (no new artwork), one PNG per density in drawable-*dpi.
   */
  fun statusIcon(icon: String): Int = when (icon) {
    "holo" -> R.drawable.ic_stat_jarvis_holo
    "orb" -> R.drawable.ic_stat_jarvis_orb
    "bubble" -> R.drawable.ic_stat_jarvis_bubble
    else -> R.drawable.ic_stat_jarvis_classic
  }

  /** Full-colour launcher art for [icon] (an adaptive icon on Android 8+). */
  fun launcherIcon(icon: String): Int = when (icon) {
    "holo" -> R.mipmap.ic_launcher_holo
    "orb" -> R.mipmap.ic_launcher_orb
    "bubble" -> R.mipmap.ic_launcher_bubble
    else -> R.mipmap.ic_launcher
  }

  private fun component(context: Context, alias: String): ComponentName {
    // Aliases live in the code namespace, which differs from the application
    // id on debug builds (`…jarvis` vs `…jarvis.debug`).
    val namespace = MainActivity::class.java.name.substringBeforeLast('.')
    return ComponentName(context.packageName, "$namespace.$alias")
  }
}

/** The web UI's handle on [JarvisAppIcon] (`window.JarvisAppIcon`). */
class JarvisAppIconBridge(private val context: Context) {
  /** The icon currently shown by the launcher: classic, holo, orb or bubble. */
  @JavascriptInterface
  fun current(): String = JarvisAppIcon.current(context)

  /** Show [name] on the launcher; false if it is not one of the known icons. */
  @JavascriptInterface
  fun set(name: String): Boolean = JarvisAppIcon.set(context, name)
}
