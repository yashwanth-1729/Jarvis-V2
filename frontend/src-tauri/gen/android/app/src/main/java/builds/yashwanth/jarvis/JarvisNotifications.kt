package builds.yashwanth.jarvis

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject

private const val PREFS = "jarvis_native_notifications"
private const val PLAN = "alarm_plan"
private const val FIRED_REMINDERS = "fired_reminders"
private const val CHANNEL_ID = "jarvis_reminders"
private const val ALARM_ACTION = "builds.yashwanth.jarvis.NOTIFY"
private const val WEEK_MS = 7L * 24L * 60L * 60L * 1000L
private const val TAG = "JarvisNotify"

data class JarvisAlarm(
  val id: String,
  val title: String,
  val body: String,
  val triggerAt: Long,
  val weekly: Boolean,
) {
  fun json() = JSONObject().apply {
    put("id", id)
    put("title", title)
    put("body", body)
    put("triggerAt", triggerAt)
    put("weekly", weekly)
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
        alarm.copy(triggerAt = now + 1_500L)
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

class JarvisNotificationBridge(private val context: Context) {
  @JavascriptInterface
  fun syncSchedules(json: String): Int = JarvisAlarmScheduler.replace(context, "schedule:", json)

  @JavascriptInterface
  fun syncTasks(json: String): Int = JarvisAlarmScheduler.replace(context, "task:", json)

  @JavascriptInterface
  fun syncReminders(json: String): Int = JarvisAlarmScheduler.replace(context, "reminder:", json)

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

class JarvisAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra("alarm_id") ?: return
    val alarm = JarvisAlarmStore.read(context).firstOrNull { it.id == id } ?: return
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "JARVIS reminders", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "Scheduled blocks and reminders from JARVIS"
          enableVibration(true)
        },
      )
    }

    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val open = launch?.let {
      PendingIntent.getActivity(
        context,
        id.hashCode() and 0x7fffffff,
        it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      Notification.Builder(context)
    }
    builder
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(alarm.title)
      .setContentText(alarm.body.ifBlank { "Scheduled now" })
      .setStyle(Notification.BigTextStyle().bigText(alarm.body.ifBlank { "Scheduled now" }))
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_REMINDER)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPriority(Notification.PRIORITY_HIGH)
    if (open != null) builder.setContentIntent(open)
    manager.notify(id.hashCode() and 0x7fffffff, builder.build())
    if (id.startsWith("reminder:")) JarvisAlarmStore.rememberFiredReminder(context, id)
    JarvisAlarmScheduler.afterFiring(context, alarm)
    Log.i(TAG, "delivered alarm: $id")
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
