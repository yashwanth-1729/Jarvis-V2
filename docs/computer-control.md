# Computer control: UI Automation, browser, OS

Added 2026-09-12. Windows desktop only — gated the same way as the existing
shell/filesystem tools (`capability="system"`, on when
`settings.system_tools_enabled`, which is `false` on Android). This is JARVIS
acting *on* the machine, not just reading/writing its own records: clicking
real buttons, typing into real windows, driving a real browser tab, launching
and closing real processes.

## Why three modules, not one

Screenshots/vision were explicitly ruled out as the primary mechanism — the
model should act on *structured* elements (role, name, text, automation id),
not pixel coordinates, so results are precise and don't break when a window
resizes or a theme changes. Three platforms expose structure three different
ways, so there are three modules, sharing one reference mechanism:

| Module | Structure source | Talks to |
| --- | --- | --- |
| `app/llm/tools_ui_automation.py` | Windows UI Automation (`pywinauto`) | Any native/UWP window — Notepad, Calculator, Settings, other apps |
| `app/llm/tools_browser.py` | Chromium accessibility tree (`playwright`) | Web pages, in a JARVIS-owned browser session |
| `app/llm/tools_os_control.py` | OS APIs directly (`psutil`, `pywin32`, `os.startfile`) | Processes, window focus, clipboard, hotkeys, launching/opening things |

`tools_os_control.py`'s own docstring states the ordering principle:
**prefer the OS mechanism over UI automation whenever one exists.** Opening a
file should be one `open_path` call, not a simulated double-click on a
taskbar icon — that principle is why `launch_app`/`open_path` exist instead
of routing everything through UI Automation.

## Element references: `[e1.3]`, not coordinates or repeated selectors

