# Mobile pocket design

The `/mobile/` route replaces the earlier five-destination dashboard concept.
Design direction: voice-first handheld app, not a marketing page. Three spaces:

- Assistant: one large voice action, typing shortcut, next scheduled item.
- My day: date, task/reminder entry points and a chronological timeline.
- Library: tappable notebook covers leading to the existing memory/note editors.

Detail screens remove the navigation dock and provide a back button. Task and
record editors use bottom sheets with visible save/cancel actions. Chat remains
mounted after its first visit so navigation does not discard an unsent draft.

The CSS glass material is a web approximation using translucent fills, inset
highlights and limited backdrop blur. Controls have 12-18px corners; large
surfaces use 20-28px. No purple gradients, pill buttons, invented metrics or
generated imagery. Light/dark/system themes remain available inside Settings.
Motion communicates screen changes, pressed controls, selection and task status.
There is no decorative continuous animation or scroll hijacking. Reduced motion
and reduced transparency get explicit fallbacks.

`PocketVoice.tsx` is presentation only; VoiceMode owns the real audio session.
It exposes language, applicable voice choices, mute/send, stop reply and barge-in.
The audio-level meter uses session data rather than a random waveform.

## First illustration requested from the user

Do not generate artwork automatically. The functional glass microphone control
remains usable without an asset. Once supplied, use this image as noninteractive
decoration behind that button, keeping the button label and icon accessible.

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
