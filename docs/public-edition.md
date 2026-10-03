# Public edition: decisions and build plan

This is a second, public edition of the app, built from the same repo. The
personal JARVIS build stays exactly as it is. These decisions were locked with
the user on 2026-10-03; the user said "go with your recommendations". Change
them only with the user.

## Decisions

| Topic | Decision |
| --- | --- |
| Name | Working title **HOLO** (the mascot), kept in one config value. The Design lab candidates are all taken by similar apps: Kairo, Nudgy, Holobud (trademarked hardware with an app) and Hollo (Hollo AI). The final name is still open. |
| Platform | Android first. Desktop later. |
| Age | 18+ at launch (college students and working users). India's DPDP Act needs verifiable parental consent for under-18s, so that is deferred. |
| Plans | Five plans with game names; credits are called **Aura**. |
| Free plan and Lock-in | Lock-in is paid, but onboarding gives a free 3-day Lock-in trial. |
| Gateway host | A new Mumbai-region server, not the existing Sydney VPS: that one has 2 vCPUs, is already swapping and is 255 ms away. |

## Architecture

| | Personal (today) | Public |
| --- | --- | --- |
| Provider keys | In `.env` and on the device | **Only on the gateway.** The app sends the user's login token |
| Login | None | Supabase Auth (Google, phone OTP), in a separate project from the personal one |
| Metering | None | The gateway reserves Aura before a provider call and settles the real cost after |
| Records | IndexedDB first, plus the user's Supabase | Still device-first; optional per-user cloud backup under RLS |
| Tools | Everything, including OS control | No `run_command`, `launch_app`, `install_app`, shell/filesystem, desktop autonomy, personal connectors, API-key settings or Design lab |

The **gateway** is a separate service in `gateway/`. It exposes endpoints
shaped like OpenRouter's, so the on-device backend only changes its base URL
and sends the user's token instead of an API key:

- `POST /v1/chat/completions`: an allow-listed model, streamed or not, metered
  from the provider's `usage`.
- `POST /v1/audio/transcriptions` and `POST /v1/audio/speech`: speech, metered
  per call.
- `GET /v1/me`: plan, Aura balance, unlocked features, renewal date.
- `POST /v1/billing/play`: Google Play real-time developer notifications, which
  set the user's entitlements.
- **Every request:**
  - Verify the Supabase JWT.
  - Check the plan allows the feature: voice, Telugu, Lock-in, news or
    autonomy.
  - Reserve the Aura it will cost, call the provider with the server key, then
    settle the actual cost (refunding any excess) and write a usage row.
- **Limits:** per-user rate limits and daily caps. A Play Integrity check stops
  free-plan farming with throwaway accounts.

## Plans and Aura

| Plan | Price / month | Adds | Aura / month |
| --- | --- | --- | --- |
| Spawn | Free | Tasks, schedule, reminders, memory, text chat | 50 |
| Side Quest | ₹99 | English voice, Lock-in (serious mode) | 250 |
| Main Character | ₹299 | Telugu voice, News Drops | 750 |
| Final Boss | ₹599 | Autonomous agents on the server, higher limits | 1,500 |
| God Mode | ₹1,999 | Top limits, early features | 5,000 |

A top-up costs ₹49 for 150 Aura. Anything done by hand, with no AI involved
(tasks, blocks, reminders), costs no Aura.

### What each action costs (measured 2026-10-03)

| Action | Real cost | Aura |
| --- | --- | --- |
| Text or agent turn | median ₹0.049, p90 ₹0.10, mean ₹0.054 | 1 |
| English voice minute | ≈ ₹0.25 | 3 |
| Telugu voice minute | ≈ ₹0.7 | 7 |
| Timetable or syllabus photo | not measured yet (one vision call) | 5 |
| News Drop | summarised once per topic per day and shared | 0 |
| Autonomous job | not measured yet | 30–150 |

**Where the numbers come from:**
- **Text turns:** 186 real agent turns from the phone's backend log, priced at
  GPT-6 Luna's OpenRouter rates ($0.10 in, $0.50 out and $0.01 cached input
  per 1M tokens). The cache hit rate was about 89%.
- **English voice:** exact costs of recent calls from OpenRouter's generation
  endpoint. Grok STT was about $0.00003 per utterance; Kokoro TTS was about
  $0.000025 per sentence chunk, which is about $2.5 per 1M characters. A voice
  turn costs ≈ ₹0.07 including the LLM, and a minute is about 3–4 turns.
- **Telugu voice:** the cloud stack speaks Telugu with
  `x-ai/grok-voice-tts-1.0` through OpenRouter. It measured about $57 per 1M
  characters, a median of $0.000375 per call, about 15× Kokoro, which makes a
  Telugu minute ≈ ₹0.7. Sarvam's list prices (₹30 per hour of STT, ₹30 per
  10k characters of Bulbul v3) apply only if Sarvam is brought back.

### Margin

- **Net revenue:** after 18% GST and Google Play's 15% subscription fee, about
  72% of the price reaches us. That is ₹71, ₹215, ₹431 and ₹1,440 for the four
  paid plans.
- **Worst case:** allowances are sized so a user who spends every Aura costs at
  most about 35% of net, at ₹0.10 per Aura. That is about a 65% margin or
  better.
