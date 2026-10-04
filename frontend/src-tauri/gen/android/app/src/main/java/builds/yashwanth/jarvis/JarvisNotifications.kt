package builds.yashwanth.jarvis

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.Log
import android.webkit.JavascriptInterface
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.Date
import java.util.Locale

private const val PREFS = "jarvis_native_notifications"
private const val PLAN = "alarm_plan"
private const val FIRED_REMINDERS = "fired_reminders"
private const val PERSONA = "persona"
private const val ALARM_ACTION = "builds.yashwanth.jarvis.NOTIFY"
private const val WEEK_MS = 7L * 24L * 60L * 60L * 1000L
private const val DAY_MS = 24L * 60L * 60L * 1000L
private const val TAG = "JarvisNotify"

/**
 * Plan entries under this prefix are one-off copies booked by a notification's
 * Snooze button. The WebView's syncs only replace their own prefixes
 * (schedule:, task:, reminder:, lockin:, checkin:), so a pending snooze
 * survives them.
 */
internal const val SNOOZE_PREFIX = "snooze:"
internal const val SNOOZE_MINUTES = 10

/**
 * Serious mode (nativeNotifications.ts): `lockin:<uid>` rings when a serious
 * block starts, instead of its `schedule:` alarm; `checkin:<YYYY-MM-DD>` is
 * the evening check-in on a day with serious blocks.
 */
internal const val LOCKIN_PREFIX = "lockin:"
internal const val CHECKIN_PREFIX = "checkin:"

data class JarvisAlarm(
  val id: String,
  val title: String,
  val body: String,
  val triggerAt: Long,
  val weekly: Boolean,
  /**
   * Optional hint for the notification card. The WebView may send the
   * schedule kind (COLLEGE, ROUTINE, SESSION); a snoozed copy keeps the kind it
   * was first shown as. Empty when unknown, see [JarvisNotificationCard.kindOf].
   */
  val kind: String = "",
  /** When a snoozed or late-restored copy was originally due; 0 otherwise. */
  val originalAt: Long = 0L,
  /**
   * A Lock-in's mode from the WebView: "session" puts Start on the card,
   * "quick" puts Done. Empty for every other alarm; a snoozed copy keeps it.
   */
  val mode: String = "",
) {
  fun json() = JSONObject().apply {
    put("id", id)
    put("title", title)
    put("body", body)
    put("triggerAt", triggerAt)
    put("weekly", weekly)
    if (kind.isNotEmpty()) put("kind", kind)
    if (originalAt > 0L) put("originalAt", originalAt)
    if (mode.isNotEmpty()) put("mode", mode)
  }

  companion object {
    fun from(json: JSONObject): JarvisAlarm? {
      val id = json.optString("id").trim()
      val title = json.optString("title").trim()
      val triggerAt = json.optLong("triggerAt", 0L)
      if (id.isEmpty() || title.isEmpty() || triggerAt <= 0L) return null
      return JarvisAlarm(
        id = id,
        title = title,
        body = json.optString("body").trim(),
        triggerAt = triggerAt,
        weekly = json.optBoolean("weekly", false),
        kind = if (json.isNull("kind")) "" else json.optString("kind").trim(),
        originalAt = json.optLong("originalAt", 0L),
        mode = if (json.isNull("mode")) "" else json.optString("mode").trim(),
      )
    }
  }
}

object JarvisAlarmStore {
  fun read(context: Context): MutableList<JarvisAlarm> {
    val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(PLAN, "[]") ?: "[]"
    return try {
      val array = JSONArray(raw)
      MutableList(array.length()) { index -> JarvisAlarm.from(array.getJSONObject(index)) }
        .filterNotNull()
        .toMutableList()
    } catch (error: Throwable) {
      Log.w(TAG, "discarding unreadable alarm plan: ${error.message}")
      mutableListOf()
    }
  }

  fun write(context: Context, alarms: List<JarvisAlarm>) {
    val array = JSONArray()
    alarms.forEach { array.put(it.json()) }
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(PLAN, array.toString())
      .apply()
  }

