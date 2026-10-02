package builds.yashwanth.jarvis

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.text.format.DateFormat
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.util.Date
import java.util.Locale

/**
 * Channel settings (vibration, sound, importance) are frozen once a channel
 * exists, so the vibration pattern below needs a new id. The old
 * "jarvis_reminders" channel is deleted when this one is created.
 */
internal const val JARVIS_CHANNEL_ID = "jarvis_reminders_v2"
private const val LEGACY_CHANNEL_ID = "jarvis_reminders"

internal const val ACTION_DONE = "builds.yashwanth.jarvis.NOTIFY_DONE"
internal const val ACTION_SNOOZE = "builds.yashwanth.jarvis.NOTIFY_SNOOZE"
internal const val EXTRA_ALARM = "alarm"
internal const val EXTRA_NOTIFICATION_ID = "notification_id"
private const val CARD_TAG = "JarvisNotify"

/** Tap, tap, buzz: two short knocks and a longer pulse. */
private val VIBRATION = longArrayOf(0L, 60L, 70L, 60L, 70L, 280L)

/**
 * What an alarm is about. Decides the candy chip, the emoji and the copy.
 * Colours follow the app's own tones (Plan: class sky, routine lilac, block
 * orange; deadlines pink; JARVIS's own reminders lime).
 */
enum class JarvisAlarmKind(
  /** Chip text on the expanded card. */
  val label: String,
  /** Lock-screen wording when the content is hidden. */
  val noun: String,
  /** The card's single emoji. */
  val emoji: String,
  /** Candy chip background (same fill in light and dark, dark ink text). */
  val chip: Int,
  /** Copy-line colour, with a values-night variant (Android 12+). */
  val text: Int,
  val lines: List<String>,
) {
  CLASS(
    "CLASS", "Class", "\uD83D\uDCDA", // books
    R.drawable.jarvis_n_chip_sky, R.color.jarvis_n_sky_text,
    listOf(
      "Class is on. Lock in.",
      "Attendance check!",
      "Bunk? Not today.",
      "Notes out, phone down.",
      "Front bench energy.",
      "Prof's waiting. Move.",
    ),
  ),
  ROUTINE(
    "ROUTINE", "Routine", "\uD83D\uDD01", // repeat arrows
    R.drawable.jarvis_n_chip_lilac, R.color.jarvis_n_lilac_text,
    listOf(
      "Routine o'clock.",
      "Same time, same grind.",
      "Streak's on the line.",
      "Consistency is the flex.",
      "Show up for you.",
      "Don't break the chain.",
    ),
  ),

  /** A weekly entry whose class/routine kind the WebView did not send. */
  WEEKLY(
    "WEEKLY", "Weekly plan", "\uD83D\uDCC5", // calendar
    R.drawable.jarvis_n_chip_amber, R.color.jarvis_n_amber_text,
    listOf(
      "It's that time again.",
      "Your slot is live.",
      "Same time, same grind.",
      "Lock in. It's time.",
      "Showing up is the move.",
    ),
  ),
  BLOCK(
    "BLOCK", "Focus block", "\uD83C\uDFAF", // direct hit
    R.drawable.jarvis_n_chip_orange, R.color.jarvis_n_orange_text,
    listOf(
      "Block's live. Lock in.",
      "Phone down, focus up.",
      "Main character hours.",
      "Deep work mode: on.",
      "No scrolling, only doing.",
      "Chalo, focus time.",
    ),
  ),
  DEADLINE(
    "DEADLINE", "Deadline", "\u23F0", // alarm clock
    R.drawable.jarvis_n_chip_pink, R.color.jarvis_n_pink_text,
    listOf(
      "Deadline's here. Ship it.",
      "Due now. Finish strong.",
      "Last call on this one.",
      "Submit first, chill later.",
      "Clutch time. You got this.",
    ),
  ),
  REMINDER(
    "REMINDER", "Reminder", "\uD83D\uDD14", // bell
    R.drawable.jarvis_n_chip_lime, R.color.jarvis_n_lime_text,
    listOf(
      "You asked me to ping you.",
      "Psst. Don't forget this.",
      "Quick nudge from JARVIS.",
      "Heads up, boss.",
      "Bro, it's time.",
    ),
  );
}

