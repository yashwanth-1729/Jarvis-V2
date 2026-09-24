# Phone app (`/mobile/`)

The Android build opens `/mobile/` (see `frontend/src-tauri/tauri.android.conf.json`).
Since 2026-09-25 that route is a new phone app in `frontend/src/components/phone/`,
styled by `frontend/src/app/mobile/phone.css` (everything scoped under `.ph`). It
replaced the earlier "pocket" design (`components/mobile-desk/`, removed) at the
user's request for a complete redesign with smoother motion and a bolder,
youthful look. Nothing of the old layout was kept; every feature was.

## Design language: "Neon Candy"

- Black canvas (`#09090B`) with solid candy tiles and dark ink on them: lime
  `#D4FF3A` (brand), sky, lilac, pink, orange, mint, amber, red. A light theme
  (paper `#F2F0EA`) uses the same tiles; lime becomes a highlighter behind text
  instead of a text colour.
- Colours carry meaning everywhere: class = sky, routine = lilac, block = orange,
  reminders = pink; priority high/medium/low = pink/amber/mint; memory roles have
  one colour each (knowledge sky, rule lime, episode orange, goal pink, pattern
  lilac, working mint).
- Type: Unbounded (wide display), Onest (UI), Silkscreen (pixel tags such as
  `LIVE`, `NEXT`, `CLASH`), JetBrains Mono for numbers. Telugu and Devanagari
  fall back to the system Noto faces.
- Soft colour pools behind each tab (hue shifts per tab), a light grain texture,
  stickers tilted a few degrees, chunky 20–32 px corners.

## Screens and where each feature lives

| Area | What it has |
| --- | --- |
| Today | Greeting, live counts, Ask bar (opens chat) with a mic (opens voice), bento tiles: now/next block with live progress, open tasks (+ late sticker), reminders, JARVIS brief with a scrolling ticker (tap to expand). Up next tasks, today's timeline. Offline/saved-data card with Retry; sync spinner/warning in the top bar. |
| Tasks | Filters All / Doing / Late with counts, sort Due / Priority / New, search, grouped buckets (Overdue, Today, Tomorrow, This week, Later, Whenever). |
| Plan | The three schedule sections (My routine, College, Blocks) plus Reminders. Weekday strip (tap or swipe the list) for weekly sections, clash banner and stickers, blocks grouped by date, reminders with relative time and "spoken" state. |
| Memory | Notebook cards with counts, a review callout for candidate memories, recent memories, new page. Each page opens a notebook screen: role filters with counts (Active, Knowledge, Rules, Episodes, Goals, Patterns, Review), search, memory/idea cards, floating add, rename/delete page. |
| Chat | Full-screen sheet (drag the header down to close). Intro with prompt cards, streaming replies (word cascade, then markdown), read aloud, copy, dictation, stop, clear with confirmation, jump-to-latest. The session lives at app level, so drafts and streams survive closing it. |
| Voice | Blooms out of the dock orb; the orb flies to the centre. WebGL orb, scrambled status label, hint, live captions, Stop reply, Mute & send, Type instead, voice-interruption switch, reply language and speaking voice pickers. |
| Settings | Status strip (assistant, voice, sync), instant theme tiles (System/Light/Dark), AI & voice keys, Connected apps (the shared connectors form), Sync & backup (Supabase or SLDT), Location, Assistant connection with Test, Local storage erase (confirm step). "Save & restart" appears only when connection settings change. |