  fun rememberFiredReminder(context: Context, id: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val fired = (prefs.getStringSet(FIRED_REMINDERS, emptySet()) ?: emptySet()).toMutableSet()
    fired += id
    prefs.edit().putStringSet(FIRED_REMINDERS, fired).apply()
  }

  fun firedReminders(context: Context): Set<String> =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getStringSet(FIRED_REMINDERS, emptySet())
      ?.toSet()
      ?: emptySet()

  fun acknowledgeFiredReminders(context: Context, ids: Set<String>) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val remaining = firedReminders(context).filterNot(ids::contains).toSet()
    prefs.edit().putStringSet(FIRED_REMINDERS, remaining).apply()
  }
}

object JarvisAlarmScheduler {
  fun replace(context: Context, prefix: String, json: String): Int {
    val current = JarvisAlarmStore.read(context)
    current.filter { it.id.startsWith(prefix) }.forEach { cancel(context, it.id) }

    val incoming = parse(json).filter { it.id.startsWith(prefix) }
    val merged = current.filterNot { it.id.startsWith(prefix) }.toMutableList()
    merged += incoming
    JarvisAlarmStore.write(context, merged)
    incoming.forEach { schedule(context, nextOccurrence(it)) }
    Log.i(TAG, "synced ${prefix.removeSuffix(":")} alarms: ${incoming.size}")
    return incoming.size
  }

  fun restore(context: Context) {
    val restored = JarvisAlarmStore.read(context).map(::nextOccurrence)
    JarvisAlarmStore.write(context, restored)
    restored.forEach { schedule(context, it) }
    Log.i(TAG, "restored alarms: ${restored.size}")
  }

  fun afterFiring(context: Context, fired: JarvisAlarm) {
    val plan = JarvisAlarmStore.read(context)
    val index = plan.indexOfFirst { it.id == fired.id }
    if (index < 0) return
    if (fired.weekly) {
      val next = nextOccurrence(fired.copy(triggerAt = fired.triggerAt + WEEK_MS))
      plan[index] = next
      JarvisAlarmStore.write(context, plan)
      schedule(context, next)
    } else {
      plan.removeAt(index)
      JarvisAlarmStore.write(context, plan)
    }
  }

  /**
   * The Snooze button: ring [alarm] again in [minutes] as a one-off copy under
   * `snooze:<id>`, through the same exact-alarm path as every other alarm. It
   * replaces an earlier snooze of the same alarm and leaves the original entry
   * alone, so a weekly alarm keeps its slot next week.
   */
  fun snooze(context: Context, alarm: JarvisAlarm, minutes: Int): JarvisAlarm {
    val now = System.currentTimeMillis()
    val again = alarm.copy(
      id = SNOOZE_PREFIX + alarm.id.removePrefix(SNOOZE_PREFIX),
      triggerAt = now + minutes * 60_000L,
      weekly = false,
      originalAt = if (alarm.originalAt > 0L) alarm.originalAt else alarm.triggerAt,
    )
    val plan = JarvisAlarmStore.read(context)
    // Also drop snoozes that can no longer ring (the phone was off for a day).
    plan.removeAll { it.id == again.id || (it.id.startsWith(SNOOZE_PREFIX) && it.triggerAt < now - DAY_MS) }
    plan += again
    JarvisAlarmStore.write(context, plan)
    schedule(context, again)
    Log.i(TAG, "snoozed ${again.id} for $minutes min")
    return again
  }

  private fun parse(raw: String): List<JarvisAlarm> = try {
    val array = JSONArray(raw)
    List(array.length()) { index -> JarvisAlarm.from(array.getJSONObject(index)) }
      .filterNotNull()
  } catch (error: Throwable) {
    Log.w(TAG, "ignored invalid alarm payload: ${error.message}")
    emptyList()
  }

  private fun nextOccurrence(alarm: JarvisAlarm): JarvisAlarm {
    val now = System.currentTimeMillis()
    if (!alarm.weekly) {
      // A phone that was powered off at the requested time should still show a
      // recent one-off reminder after boot. Old forgotten entries stay quiet.
      return if (alarm.triggerAt <= now && now - alarm.triggerAt <= 24L * 60L * 60L * 1000L) {
        // The card still shows when it was due, not this catch-up moment.
        alarm.copy(
          triggerAt = now + 1_500L,
          originalAt = if (alarm.originalAt > 0L) alarm.originalAt else alarm.triggerAt,
        )
      } else alarm
    }
    var trigger = alarm.triggerAt
    while (trigger <= now) trigger += WEEK_MS
    return alarm.copy(triggerAt = trigger)
  }