/**
 * Builds and posts the notification for one alarm: a decorated custom card
 * (bold title, candy chip, one emoji, a short line of copy), the status-bar
 * glyph and large icon of the launcher icon the user picked, and Got it /
 * Snooze buttons handled by [JarvisNotificationActionReceiver].
 */
object JarvisNotificationCard {
  /** Early half of a default reminder, as `reminderAlarmBody` in nativeNotifications.ts writes it. */
  private val EARLY = Regex("""^In (\d+) minutes?, at (.+?): (.+)$""", RegexOption.DOT_MATCHES_ALL)

  /** Filler bodies the WebView sends for schedule entries without location or notes. */
  private val FILLER_BODIES = setOf("Scheduled now", "Scheduled now \u00B7 repeats weekly")

  // Only used when the WebView did not say whether a weekly entry is a class
  // or a routine; anything unrecognised stays a neutral WEEKLY.
  private val CLASS_WORDS = Regex(
    """\b(class|classes|lecture|lec|lab|labs|tutorial|tut|seminar|practical|period|college|course|viva|elective)\b""",
    RegexOption.IGNORE_CASE,
  )
  private val ROUTINE_WORDS = Regex(
    """\b(gym|workout|run|running|jog|walk|yoga|meditate|meditation|stretch|stretching|read|reading|study|revision|sleep|wake|breakfast|lunch|dinner|swim|swimming|cricket|football|practice|journal|routine)\b""",
    RegexOption.IGNORE_CASE,
  )

  private val EARLY_LINES = listOf(
    "{n} min to go. Get ready.",
    "Heads up: {n} min left.",
    "T-minus {n} min.",
    "{n} min warning.",
  )
  private val SNOOZED_LINES = listOf(
    "Snooze over. For real now.",
    "Round two. No more snoozing.",
    "Okay okay, it's time now.",
    "That was your 10 min.",
  )

  private class Card(
    val kind: JarvisAlarmKind,
    val label: String,
    val title: String,
    val chip: String,
    val line: String,
    val details: String,
  )

  /** Same id as before for an alarm and for its snoozed copy, so they replace each other. */
  fun notificationId(alarmId: String): Int = alarmId.removePrefix(SNOOZE_PREFIX).hashCode() and 0x7fffffff

