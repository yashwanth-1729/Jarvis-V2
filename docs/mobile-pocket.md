# Mobile pocket design

The `/mobile/` route replaces the earlier five-destination dashboard concept.
Design direction: voice-first handheld app, not a marketing page. Three spaces:

- Assistant: one large voice action, typing shortcut, next scheduled item.
- My day: date, task/reminder entry points and a chronological timeline.
- Library: tappable notebook covers and a Reminders tile using the existing editor.

Detail screens remove the navigation dock and provide a back button. Task and
record editors use bottom sheets with visible save/cancel actions. Chat remains
mounted after its first visit so navigation does not discard an unsent draft.

The CSS glass material is a web approximation using translucent fills, inset
highlights and limited backdrop blur. Controls have 12-18px corners; large
surfaces use 20-28px. No purple gradients, pill buttons, invented metrics or
agent-generated imagery. Light/dark/system themes remain available inside Settings.
Motion communicates screen changes, pressed controls, selection and task status.
The user also requested soft continuous glass motion: the voice control floats
4px over six seconds, its frame drifts slowly over twelve seconds, and highlights
pass across it over ten/eleven seconds. Main pages and the dock now move together
at a linear 320ms per adjacent space (640ms across two spaces). A rapid retarget
samples the active animation's progress and starts from there; it does not jump
back to a prior tab. Pages stay mounted and retain independent scroll positions.
Inactive pages are inert. Settings uses the same motion controller for its
home/detail transition, with retained outgoing content.
Animations use compositor transforms/opacity, not animated blur. Ambient loops
pause when the document is hidden or voice covers the home screen. There is no
scroll hijacking. Reduced motion disables all motion; reduced transparency
removes the moving highlights and switches glass to solid surfaces.

`PocketVoice.tsx` is presentation only; VoiceMode owns the real audio session.
It exposes language, applicable voice choices, mute/send, stop reply and barge-in.
The audio-level meter uses session data rather than a random waveform.
`VoiceSculpture` adds slow continuous artwork float, two fine orbit outlines,
an ambient halo and thinking dots. Hearing/speaking scale follows real level;
muted input and thinking do not react to stale levels. Hidden documents pause
loops. Reduced motion removes loops and level-driven sculpture scaling.

## Settings and Chat

Pocket Settings has Appearance, Location, AI & voice, Connected apps, Sync &
backup, Assistant connection and Local storage. Existing state/handlers remain
in SettingsPanel, not duplicated. Connection drafts survive category navigation;
Save & restart appears only for changed connection configuration. Appearance,
location and connectors keep their existing immediate-save behavior. Keys stay
masked, erase still needs confirmation, Escape returns to the settings list
before closing, and keyboard focus stays inside the panel.

Pocket Chat keeps the existing streaming/history/dictation/read-aloud handlers.
It adds a compact auto-growing composer, a suggestion list, right-aligned user
messages and flush-left assistant prose. Clear asks for confirmation. Drafts
remain mounted when navigating away. Desktop presentation is the default for
both shared components. The Windows installed-path diagnostic widget is not
shown on this mobile chat screen.

## Supplied illustration

The user supplied `ChatGPT Image Sep 20, 2026, 11_44_51 PM.png`, copied unchanged
to `frontend/public/mobile/sea-glass-loop.png` (1254px square, transparent PNG).
It decorates the microphone, chat intro and live voice state. The accessible
microphone button retains its label and icon; artwork is decorative. No new
image was generated and no image editing was performed.

Prompt: Create a premium 3D editorial illustration for a personal voice assistant
mobile app. One small sculptural loop made from thick frosted sea glass, with
an offset polished inner opening. Pale celadon glass, subtle silver reflections,
deep forest-green edge refraction, soft studio light from upper left. Friendly,
tactile and quietly futuristic, not a robot or a glowing sci-fi orb. Three-quarter
view, centered object occupying 65% of a square canvas, generous clear space.
Transparent background, 1024 x 1024 PNG. No text, letters, logos, UI, microphone
symbol, purple, neon glow, stars or extra objects. Crisp silhouette that remains
readable on both pale sage and dark forest-green backgrounds.

## Validation boundary

UI verification uses `tests/mobile-desk-fixture.mjs`, never real user records.
`tests/pocket-voice.test.tsx` checks the presentation offline without accessing a
microphone or providers. Physical touch/keyboard, native back behavior and live
voice playback still need an installed-device check. A successful static web
build is not an APK installation.

`node --import tsx tests/linear-slide.test.ts` covers linear timing, retargeting,
two-space travel, reduced motion and cleanup (15 assertions). Voice presentation
tests cover state and amplitude guards as well as existing controls (18 assertions).
`node --import tsx tests/pocket-voice-preview.tsx` serves an isolated, noninteractive
visual fixture on loopback :8102; `?state=thinking&theme=light` selects a state/theme.
It never accesses microphone, app storage or providers. The :8101 mobile fixture
also emits explicitly simulated chat SSE for send/stop checks.

2026-09-21 final checks: both suites passed (33 assertions), focused lint was
clean, and `npm run build:native` exported `/` and `/mobile` successfully with
TypeScript validation. The full build still reports the existing `releaseSurface`
effect-dependency warning in `VoiceMode.tsx`; that component was not changed.
Browser checks covered both themes, tab travel, Settings navigation, the Reminders
shortcut, simulated chat streaming/cancellation, retained drafts and decorative
voice states. This is a static web build only: no APK was built or installed and
no real microphone/provider conversation was run for this UI change.