  private fun requestCode(id: String) = id.hashCode() and 0x7fffffff

  private fun intent(context: Context, id: String): PendingIntent {
    val receiver = Intent(context, JarvisAlarmReceiver::class.java).apply {
      action = ALARM_ACTION
      data = Uri.parse("jarvis://alarm/${Uri.encode(id)}")
      putExtra("alarm_id", id)
    }
    return PendingIntent.getBroadcast(
      context,
      requestCode(id),
      receiver,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun schedule(context: Context, alarm: JarvisAlarm) {
    if (alarm.triggerAt <= System.currentTimeMillis()) return
    val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val operation = intent(context, alarm.id)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !manager.canScheduleExactAlarms()) {
      manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.triggerAt, operation)
    } else {
      manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, alarm.triggerAt, operation)
    }
  }

  private fun cancel(context: Context, id: String) {
    val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    manager.cancel(intent(context, id))
  }
}

/**
 * Who the cards are talking to, set by the public app through
 * [JarvisNotificationBridge.setPersona]: "her" swaps the gendered copy lines
 * for hers ([JarvisNotificationCard]); anything else keeps the defaults. The
 * personal app never sets it.
 */
object JarvisPersona {
  private const val HER = "her"

  fun set(context: Context, value: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(PERSONA, if (value == HER) HER else "")
      .apply()
  }

  fun isHer(context: Context): Boolean =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(PERSONA, "") == HER
}

class JarvisNotificationBridge(
  private val context: Context,
  activity: android.app.Activity? = null,
) {
  /** "her" or "" (PublicContext.tsx); see [JarvisPersona]. */
  @JavascriptInterface
  fun setPersona(value: String): Boolean {
    JarvisPersona.set(context, value)
    return true
  }

  private val activityRef = java.lang.ref.WeakReference(activity)

  /**
   * Ask for notification permission from the web side (the public app's
   * onboarding explains first, then asks). True when already granted.
   */
  @JavascriptInterface
  fun requestPermission(): Boolean {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return true
    val permission = android.Manifest.permission.POST_NOTIFICATIONS
    if (context.checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED) return true
    val activity = activityRef.get() ?: return false
    activity.runOnUiThread { activity.requestPermissions(arrayOf(permission), 4101) }
    return false
  }

  @JavascriptInterface
  fun syncSchedules(json: String): Int = JarvisAlarmScheduler.replace(context, "schedule:", json)

  @JavascriptInterface
  fun syncTasks(json: String): Int = JarvisAlarmScheduler.replace(context, "task:", json)

  @JavascriptInterface
  fun syncReminders(json: String): Int = JarvisAlarmScheduler.replace(context, "reminder:", json)

  @JavascriptInterface
  fun syncLockins(json: String): Int = JarvisAlarmScheduler.replace(context, LOCKIN_PREFIX, json)

  @JavascriptInterface
  fun syncCheckins(json: String): Int = JarvisAlarmScheduler.replace(context, CHECKIN_PREFIX, json)

  /**
   * The Start / Done / Check in tap waiting for the WebView, as JSON
   * `{"verb","uid","occurrence"}`, or "" when there is none. Reading it
   * clears it (lib/notificationActions.ts).
   */
  @JavascriptInterface
  fun takeAction(): String = JarvisPendingAction.take()

  @JavascriptInterface
  fun firedReminders(): String {
    val result = JSONArray()
    JarvisAlarmStore.firedReminders(context).forEach { result.put(it) }
    return result.toString()
  }

  @JavascriptInterface
  fun acknowledgeFiredReminders(json: String): Int {
    val ids = try {
      val values = JSONArray(json)
      (0 until values.length()).map { values.optString(it) }.filter(String::isNotBlank).toSet()
    } catch (_: Throwable) {
      emptySet()
    }
    JarvisAlarmStore.acknowledgeFiredReminders(context, ids)
    return ids.size
  }
}

