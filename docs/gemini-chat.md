# Gemini for English chat

Added 2026-09-12. Changes only which model writes REPLY TEXT when the reply
language is English — STT stays Sarvam and TTS stays Piper/Sarvam either way,
completely unchanged. Every other language keeps Sarvam's whole stack,
regardless of this setting.

## Why English only

Gemini and Sarvam are simply different models, and English is the one
language where trying an alternative made sense to compare. Nothing about
the architecture below is English-specific — `get_english_chat_provider()`
is a normal `ChatProvider`, and a second `get_<language>_chat_provider()`
would be a small, mechanical addition if a future language ever needed one.

## How routing works

`app/llm/agent.py`'s `run_turn` decides once per turn:

```python
is_english = language is None or language.split("-")[0].lower() == "en"
provider = get_english_chat_provider() if is_english else get_chat_provider()
```

Typed chat never passes `language` at all — this file's own existing rule
("the text console stays in English") already applied to prompt-building
before this feature existed, and the same default now applies to provider
selection for the same reason. Voice mode passes the user's actual selected
language, so switching to Telugu (or any non-English language) mid-session
routes that reply straight to Sarvam, untouched.

`get_english_chat_provider()` (`app/providers/__init__.py`) returns:

- `EnglishChatProvider` (`app/providers/gemini.py`) when
  `JARVIS_ENGLISH_LLM=gemini` (the default) — Gemini first, Sarvam as a
  per-turn safety net.
- Plain `get_chat_provider()` (Sarvam) when set to `sarvam` — English then
  behaves exactly as it did before this feature existed.

## The Sarvam fallback

`EnglishChatProvider.stream()` tries `GeminiChat` first. If it raises a
`ProviderError` **before yielding anything**, the same request replays on a
`SarvamChat` instance instead, and Gemini is skipped for the next 60 seconds
(a real outage recovers into normal English answers on its own, without every
turn paying Gemini's timeout first). If Gemini has already yielded any text
or a tool call, the error is raised instead of retried — a request may be
replayed only until something has crossed the provider boundary, the same
rule this codebase already applies to Sarvam's own voice-model override.

This is not a theoretical path. It fired live during development: a
deliberately broken model name produced a clean fallback to a normal Sarvam
answer in the same turn, with no error reaching the user.

## Google Search grounding, and its own fallback

Every Gemini call sends `google_search` (built-in grounding) alongside this
app's own `function_declarations` — Gemini 3+ models support combining
built-in and custom tools in one request. If that first attempt fails and
nothing has been emitted yet, the same request retries once with
`google_search` removed, regardless of the error's wording — the real quota
error observed live ("You exceeded your current quota...") never mentions
"search," so the retry cannot be conditioned on error text. The model still
has its own `web_search`/`fetch_url` function tools in the retried request,
so search capability isn't lost, only the built-in grounding path.

This also fired live during development on every single test: this
project's Gemini key has an exhausted (or near-zero) grounding quota, so the
retry-without-search path is the one that actually runs today, not a
hypothetical edge case.

## The `thoughtSignature` requirement

Gemini 3.x models attach a `thoughtSignature` to each function-call response
part, and **require it verbatim** if that exact call is ever replayed in a
later turn's history — omitting it is a hard 400
("Function call is missing a thought_signature"), confirmed live, not a soft
warning as the error text half-implies.

Rather than threading a Gemini-specific field through the shared,
provider-agnostic message history (used identically by Sarvam and persisted
to the `chat_messages` table), `GeminiChat` keeps a process-lifetime
`id -> {name, signature}` cache, populated the moment a call is first issued.
Translating history *to* Gemini's shape:

- A call this same `GeminiChat` instance issued (signature in cache) is
  replayed exactly, signature included.
- A call it never issued — Sarvam's own history, or an id from before this
  process last restarted — has its structured function-call part dropped;
  only its text content is kept. The corresponding tool-result message folds
  into a plain `"Result: ..."` text turn instead of an orphaned
  `functionResponse`.

This trades some structural precision on very old or cross-provider history
for needing zero changes to the shared data model — matching this codebase's
own stated goal for provider modules: "swapping vendors is a new module here
plus an env var; nothing in the agent, the API layer or the UI changes."

## Known limitations

- **Slower than Sarvam for a plain reply.** Measured head-to-head, identical
  prompt: `gemini-3.5-flash-lite` ~1.7s to first token / ~4s total;
  Sarvam's `sarvam-105b-conversations` typically answers in under a second.
  Every Gemini 3.x model "thinks" by default and that budget comes out of
  the same `max_output_tokens` the visible answer does — there is no way to
  request zero thinking on this model generation (`thinking_budget: 0`,
  the 2.5-era knob, is flatly rejected on 3.x; `thinking_level: "low"` is
  accepted but still measured burning real tokens). If voice-mode
  responsiveness ever regresses noticeably, this is the first thing to
  check — restricting Gemini to typed chat only (leaving voice on Sarvam)
  would need a small change to the `is_english` check in `agent.py` to also
  gate on `not voice`.
- **Gemini's own reasoning is not exposed as readable text.** Its "thinking"
  parts carry an opaque `thoughtSignature`, not visible chain-of-thought —
  unlike Sarvam, which streams readable `reasoning_content`. A turn answered
  by Gemini never emits a `"thinking"` event.
- **Model names on this vendor churn fast.** `gemini-2.5-flash` already
  404s for new API keys as of this writing; the error response names
  whatever Google currently recommends. `GEMINI_MODEL` in `.env` is the
  fix — no code change needed.
- **No equivalent for non-English languages.** Explicitly out of scope for
  this pass; Sarvam's whole stack is unchanged for every language but
  English.
