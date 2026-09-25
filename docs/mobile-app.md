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
- A live background behind every screen (see below), a light grain texture,
  stickers tilted a few degrees, chunky 20–32 px corners.
- HOLO, a hologram robot, is JARVIS's face: a 3D mascot in voice mode and a
  small CSS version of the same face on the dock button and in chat.

## Screens and where each feature lives

| Area | What it has |
| --- | --- |
| Today | Greeting, live counts, Ask bar (opens chat) with a mic (opens voice), bento tiles: now/next block with live progress, open tasks (+ late sticker), reminders, JARVIS brief with a scrolling ticker (tap to expand). Up next tasks, today's timeline. Offline/saved-data card with Retry; sync spinner/warning in the top bar. |
| Tasks | Filters All / Doing / Late with counts, sort Due / Priority / New, search, grouped buckets (Overdue, Today, Tomorrow, This week, Later, Whenever). |
| Plan | The three schedule sections (My routine, College, Blocks) plus Reminders. Weekday strip (tap or swipe the list) for weekly sections, clash banner and stickers, blocks grouped by date, reminders with relative time and "spoken" state. |
| Memory | Notebook cards with counts, a review callout for candidate memories, recent memories, new page. Each page opens a notebook screen: role filters with counts (Active, Knowledge, Rules, Episodes, Goals, Patterns, Review), search, memory/idea cards, floating add, rename/delete page. |
| Chat | Full-screen sheet (drag the header down to close). Intro with prompt cards, streaming replies (word cascade, then markdown), read aloud, copy, dictation, stop, clear with confirmation, jump-to-latest. The session lives at app level, so drafts and streams survive closing it. |
| Voice | Blooms out of the dock button and HOLO beams in at the centre (tap it to interrupt a reply; it reacts to the tap). Scrambled status label, hint, live captions, Stop reply, Mute & send, Type instead, voice-interruption switch, reply language and speaking voice pickers. |
| Settings | Status strip (assistant, voice, sync), instant theme tiles (System/Light/Dark), live background (Vivid, Wild, Calm or Off; remembered on the device), AI & voice keys, Connected apps (the shared connectors form), Sync & backup (Supabase or SLDT), Location, Assistant connection with Test, Local storage erase (confirm step). "Save & restart" appears only when connection settings change. |

Every record editor is a bottom sheet: title as a big headline, chips for choices,
quick date picks (In 1 hour, Tonight, Tomorrow, Next week) plus the native picker,
weekday dots, time pills, switches. Delete always asks first ("Delete this for
good?"). Validation lives in `frontend/src/lib/recordDrafts.ts` and matches the
desktop editors.

## Motion and gestures

The rule since 2026-09-25: motion must keep playing while React is busy, so it
runs on the browser's compositor thread wherever possible.

- Only `transform` and `opacity` animate, and as real CSS or Web Animations,
  never a JavaScript loop writing styles each frame. framer-motion is used with
  whole `transform` strings (which it hands to WAAPI); its `x`/`y`/`scale`
  shorthands, `whileTap` and `layout`/`layoutId` animations are no longer used
  on the phone because they run on the main thread.
- Springs are sampled once into CSS `linear()` easings (`--spring-snappy`,
  `--spring-bouncy`, `--spring-soft`, `--spring-pop` in `phone.css`, and
  `spring()` in `components/phone/lib/motion.ts` for Web Animations).
- Presses: every button is a plain `<button class="ph-tap">`; `:active` squishes
  it and a bouncy spring transition releases it.
- Pills (dock, segmented controls, the Plan weekday strip) are one element that
  glides on the compositor, stretching on the way and squashing as it lands
  (`useSlidingPill`/`glide` in `lib/motion.ts`). The tapped dock icon hops.
- Scroll: the big title, the top bar's background and its mini title follow a
  CSS scroll-driven animation (`scroll-timeline: --ph-scroll` on `.ph-screen`),
  so they track the finger exactly and scrolling never touches JavaScript.
- Entrances are CSS keyframes (`ph-rise`, `ph-slide-in`, `ph-drop-in`,
  `ph-pop-in`, `ph-bubble-in`, the word-by-word `KineticText`) staggered with
  `--i`. List rows still leave through AnimatePresence (height collapse).
- Tabs stay mounted; a tab that has finished fading out goes idle
  (`content-visibility: hidden`) so hidden tabs cost nothing to style, lay out
  or paint, and keep their state and scroll.
- State is split into small React contexts (data, navigation actions,
  navigation state, finishing, chat, sync, look) and the screens are memoised,
  so a streamed chat word or a tab switch no longer re-renders every screen.
  Task rows are memoised and receive `done` as a prop.
- No `backdrop-filter`: at the phone's density a blur over moving content is
  recomputed every frame over millions of pixels. The dock and the scrolled top
  bar are solid; layers, settings pages and chat are see-through so the live
  background shows behind them (chat uses a translucent scrim). vaul no longer
  scales the app behind a sheet (that re-rasterised the whole screen).
- Tasks: tap the circle or swipe right to finish (check pops, confetti burst,
  row collapses, Undo toast for 4.2 s; leaving the app commits immediately).
  Swipe left to start or pause. A haptic tick marks the swipe threshold.
- Reduced motion: framer uses `reducedMotion="user"`, CSS animations are cut to
  a single frame, the live background and HOLO draw single still frames, and
  confetti is skipped.

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

## Live background

`fx/LiveBackground.tsx` is one WebGL canvas behind every screen: a slow,
domain-warped colour flow in the current tab's palette (Today lime/sky/lilac,
Tasks orange/pink, Plan sky/lilac/mint, Memory lilac/pink), with a vignette and
dithering so gradients never band. It reacts to the app through `fx/fxBus.ts`:

- Every haptic is also an event (`haptic(kind)` emits it at the last touch
  point), and the reaction scales with the event: a tap ripples, a selection
  barely stirs, a heavy press or a finished task blooms (lime), a delete or a
  warning sends a red shockwave, toggles pulse, a tab switch sweeps the colour
  flow in the direction you moved and cross-fades to the new tab's palette.
- Continuous activity raises the flow's energy: a chat reply streaming in, a
  sync running. A finished reply settles with a small ripple.
- Modes (Settings → Live background, stored as `jarvis.phone.fx` on the
  device): Vivid (default), Wild (brighter, bigger shockwaves, sparks), Calm
  (slow and dim) and Off (plain background, nothing drawn).

Cost: it renders at half the CSS resolution (0.62 in Wild) and lets the
compositor scale it up, draws about 60 times a second when idle and every frame
only while something is reacting, compiles its shader without blocking
(`KHR_parallel_shader_compile`, fading in when ready), stops while the page is
hidden, while voice mode covers it and when Off, and ignores events while
stopped so nothing queues up.

## HOLO, the voice mascot

`voice/HoloMascot.tsx` (three.js) replaces the old WebGL orb: a rounded robot
head with a glass visor face, an antenna on a spring, ear pods, a belt ring and
a halo ring, standing on a projector pad with a light beam and rising dust. It
is drawn with hologram shaders (fresnel rim, moving scanlines, glitch slices)
and materialises from the bottom up when voice mode opens.

Everything it does follows the real session:

| State | HOLO |
| --- | --- |
| Connecting | glitchy, "…" mouth, rings spinning |
| Listening | eyes open, small smile, curious head tilt, glances around |
| Hearing you | eyes widen and ears pulse with your microphone level, "o" mouth |
| Thinking | eyes drift up and aside, "…" mouth, loading rings spin fast |
| Speaking | waveform mouth driven by JARVIS's playback level, nods along, happy eyes |
| Muted | eyes shut, colour drains, head droops |
| Idle/offline | dim, slow |

Tapping it squashes and stretches it, makes it grin and glitch (and still
interrupts a reply). Levels come from `levelRef` (microphone, updated outside
React) and `SpeechQueue.outputLevel()` (a passive analyser beside the output,
so what you hear is unchanged). Its shaders are compiled with `compileAsync`
before the first frame so opening voice mode never stalls; pixel ratio is
capped at 2 and drops to 55% if frames run long; it pauses when hidden and
draws still frames under reduced motion. If WebGL is unavailable the CSS face
(`voice/HoloFace.tsx`) stands in.

`voice/HoloFace.tsx` is HOLO in miniature, pure CSS (transform/opacity
animations only): a turning iridescent rim, blinking eyes, an antenna light.
It is the dock's voice button and the face in the chat header and intro, and
it glances up while a reply is being written.

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
- `npx tsx tests/phone-motion.test.ts` checks the spring easings and the live
  background's event bus (activity levels, scene changes, event positions).

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
