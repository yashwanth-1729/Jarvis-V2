# Public edition: decisions and build plan

This is a second, public edition of the app, built from the same repo. The
personal JARVIS build stays exactly as it is. These decisions were locked with
the user on 2026-10-03; the user said "go with your recommendations". Change
them only with the user.

## Decisions

| Topic | Decision |
| --- | --- |
| Name | Shown as **JARVIS Public** on the owner's phone (owner's choice, 2026-10-03). The code name stays HOLO, and so does the package id, `builds.yashwanth.holo`. The store name is still open: "JARVIS" is Marvel's. The Design lab candidates are all taken by similar apps: Kairo, Nudgy, Holobud (trademarked hardware with an app) and Hollo (Hollo AI). The final name is still open. |
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
- `POST /v1/plan/week`: the onboarding's timetable, from GPT-6 Luna with a
  strict JSON schema and checked on the server. It works before sign-in, paid
  from the free pool with a daily limit per IP.
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

### Free plan wallet guard

Free usage is capped in total, not just per user, so it can never cost more
than the owner chooses, however many people sign up:

- **Shared daily pool (enforced):** `FREE_POOL_DAILY_AURA`, default 500 Aura,
  which is ₹50 a day and at most ₹1,500 a month. It's the most all Spawn users
  together may spend per IST day.
  - When it's spent, free AI calls get `free_pool_exhausted` ("back at
    midnight, or Side Quest keeps you going") until midnight.
  - Paid plans are never touched by it.
  - Raise it as revenue grows, for example to 10% of last month's net.
- **Per-user limits (enforced):** 50 Aura a month and at most 25 a day, so one
  user can't drain the pool.
- **Free value that costs nothing:**
  - tasks, schedule, reminders, notifications and the Lock-in trial make no
    AI calls;
  - News Drops are summarised once per topic and shared.
- **Recommended next:** phone-OTP sign-in plus Play Integrity, so one person
  can't farm many free accounts. Aura for referrals is paid for by the
  referral, not by the pool.

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
   - Then (2026-10-05) "Who am I talking to?": A girl / A guy, or "Rather
     not say".
   - For her (the "her" persona) the copy drops guy words ("Bestie", "Chill
     bestie"), HOLO wears a bow, the accent is pink to lilac, notifications
     and JARVIS address her properly, and Lock-in turns black and rose.
   - This is a first version, waiting on the owner's review.
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
10. Build your week (owner's change, 2026-10-04: one AI-built timetable, not
    block-by-block entry; simplified twice the same day after "very hard to add
    or understand" and "lots of disturbance").
    - **Now four calm screens:**
      1. "When's college?" (only for school, college or work);
      2. "What do you want to do every week?" (one input; three examples from
         their own goals in the line under the title);
      3. "How much of your week?" (meters that say what each value means);
      4. "Free time in your week?"
    - **The review:** a donut of the week's split and seven day rings. College
      never shows. The details below still apply.
    - **Ask:**
      - one compact fixed-hours line;
      - one input for what they want or need to do;
      - a small note that JARVIS turns it into the timetable.
    - **A points meter for each item:** 1–10, then MAX. This replaced the
      flames and the daily/5×/3× chips.
    - **A required question:** free blocks, or a strict timetable.
    - **Plan:** HOLO (GPT-6 Luna through `/v1/plan/week`) builds one week
      around the fixed hours, grouped morning, afternoon, evening and night,
      plus "Free time" blocks if they asked for them.
    - **Tweak:** they can mark activities less or more, or leave a comment,
      and tweak up to 5 times. Then "Lock it in" saves it. Free time is saved
      as ROUTINE "Free time" entries and is never offered for Lock-in.
    - "I'll set it up myself" keeps the template builder. Snapping a timetable
      photo is still to come.
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

### Phase 2 (first run): built

- **Gateway on the owner's VPS.** The owner chose this ("use my vps").
  - It runs as systemd `jarvis-public-gateway` on 127.0.0.1:8090: SQLite,
    Python 3.14 in a venv, `MemoryMax=300M`.
  - It's published through a Cloudflare quick tunnel (`jarvis-public-tunnel`),
    with no firewall or Caddy change.
  - The URL changes when the tunnel restarts; `tunnel-url.sh` prints it. A
    named tunnel with a domain is the stable fix.
- **Onboarding:** `components/public/onboarding/`, the 13 steps in the spec. It
  saves `lib/profile.ts` locally and to `/api/profile`.
- **Profile into the persona.** `app/services/profile.py` adds a short "about
  them + your vibe" block to the persona message. It's stable between turns,
  so the prefix cache still hits.
- **Sign-in:** a 6-digit email code against Supabase Auth's REST API
  (`lib/publicAuth.ts`). That works inside the WebView, where Google blocks
  OAuth.
  - The session is handed to the on-device backend whenever it changes or the
    app comes back, and refreshed 2 minutes before it expires.
  - "Not now. Just the planner" keeps the app usable without AI.
- **Plans and Aura:**
  - `GET /v1/me` drives an Aura chip on Today, a Plans layer, and a soft
    paywall shown once after sign-in.
  - Voice is locked below Side Quest (opening voice shows the plans).
  - Lock-in is locked too, with the 3-day trial offered; it starts
    automatically if they picked must-dos in onboarding.
- **AI week planner (2026-10-04):**
  - the gateway's `POST /v1/plan/week`, with 25 offline checks and a live
    plan and tweak on the VPS;
  - the onboarding's two week screens (`PlanSteps.tsx`, `planWeek.ts`).

  The APK is built but not yet run on the device.

  **Reworked later the same day:** a points meter (`PointsMeter.tsx`), the
  free-blocks question, and `points`/`freeTime` on the gateway (38 checks).
- **The product answer (2026-10-04).** The owner's brother asked what the app
  is for and why anyone would pay. The direction agreed:
  - **What it is for:** people who keep making timetables and keep breaking
    them. JARVIS builds the week, bends it when they slip, reaches out at the
    right moment, and shows the honest hours.
  - **Built so far:**
    - catch-up after misses (`/api/focus/catchup`, Today's slipped card);
    - Lock-in nudges with one-tap Start;
    - the evening check-in;
    - Lock-in restyled in black and red, with the stamp and pulse.
  - **Proposed next:**
    - one honest weekly number on Today;
    - Focus Guard;
    - squads;
    - Weekly Wrapped;
    - one paid plan to start, rather than five;
    - a 15–20 person pilot that asks for real money.
- **Play requirements:**
  - "Report this reply" on every JARVIS reply (`POST /v1/report`, a new
    `reports` table).
  - Account deletion in Settings → Account (`DELETE /v1/me`). It removes the
    account rows, anonymises usage, and also removes the Supabase login when
    `SUPABASE_SERVICE_ROLE_KEY` is set.

### Still open (needs the owner)

- **Supabase project.** The free tier allows 2 active projects, and both slots
  are taken (`stitch-witch`, `jarvis-sync`). Pause one or upgrade, then:
  1. set `NEXT_PUBLIC_HOLO_SUPABASE_URL/KEY` for the app build;
  2. set `SUPABASE_URL` (plus the service key, for account deletion) on the
     gateway.
- **Stable gateway URL:** a domain on Cloudflare and a named tunnel.
- **Play Console:**
  - subscription products with obfuscated account id = Supabase user id;
  - the real purchase verifier;
  - Pub/Sub OIDC on the billing push;
  - a closed test with 12 testers for 14 days.

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