Every record editor is a bottom sheet: title as a big headline, chips for choices,
quick date picks (In 1 hour, Tonight, Tomorrow, Next week) plus the native picker,
weekday dots, time pills, switches. Delete always asks first ("Delete this for
good?"). Validation lives in `frontend/src/lib/recordDrafts.ts` and matches the
desktop editors.

## Motion and gestures

- One motion system: framer-motion springs for screens, tabs, lists, presence
  and layout; vaul for sheets (velocity-aware drag to dismiss, the app sinks
  back behind a sheet, keyboard repositioning); sonner for toasts.
- Tabs stay mounted and fade/scale through; scroll positions survive. Large
  titles hand over to a compact glass top bar on scroll (motion values, no React
  re-render while scrolling).
- Tasks: tap the circle or swipe right to finish (check pops, confetti burst,
  row collapses, Undo toast for 4.2 s; leaving the app commits immediately).
  Swipe left to start or pause. A haptic tick marks the swipe threshold.
- Buttons squish on press; the dock pill slides between tabs and the icon
  bounces; counts roll (NumberFlow, with screen-reader text).
- Reduced motion: framer uses `reducedMotion="user"`, CSS loops stop, the orb
  draws a single still frame, confetti is skipped.
- Performance rules: transform/opacity only; blur only on small static layers
  (dock and top-bar glass, orb swirl); no blend modes over scrolling content;
  the orb and ambient loops pause while the page is hidden.

## Back button

Every screen, sheet, chat and voice takes one same-URL history entry
(`components/phone/lib/backStack.ts`). The Tauri shell answers Android's back
button with `WebView.goBack()`, so back closes the top layer instead of leaving
the app. Closing from the UI rewinds the entry. Layers register while
`useIsPresent()` is true, so reopening one during its exit animation still gets a
fresh entry. A restart (Settings → Save & restart) unwinds a stale entry on load.

## Native bridges

- Haptics: `MainActivity` attaches `JarvisHapticsBridge` as
  `window.JarvisHaptics`. `perform(kind)` maps tap/select/success/warning/heavy/
  toggle/gesture to `performHapticFeedback` constants (no VIBRATE permission;
  follows the system touch-feedback setting). Without the bridge the UI falls
  back to `navigator.vibrate`, which desktop browsers ignore.
- Keyboard: if only the visual viewport shrinks for the keyboard, the app
  publishes the difference as `--kb` and the chat composer lifts by it. If the
  WebView itself resizes, the inset stays 0.

## Voice orb

`voice/OrbGL.tsx` is one fragment shader on a single triangle: a noise-deformed
sphere with a three-colour swirl, rim light, a specular glint and a halo that
fades out before the canvas edge. Colours blend per state (listening cyan,
hearing lime, thinking violet-pink with a faster swirl, speaking pink-orange,
muted grey). Size and glow follow the real microphone level (`levelRef`, updated
outside React) and JARVIS's playback level (`SpeechQueue.outputLevel()`, a
passive analyser fed next to the existing output connection, so what is heard
is unchanged). Pixel ratio is capped at 2 and drops to 55% if frames run long.
The CSS orb stays visible until the first GL frame is drawn and returns if the
context is lost.

## Development tools

- `node tests/phone-fixture.mjs` serves an in-memory API on 127.0.0.1:8101 with
  sample tasks, schedule, reminders, notes, memories and a simulated chat stream.
  No database, credentials or providers. Run the dev server with
  `NEXT_PUBLIC_API_BASE=http://127.0.0.1:8101` (the `phone-fixture` and
  `phone-preview` entries in `.claude/launch.json`) and open `/mobile/`.
- Development-only URL flags (stripped from production builds): `?voice-demo`
  drives the voice screen with a scripted session (no microphone or socket);
  `?instant` skips JS animations, for checking layouts in a preview that is not
  being painted.
- `node --import tsx tests/phone-logic.test.ts` checks the derivations
  (now/next, task buckets, focus order, reminders, notes pages), the form rules
  and the back-button stack.

## What this does not change

Records, sync, reminders, notification plans, the agent, voice transport and
providers, half-duplex default, language/voice choices and desktop screens all
behave as before. Tool surfaces stay disabled in voice mode, as on the desktop
route. The user-supplied `public/mobile/sea-glass-loop.png` is no longer used
by the phone app and was left in place.

## Validation boundary (2026-09-25)

Checked in a 375×812 emulated browser against the fixture: every screen in both
themes, finish/undo, add/edit/approve flows, schedule and reminder creation,
chat streaming/draft/clear, the scripted voice session, settings navigation and
the back-button stack. Not verified on the phone: haptics, keyboard behaviour,
WebGL performance, touch feel, and a real voice conversation. See the README
maintenance entry for the build and install status.