  /**
   * Show [alarm] now. Never throws, so the receiver's bookkeeping (fired
   * reminders, next weekly occurrence) always runs: if the card cannot be
   * built or posted, the plain notification goes out instead.
   */
  fun post(context: Context, alarm: JarvisAlarm) {
    // The receiver already checks this; repeated here so every notify() below
    // is visibly guarded (Android 13+ runtime permission).
    if (
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    val id = notificationId(alarm.id)
    try {
      ensureChannel(context, manager)
      manager.notify(id, build(context, alarm, id))
    } catch (error: Throwable) {
      Log.w(CARD_TAG, "card failed for ${alarm.id}, posting a plain one: ${error.javaClass.simpleName}: ${error.message}")
      try {
        manager.notify(id, plain(context, alarm, id))
      } catch (fallback: Throwable) {
        Log.e(CARD_TAG, "could not post ${alarm.id}: ${fallback.javaClass.simpleName}: ${fallback.message}")
      }
    }
  }

  /** Create the current channel (and retire the old one) so it shows in Settings before the first alarm. */
  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java) ?: return
    ensureChannel(context, manager)
  }

  private fun ensureChannel(context: Context, manager: NotificationManager) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (manager.getNotificationChannel(JARVIS_CHANNEL_ID) != null) return
    val legacy = manager.getNotificationChannel(LEGACY_CHANNEL_ID)
    // Someone who switched the old channel off in Settings keeps it off.
    val importance = if (legacy?.importance == NotificationManager.IMPORTANCE_NONE) {
      NotificationManager.IMPORTANCE_NONE
    } else {
      NotificationManager.IMPORTANCE_HIGH
    }
    manager.createNotificationChannel(
      NotificationChannel(JARVIS_CHANNEL_ID, "JARVIS reminders", importance).apply {
        description = "Classes, routines, focus blocks, deadlines and reminders from JARVIS"
        enableVibration(true)
        vibrationPattern = VIBRATION
        enableLights(true)
        lightColor = context.getColor(R.color.jarvis_n_lime)
        lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      },
    )
    if (legacy != null) manager.deleteNotificationChannel(LEGACY_CHANNEL_ID)
    Log.i(CARD_TAG, "notification channel $JARVIS_CHANNEL_ID ready")
  }

  /** The kind of [alarm]: an explicit hint first, then its id, then its title. */
  fun kindOf(alarm: JarvisAlarm): JarvisAlarmKind {
    val hint = alarm.kind.trim().uppercase(Locale.ROOT)
    JarvisAlarmKind.values().firstOrNull { it.name == hint }?.let { return it }
    val id = alarm.id.removePrefix(SNOOZE_PREFIX)
    return when {
      id.startsWith("task:") -> JarvisAlarmKind.DEADLINE
      id.startsWith("reminder:") -> JarvisAlarmKind.REMINDER
      hint == "COLLEGE" -> JarvisAlarmKind.CLASS
      hint == "SESSION" -> JarvisAlarmKind.BLOCK
      !alarm.weekly -> JarvisAlarmKind.BLOCK
      CLASS_WORDS.containsMatchIn(alarm.title) -> JarvisAlarmKind.CLASS
      ROUTINE_WORDS.containsMatchIn(alarm.title) -> JarvisAlarmKind.ROUTINE
      else -> JarvisAlarmKind.WEEKLY
    }
  }

  private fun build(context: Context, alarm: JarvisAlarm, notificationId: Int): Notification {
    val kind = kindOf(alarm)
    val card = card(context, alarm, kind)
    val icon = JarvisAppIcon.current(context)
    val glyph = JarvisAppIcon.statusIcon(icon)
    val lime = context.getColor(R.color.jarvis_n_lime)
    // The buttons carry the alarm itself (with its resolved kind): a one-off
    // has already left the plan by the time Snooze is pressed.
    val carried = alarm.copy(kind = kind.name)
    val builder = builder(context)
      .setSmallIcon(glyph)
      .setColor(lime)
      .setContentTitle(card.title)
      .setContentText(card.line)
      .setStyle(Notification.DecoratedCustomViewStyle())
      .setCustomContentView(collapsed(context, card))
      .setCustomBigContentView(expanded(context, card))
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_REMINDER)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setPublicVersion(publicVersion(context, card, glyph, lime))
      .addAction(button(context, ACTION_DONE, "Got it", carried, notificationId, glyph))
      .addAction(button(context, ACTION_SNOOZE, "Snooze $SNOOZE_MINUTES min", carried, notificationId, glyph))
    largeIcon(context, JarvisAppIcon.launcherIcon(icon))?.let { builder.setLargeIcon(it) }
    openApp(context, notificationId)?.let { builder.setContentIntent(it) }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) preOreoAlerts(builder)
    return builder.build()
  }

  /** The old plain look, with the new glyph and channel: only if the card itself failed. */
  private fun plain(context: Context, alarm: JarvisAlarm, notificationId: Int): Notification {
    val text = alarm.body.ifBlank { "Scheduled now" }
    val glyph = try {
      JarvisAppIcon.statusIcon(JarvisAppIcon.current(context))
    } catch (_: Throwable) {
      R.drawable.ic_stat_jarvis_classic
    }
    val builder = builder(context)
      .setSmallIcon(glyph)
      .setColor(context.getColor(R.color.jarvis_n_lime))
      .setContentTitle(alarm.title)
      .setContentText(text)
      .setStyle(Notification.BigTextStyle().bigText(text))
      .setAutoCancel(true)
      .setCategory(Notification.CATEGORY_REMINDER)
      .setVisibility(Notification.VISIBILITY_PRIVATE)
    openApp(context, notificationId)?.let { builder.setContentIntent(it) }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) preOreoAlerts(builder)
    return builder.build()
  }

  private fun builder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, JARVIS_CHANNEL_ID)
    } else {
      Notification.Builder(context)
    }

  /** Android 7.x has no channels: priority, sound and the vibration go on each notification. */
  @Suppress("DEPRECATION")
  private fun preOreoAlerts(builder: Notification.Builder) {
    builder
      .setPriority(Notification.PRIORITY_HIGH)
      .setVibrate(VIBRATION)
      .setDefaults(Notification.DEFAULT_SOUND or Notification.DEFAULT_LIGHTS)
  }

  private fun card(context: Context, alarm: JarvisAlarm, kind: JarvisAlarmKind): Card {
    val snoozed = alarm.id.startsWith(SNOOZE_PREFIX)
    // When it was meant to ring: a snoozed or late-restored copy keeps the original time.
    val at = if (alarm.originalAt > 0L) alarm.originalAt else alarm.triggerAt
    var title = alarm.title.trim()
    var details = alarm.body.trim().takeUnless { it in FILLER_BODIES }.orEmpty()
    var chip = clock(context, at)
    var label = kind.label
    var lead = 0
    if (kind == JarvisAlarmKind.DEADLINE || kind == JarvisAlarmKind.REMINDER) {
      // The WebView sends a generic title ("Task due", "JARVIS reminder") and
      // the real text as the body; the text is what deserves the big type.
      if (details.isNotEmpty()) {
        title = details
        details = ""
      }
    }
    if (kind == JarvisAlarmKind.REMINDER) {
      val early = EARLY.matchEntire(title)
      val minutes = early?.groupValues?.get(1)?.toIntOrNull() ?: 0
      if (early != null && minutes > 0) {
        lead = minutes
        title = early.groupValues[3].trim()
        details = "At ${early.groupValues[2].trim()}"
        // After a snooze "in N min" is no longer true; show the target time.
        chip = if (snoozed) clock(context, at + minutes * 60_000L) else "IN $minutes MIN"
        label = "HEADS UP"
      }
    }
    val seed = (alarm.id.removePrefix(SNOOZE_PREFIX) + "@" + alarm.triggerAt).hashCode()
    val line = when {
      snoozed -> pick(SNOOZED_LINES, seed)
      lead > 0 -> pick(EARLY_LINES, seed).replace("{n}", lead.toString())
      else -> pick(kind.lines, seed)
    }
    return Card(kind, label, title.ifBlank { kind.noun }, chip, line, details)
  }

  private fun pick(lines: List<String>, seed: Int): String = lines[seed.mod(lines.size)]

  /** "9:30 AM" or "21:30", following the phone's 12/24-hour setting. */
  private fun clock(context: Context, at: Long): String =
    DateFormat.getTimeFormat(context).format(Date(at)).uppercase(Locale.getDefault())

  private fun collapsed(context: Context, card: Card): RemoteViews =
    RemoteViews(context.packageName, R.layout.jarvis_notification_collapsed).apply {
      setTextViewText(R.id.jarvis_n_title, card.title)
      setTextViewText(R.id.jarvis_n_time, card.chip)
      setInt(R.id.jarvis_n_time, "setBackgroundResource", card.kind.chip)
      setTextViewText(R.id.jarvis_n_line, "${card.kind.emoji} ${card.line}")
      tint(this, R.id.jarvis_n_line, card.kind)
    }

  private fun expanded(context: Context, card: Card): RemoteViews =
    RemoteViews(context.packageName, R.layout.jarvis_notification_expanded).apply {
      setTextViewText(R.id.jarvis_n_kind, "${card.kind.emoji} ${card.label}")
      setInt(R.id.jarvis_n_kind, "setBackgroundResource", card.kind.chip)
      setTextViewText(R.id.jarvis_n_time, card.chip)
      setTextViewText(R.id.jarvis_n_title, card.title)
      setTextViewText(R.id.jarvis_n_line, card.line)
      tint(this, R.id.jarvis_n_line, card.kind)
      if (card.details.isEmpty()) {
        setViewVisibility(R.id.jarvis_n_details, View.GONE)
      } else {
        setTextViewText(R.id.jarvis_n_details, card.details)
      }
    }

  /**
   * Colour the copy line in the kind's tone. Android 12+ resolves the colour
   * resource when the view is drawn, so it follows a light/dark switch while
   * the notification is showing; older versions keep the notification text
   * colour rather than risk a stale, unreadable tone.
   */
  private fun tint(views: RemoteViews, viewId: Int, kind: JarvisAlarmKind) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      views.setColor(viewId, "setTextColor", kind.text)
    }
  }

  /** What a secure lock screen shows while content is hidden: the kind and the time, never the text. */
  private fun publicVersion(context: Context, card: Card, glyph: Int, color: Int): Notification =
    builder(context)
      .setSmallIcon(glyph)
      .setColor(color)
      .setContentTitle("JARVIS")
      .setContentText("${card.kind.emoji} ${card.kind.noun} \u00B7 ${card.chip}")
      .build()

  private fun button(
    context: Context,
    verb: String,
    title: String,
    alarm: JarvisAlarm,
    notificationId: Int,
    glyph: Int,
  ): Notification.Action {
    val intent = Intent(context, JarvisNotificationActionReceiver::class.java).apply {
      action = verb
      // Distinct data per alarm and button, so each button keeps its own PendingIntent.
      data = Uri.parse("jarvis://notification/${verb.substringAfterLast('_').lowercase(Locale.ROOT)}/${Uri.encode(alarm.id)}")
      putExtra(EXTRA_ALARM, alarm.json().toString())
      putExtra(EXTRA_NOTIFICATION_ID, notificationId)
    }
    val pending = PendingIntent.getBroadcast(
      context,
      notificationId,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return Notification.Action.Builder(Icon.createWithResource(context, glyph), title, pending).build()
  }

  private fun openApp(context: Context, requestCode: Int): PendingIntent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
    } ?: return null
    return PendingIntent.getActivity(
      context,
      requestCode,
      launch,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  /**
   * The launcher art as a rounded tile. An adaptive icon is drawn full bleed
   * (both layers, cropped to their visible middle the way the launcher crops
   * them) so the system's own rounded frame becomes its shape.
   */
  private fun largeIcon(context: Context, res: Int): Bitmap? = try {
    val drawable = context.getDrawable(res)
    if (drawable == null) {
      null
    } else {
      val size = context.resources
        .getDimensionPixelSize(android.R.dimen.notification_large_icon_width)
        .coerceIn(48, 512)
      val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      val radius = size * 0.28f
      canvas.clipPath(
        Path().apply {
          addRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), radius, radius, Path.Direction.CW)
        },
      )
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawable is AdaptiveIconDrawable) {
        // Layers are 108dp with the visible 72dp in the middle: 1/4 of the
        // tile spills over each edge, exactly as AdaptiveIconDrawable does.
        val bleed = size / 4
        listOfNotNull(drawable.background, drawable.foreground).forEach { layer ->
          layer.setBounds(-bleed, -bleed, size + bleed, size + bleed)
          layer.draw(canvas)
        }
      } else {
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)
      }
      bitmap
    }
  } catch (error: Throwable) {
    Log.w(CARD_TAG, "large icon unavailable: ${error.javaClass.simpleName}: ${error.message}")
    null
  }
}
