# Which Claude model + effort to use for JARVIS

These are the **coding assistants** that build JARVIS (Claude Code), not the
models JARVIS talks to at runtime — that's still Sarvam. Pick the **cheapest
tier that clears the task**, and raise **effort** only when the problem is
genuinely hard. You're on limited credits, so default low and step up only when
a model visibly struggles.

## The lineup, least → most capable

Prices are per 1M tokens (input / output), approximate — check the picker for
current rates. The ratio is the point: Haiku ≈ 1×, Sonnet ≈ 3×, Opus ≈ 5× input.

| Model | ID | Cost (in / out) | Feel / when to reach for it |
| --- | --- | --- | --- |
| **Haiku 4.5** | `claude-haiku-4-5` | $1 / $5 | Fast, cheap, literal. Mechanical work: run tests, read logs, rename, move files, apply an obvious edit, tiny doc tweak. |
| **Sonnet 4.6** | `claude-sonnet-4-6` | $3 / $15 | Previous-gen all-rounder. Only if you've pinned it; otherwise Sonnet 5 is strictly better at the same price. |
| **Sonnet 5** | `claude-sonnet-5` | $3 / $15 | Strong all-rounder, best capability-per-rupee. **The default for most JARVIS work.** |
| **Opus 4.6 → 4.7 → 4.8** | `claude-opus-4-6/-4-7/-4-8` | $5 / $25 | Older Opus point releases; each is a bit smarter than the last. Use only if Opus 5 isn't offered, or you deliberately pin one for run-to-run stability. |
| **Opus 5** | `claude-opus-5` | $5 / $25 | Deepest reasoning, slowest, priciest. The hard ~10% of the work. |

*Fable 5 / 5.1 (`claude-fable-5-1`, $10 / $50) is a creative-writing model — not
for this code project. Mythos 5 is project-restricted; ignore it here.*

### About the version numbers (4.6 vs 4.7 vs 4.8 vs 5)

Within one family, a **higher number = smarter at the same price**, so there's no
trade-off to agonise over: just use the **newest in each family** — **Sonnet 5**
and **Opus 5**. The older `.x` releases exist mainly for API *pinning* (locking a
version so behaviour doesn't shift under you) and for **Fast mode** availability
(below). You don't pick Opus 4.6 over 4.8 to "save" anything — they cost the same;
4.8 is just better. So in practice this whole project is a **two-model choice:
Sonnet 5 for most things, Opus 5 for the hard things.**

**Opus Fast mode** (`/fast`, available on Opus 5 / 4.8): full Opus intelligence
with faster output — same brain, less waiting. Good when you want Opus quality
without the pause.

## Effort levels — low → max

Effort is how much the model *thinks* before answering. More effort helps **only
on hard problems**; on easy ones it just costs more and runs slower. (There's
also **adaptive** — the model decides how much to think per turn; a fine default
when you're unsure.)

- **low** — trivial/mechanical; don't overthink it.
- **medium** — the normal coding default.
- **high** — multi-step reasoning, tricky bugs, real design work.
- **xhigh** — nasty problems: subtle concurrency, whole-subsystem redesign.
- **max** — last resort when correctness is critical and you're stuck. Slow, $$$.

## For JARVIS specifically (cost-first)

| Task on this project | Model | Effort |
| --- | --- | --- |
| Run tests, read logs, rename, move files, tiny doc edit | Haiku 4.5 / Sonnet 5 | low |
| Implement a feature, fix a normal bug, UI work, add an API route, config flag | **Sonnet 5** | medium (→ high if fiddly) |
| Voice pipeline, sync/conflict logic, DB migration atomicity, prompt/salience, memory scoring, agent loop | **Opus 5** | high (xhigh if it fights back) |
| Deep audit, broad research, "be comprehensive" review | Opus 5 | xhigh–max (± ultracode) — $$$, rare |

## Rules of thumb

1. **Default: Sonnet 5, medium.** It handles most of JARVIS at a third of Opus's cost.
2. **Jump to Opus 5 only for the genuinely hard, correctness-critical stuff** — the
   class of bug that already burned days here: message ordering, tombstone sync,
   salience contagion, non-atomic migrations, memory scoring.
3. **Newest in the family, always.** Same price, more capability — never pick an
   older `.x` to economise; there's nothing to economise.
4. **Don't crank effort by reflex.** high/max is for hard *reasoning*, not for
   making a simple edit feel "more thorough." It won't; it'll just cost more.
5. **Cheapest tier that clears the bar.** Step up a tier or an effort level only
   when the current one visibly can't do it — then step back down.
6. **ultracode is a separate switch** (multi-agent fan-out, cost "not a
   constraint"). Reserve it for a real deep sweep; it's the wrong default for
   incremental work and has hit usage limits on this account.