/**
 * The Start, Done or Check in tap that opened MainActivity, held until the
 * WebView collects it with [JarvisNotificationBridge.takeAction]. One slot: a
 * newer tap replaces one nobody collected, and a tap left uncollected for
 * [TTL_MS] is dropped rather than replayed much later.
 */
object JarvisPendingAction {
  private const val TTL_MS = 10L * 60L * 1000L
  private val VERBS = setOf(VERB_START, VERB_DONE, VERB_CHECKIN)
  private var pending: String? = null
  private var capturedAt = 0L

  /**
   * Keep the action [intent] carries, if any, and clear its notification: an
   * action button, unlike a tap on the card, leaves it up. The verb is removed
   * from [intent], so reading the same intent again is not a second tap.
   */
  fun capture(context: Context, intent: Intent?): Boolean {
    if (intent == null) return false
    val verb = intent.getStringExtra(EXTRA_ACTION)?.trim()?.lowercase(Locale.ROOT) ?: return false
    intent.removeExtra(EXTRA_ACTION)
    if (verb !in VERBS) return false
    if (intent.hasExtra(EXTRA_NOTIFICATION_ID)) {
      context.getSystemService(NotificationManager::class.java)
        ?.cancel(intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0))
    }
    val action = JSONObject().apply {
      put("verb", verb)
      put("uid", intent.getStringExtra(EXTRA_UID)?.trim().orEmpty())
      put("occurrence", intent.getStringExtra(EXTRA_OCCURRENCE)?.trim().orEmpty())
    }.toString()
    synchronized(this) {
      pending = action
      capturedAt = SystemClock.elapsedRealtime()
    }
    Log.i(TAG, "notification action waiting: $verb")
    return true
  }

  /** The waiting action as JSON, cleared once read; "" when there is none or it went stale. */
  fun take(): String = synchronized(this) {
    val action = pending
    pending = null
    if (action == null || SystemClock.elapsedRealtime() - capturedAt > TTL_MS) "" else action
  }
}

class JarvisAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra("alarm_id") ?: return
    val alarm = JarvisAlarmStore.read(context).firstOrNull { it.id == id } ?: return
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return

    // The card, channel, icons and buttons live in JarvisNotificationCard.kt.
    // post() never throws, so the bookkeeping below always runs.
    JarvisNotificationCard.post(context, alarm)
    if (id.startsWith("reminder:")) JarvisAlarmStore.rememberFiredReminder(context, id)
    JarvisAlarmScheduler.afterFiring(context, alarm)
    Log.i(TAG, "delivered alarm: $id")
  }
}

/**
 * The Got it (a check-in's Later) and Snooze buttons on a JARVIS notification.
 * Both clear it; Snooze also books the same alarm again [SNOOZE_MINUTES] from
 * now. Like [JarvisAlarmReceiver], it needs neither the WebView nor Python.
 * Start, Done and Check in open MainActivity instead ([JarvisPendingAction]).
 */
class JarvisNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.hasExtra(EXTRA_NOTIFICATION_ID)) {
      context.getSystemService(NotificationManager::class.java)
        ?.cancel(intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0))
    }
    if (intent.action != ACTION_SNOOZE) {
      Log.i(TAG, "notification done")
      return
    }
    // The alarm rides in the button itself: a one-off has already left the
    // plan by the time Snooze is pressed.
    val alarm = intent.getStringExtra(EXTRA_ALARM)?.let { raw ->
      try {
        JarvisAlarm.from(JSONObject(raw))
      } catch (_: Throwable) {
        null
      }
    } ?: return
    val again = JarvisAlarmScheduler.snooze(context, alarm, SNOOZE_MINUTES)
    val at = DateFormat.getTimeFormat(context).format(Date(again.triggerAt))
    Toast.makeText(context, "Snoozed till $at. Back in $SNOOZE_MINUTES.", Toast.LENGTH_SHORT).show()
  }
}

class JarvisAlarmRestoreReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      Intent.ACTION_TIME_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED -> JarvisAlarmScheduler.restore(context)
    }
  }
}