- **Typical case:** most users spend about a third of their Aura, which gives
  an 85–90% margin.
- **Cost levers:**
  - **Send only the tools a turn needs.** The tool list is the bulk of the
    roughly 8k-token median prompt.
  - **Keep prompt caching high.**
  - **Cache News Drops per topic.**

## Onboarding ("create your character")

The questions come first and sign-in comes last. One question per screen,
answered with taps and swipes. HOLO reacts to every answer, and a progress bar
reads "Building your HOLO… 40%".

1. Boot: "yo. I'm your new brain. 60 seconds?"
2. Your name, and what HOLO should call you.
3. Vibe: Hype friend, Strict coach, Chill bro or Calm monk. Each plays a
   sample line.
4. You are: school, college, working, creator, or an exam (JEE, NEET, UPSC,
   GATE, CAT). An exam turns on the exam countdown.
5. Interests, as chips: cricket, anime, gaming, coding, Tollywood, music, gym,
   startups, AI, fashion and so on.
6. Your top 3 goals this year.
7. Your enemy: reels, sleep, procrastination, overthinking or having no plan.
   This sets the nudge style.
8. Rhythm: wake and sleep sliders, night owl or early bird.
9. Language: English, Telugu or Hinglish. Telugu shows a lock for Main
   Character.
10. Build your week: snap the timetable, or add blocks one at a time from
    templates (College, Gym, Study, Coaching, Work). A live week preview fills
    as they go.
11. "Which of these can you NOT skip?" This previews Lock-in and starts the
    3-day trial.
12. Notification permission, explained before asking.
13. Reveal the character card (name, vibe, goals, Day 1 streak) with sharing
    to Instagram or WhatsApp. Then sign in to save.
14. A soft paywall that always has a free option.

## Feature roadmap

- **Launch:**
  - snap-to-schedule;
  - Lock-in squads (live "who's locked in", shared streaks, poke, weekly board);
  - Weekly Wrapped story card;
  - Focus Guard (a nudge when a distracting app opens during Lock-in);
  - home-screen widget, and a live Lock-in timer in the notification shade;
  - roast and hype personality.
- **Next:**
  - exam mode;
  - News Drops;
  - Aura earned through streaks and referrals, plus HOLO skins;
  - referrals;
  - campus leaderboards and ambassadors.
- **Top plans:**
  - server agents (Sunday auto-plan, internship and exam-notification
    watchers, research digests);
  - HOLO on WhatsApp.

## Compliance checklist

- Play Billing for subscriptions.
- An in-app "report this reply" option, required for generative-AI apps.
- Account deletion in the app and on the web.
- Declare the usage-access permission (Focus Guard).
- New personal developer accounts must run a closed test: 12 testers for
  14 days.
- A privacy policy. DPDP consent and notice; 18+ only at launch.

## Progress (2026-10-03)

**Phase 0 (measure):** done for text, English voice and Telugu voice. Still
to measure: the timetable photo and an autonomous job.

### Phase 1 (foundation): built and tested

- **Edition switch:**
  - `scripts/build-android.mjs --public --gateway=<origin>` builds
    `builds.yashwanth.holo`, named HOLO, which installs beside JARVIS.
  - The default build is unchanged: `builds.yashwanth.jarvis`, named JARVIS,
    checked from the built APK.
  - The details are in docs/architecture.md, "Editions".
- **Backend:**
  - in the public edition every model call goes to the gateway with the
    user's session;
  - the tool allow-list applies;
  - system tools are off;
  - the cloud stack is forced;
  - gateway refusals become plain messages (out of Aura, plan lock, sign in
    again).
- **Gateway (`gateway/`):**
  - FastAPI service: Supabase JWT, plans, Aura ledger with holds, the three
    OpenRouter routes, Play notifications and an admin grant;
  - Docker Compose with Postgres and Caddy;
  - 6 offline suites, 200 checks.
- **End to end on the laptop:** public backend → local gateway → OpenRouter,
  with temp databases and sync off.
  - A chat turn answered and was charged 0.83 Aura.
  - Voice was locked on Spawn, then worked after a grant to Side Quest
    (0.07 Aura per clip).
  - Telugu stayed locked below Main Character.

### Phase 1: still open

- **Gateway host:** create the public Supabase project, then deploy the gateway
  on the Mumbai host. Both need the owner.
- **Sign-in in the app:** Supabase Auth, handing the token to
  `/api/local/credentials` and refreshing it. This lands with onboarding in
  phase 2.
- **Play:** the real Play purchase verifier and Pub/Sub OIDC auth for the
  billing push.
- **Untested:** nothing has run on Postgres, in Docker or against real
  Supabase tokens yet.

## Build order

0. **Measure** (done above for text and English voice). Still to measure:
   the timetable photo, a Telugu stack and an autonomous job.
1. **Foundation:**
   - the edition flag and a separate Android app id;
   - the gateway (auth, keys, the Aura ledger, limits);
   - the backend switched to the gateway in the public edition;
   - personal-only tools removed from it.
2. **First run:** onboarding, snap-to-schedule, the paywall with Play Billing,
   and the plan locks.
3. **Hooks:** widget, Wrapped, squads, Focus Guard, roast and hype, News
   Drops.
4. **Final Boss agents.**
5. Closed test, a campus pilot, then launch.
