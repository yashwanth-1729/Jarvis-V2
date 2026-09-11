# Which Claude model + effort to use for JARVIS

These are the **coding assistants** that build JARVIS (Claude Code), not the
models JARVIS talks to at runtime — that's still Sarvam. Pick the **cheapest
tier that clears the task**, and raise **effort** only when the problem is
genuinely hard. You're on limited credits, so default low and step up only when
a model visibly struggles.

## The models — least to most capable

| Model | Feel | Cost (in / out per 1M) | Reach for it when… |
| --- | --- | --- | --- |
| **Haiku 4.5** | Fast, cheap, literal. Does what you say, not much beyond. | ~₹ (≈ $1 / $5) | Mechanical work: run tests, read logs, rename, move files, small doc tweaks, apply an obvious edit. |
| **Sonnet 5** | Strong all-rounder. Best capability-per-rupee. | $3 / $15 | **The default for most JARVIS work** — features, ordinary bug fixes, UI polish, a new endpoint, refactors, wiring config. |
| **Opus 5** | Deepest reasoning. Slowest, priciest. | $5 / $25 | The hard ~10%: the fragile voice pipeline, concurrency/atomicity, prompt-salience, cross-file architecture, audits — the bugs that cost this project days. |

*Fable 5.1 is a writing/creative model — not for this code project.*

**Opus "Fast mode"** (`/fast`): Opus intelligence with faster output — same brain,
less waiting. Good when you want Opus quality without the pause.

## Effort levels — low → max

Effort is how much the model *thinks* before answering. More effort helps **only
on hard problems**; on easy ones it just costs more and runs slower.

- **low** — trivial/mechanical; don't overthink it.
- **medium** — the normal coding default.
- **high** — multi-step reasoning, tricky bugs, real design work.
- **xhigh / max** — the nastiest problems only: subtle concurrency, whole-subsystem
  redesign, deep audits. Expensive; use when you're stuck or correctness is critical.

## For JARVIS specifically (cost-first)

| Task on this project | Model | Effort |
| --- | --- | --- |
| Run tests, read logs, rename, move files, tiny doc edit | Haiku 4.5 / Sonnet 5 | low |
| Implement a feature, fix a normal bug, UI work, add an API route, config flag | **Sonnet 5** | medium (→ high if fiddly) |
| Voice pipeline, sync/conflict logic, DB migration atomicity, prompt/salience, memory scoring, agent loop | **Opus 5** | high (xhigh if it fights back) |
| Deep audit, broad research, "be comprehensive" review | Opus 5 | xhigh–max (± ultracode) — $$$, rare |

## Rules of thumb

1. **Default: Sonnet 5, medium.** It handles most of JARVIS and costs a third of Opus.
2. **Jump to Opus only for the genuinely hard, correctness-critical stuff** — the
   class of bug that already burned days here: message ordering, tombstone sync,
   salience contagion, non-atomic migrations.
3. **Don't crank effort by reflex.** high/max is for hard *reasoning*, not for
   making a simple edit feel "more thorough." It won't; it'll just cost more.
4. **Cheapest tier that clears the bar.** Step up a tier or an effort level only
   when the current one visibly can't do it — then step back down.
5. **ultracode is a separate switch** (multi-agent fan-out, cost "not a
   constraint"). Reserve it for a real deep sweep; it's the wrong default for
   incremental work and it has hit usage limits on this account.

*Prices are per 1M tokens and approximate — check current rates in the model
picker. The point is the ratio: Haiku ≈ 1×, Sonnet ≈ 3×, Opus ≈ 5× on input.*