`tools_automation_common.py`'s `ElementRegistry` is the one piece shared by
UI Automation and the browser (OS control has no live element tree, so it
doesn't need it). Every `*_inspect`/`*_find` call:

1. Bumps a generation counter and replaces the whole reference table —
   never a partial update, because partial invalidation would require
   knowing exactly what changed underneath, which UI Automation and the DOM
   don't reliably tell you.
2. Returns each element as `[e<generation>.<index>]` plus a one-line
   description (role, name, key state) — a numbered list, not JSON, since a
   model reads this, nothing parses it.
3. Truncates past `MAX_ELEMENTS_SHOWN = 40` with a hint to narrow the query
   instead of dumping a whole tree — the progressive-inspection requirement.

Using a reference from an old generation raises `StaleReferenceError`
("re-inspect and use the new reference"); using one that was never issued
raises `ReferenceNotFoundError` ("inspect or search first"). The two are
deliberately distinguished (via a persistent `_ever_issued` set that survives
table resets) because they call for different model behavior — re-inspect,
versus stop guessing ids.

## Risk categorization and the confirmation gate

`ToolSpec` (in `tools.py`) carries a `risk: Literal["low","medium","high"]`
field. Rough rule applied: read-only inspection is `low`; clicking/typing/
toggling within an app is `medium` (ordinary, reversible actions — no
confirmation, same as `add_task` or `update_schedule_event` today);
`high` is reserved for the two actions that are genuinely hard to undo:
**`close_app`** (kills a process; any unsaved work in it is gone instantly,
with no save prompt of its own) and **`browser_submit`** (the moment a form
actually posts/searches/logs in/purchases — the same category of action this
app's own safety rules already require explicit confirmation for elsewhere).

Both `high`-risk tools reuse the exact two-step confirm-then-act shape
`run_command`/`delete_record` already established, rather than a new UI
widget:

1. The first call (no `confirmed` field, or `confirmed=false`) does **not**
   act. It resolves exactly what the action would target — the real
   process(es) `close_app` would kill, or the real element `browser_submit`
   would submit from — and returns a `CONFIRMATION REQUIRED` message naming
   it, with an instruction to read it back to the user verbatim.
2. Only a second call with `confirmed=true` actually performs the action.

This needs no new frontend component: the confirmation is a normal assistant
message in the existing chat/voice turn, and the user's "yes, close it"
becomes the model's next tool call. `resolve_close_targets()`/
`describe_close_targets()` (`tools_os_control.py`) and `describe_element()`
(`tools_browser.py`) are the small building blocks that let the confirmation
step describe the real target without performing the action — an invalid
target (no matching process, an ambiguous name, a stale/unknown element
reference) is refused with a plain error at this first step too, before ever
asking for confirmation.

Every `medium`-risk tool still executes immediately — the gate exists for the
two `high`-risk actions only, matching how narrowly `run_command`'s own
confirmation list is scoped (a short list of destructive shell patterns, not
"every command").

## What's registered as an LLM tool (and what isn't)

27 of the ~45 functions written are registered as callable tools in
`tools.py` — the same "don't bloat every turn's prompt" discipline as the
existing `GetDashboardSummaryInput` consolidation. Registered:

- **OS (7):** `list_processes`, `launch_app`, `close_app`, `open_path`,
  `send_hotkey`, `clipboard_get`, `clipboard_set`.
- **UI Automation (10):** `ui_list_windows`, `ui_focus_window`, `ui_inspect`,
  `ui_find_element`, `ui_click`, `ui_set_text`, `ui_get_text`,
  `ui_press_key`, `ui_toggle`, `ui_select`.
- **Browser (10):** `browser_open`, `browser_navigate`, `browser_inspect`,
  `browser_find`, `browser_click`, `browser_type`, `browser_submit`,
  `browser_get_text`, `browser_current_url`, `browser_title`.

Implemented but **not** exposed as tools yet (functions exist and are
exercised by `computer_control_test.py`'s helpers/manual use, but aren't in
the model's tool list): `ui_scroll`, `ui_expand_collapse`,
`ui_window_action`, multi-tab browser management, file upload. These are
genuinely lower-frequency actions; wiring them in later is one `ToolSpec`
entry each, not new plumbing.

## How the model picks a tool

No explicit router — the same pattern as every other JARVIS tool: each
`ToolSpec.description` states when to use it and, where it matters, when
*not* to (e.g. `tools_os_control.py`'s module docstring: launching an app is
one OS call, not a UI Automation click sequence). The model chooses from
descriptions and schemas the way it already does for the 25 original tools.

## Example tool calls

```jsonc
// "Open Notepad and type a note"
{"name": "launch_app", "input": {"app": "notepad"}}
{"name": "ui_inspect", "input": {"window": "Notepad"}}
// -> "[e1.1] Document \"Text editor\" (focused=true)"
{"name": "ui_set_text", "input": {"element_id": "e1.1", "text": "Buy milk"}}

// "Look up the weather on the web"
{"name": "browser_open", "input": {}}
{"name": "browser_navigate", "input": {"url": "https://example.com"}}
{"name": "browser_find", "input": {"role": "link", "name_contains": "weather"}}
{"name": "browser_click", "input": {"element_id": "e2.1"}}
```

## Known limitations

- **Windows only.** `list_processes`/`open_path` degrade to a clear message
  on other platforms; everything else assumes Windows and isn't guarded for
  other OSes, matching this desktop app's existing scope.
- **Confirmation gate covers only `close_app` and `browser_submit`.** Every
  other `medium`-risk tool (clicking, typing, navigating, toggling, hotkeys,
  clipboard writes, launching an app) executes immediately without asking —
  deliberate, matching how narrowly this app's other confirmation gate
  (`run_command`'s destructive-pattern list) is scoped, and how the personal-
  assistant use case actually needs to feel (constant confirmation prompts for
  routine UI actions would make the feature unusable). If a different medium
  action turns out to need the same gate in practice, it is the same
  `confirmed: bool` + "first call describes, second call with confirmed=true
  acts" shape already used by `close_app`/`browser_submit` — no new mechanism
  to build, just wiring it onto that tool's `Input` model and handler.
- **`SendInput` needs true OS foreground focus.** `ui_click`/`ui_set_text`
  can fail with "SendInput() inserted only 0 out of N keyboard events" if the
  target window isn't the actual foreground window (Windows blocks
  background processes from stealing keyboard input) — confirmed while
  testing: a background automated shell can't always force focus, and an
  ambiguous window-title match (e.g. two windows both containing "Notepad")
  can also land input on the wrong one. `ui_focus_window` should generally
  precede `ui_click`/`ui_set_text` for this reason; a window genuinely in the
  foreground was verified to work correctly and repeatably.
- **27 of ~45 tools registered**, by design — see above.
- **Playwright's `page.accessibility` API is gone** in the installed version
  (1.62.0); `browser_inspect`/`browser_find` use `locator.aria_snapshot()`
  (a text tree) with a small regex parser instead. If Playwright is upgraded
  again, re-check this against its current API before assuming it still
  works.

## Future extension points

- Wire the remaining implemented-but-unregistered functions
  (`ui_scroll`, `ui_expand_collapse`, `ui_window_action`, multi-tab browser
  management, file upload) into `tools.py` when a real use case needs them.
- Extend the confirm-then-act gate to another `medium`-risk tool if it turns
  out to need one in practice (same shape as `close_app`/`browser_submit`,
  see above).
- A visible in-UI confirmation card (rather than the plain chat/voice text
  message the gate currently produces) if the text-only confirmation ever
  feels insufficient in practice.
- A macOS/Linux `tools_os_control.py` backend, if JARVIS desktop ever runs
  there — the module boundary already isolates OS-specific code from the
  tool-facing `ToolSpec` layer.
