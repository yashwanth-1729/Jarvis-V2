"""Per-turn reasoning-effort routing: escalate only on real reasoning-shaped
turns, at zero cost otherwise -- the classifier is a regex over text already
in hand, never a network call. Regression coverage for
`agent.reasoning_effort_for`.

    .venv/Scripts/python.exe tests/reasoning_routing_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.llm.agent import reasoning_effort_for

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


ROUTINE = [
    "add a task to call the dentist",
    "what's my schedule today",
    "remind me at 5pm to check the oven",
    "delete all my tasks",
    "what's the weather in Nellore",
    "yes",
    "repeat that",
    "switch to Telugu",
    "who is the CEO of Google",
    "renew the domain",
    "",
    None,
]

REASONING_SHAPED = [
    "compare my Monday and Tuesday schedules and tell me which is busier",
    "why do I keep missing my morning class",
    "explain in detail how the sync system works",
    "what are the pros and cons of taking both electives",
    "plan out my week considering the exam and the project deadline",
    "help me figure out how much I'll spend if I renew both subscriptions",
    "think it through step by step before answering",
    "which option is better, plan A or plan B",
]


def main() -> int:
    print("== routine turns escalate nothing ==")
    for text in ROUTINE:
        check(f"stays None: {text!r}", reasoning_effort_for(text) is None)

    print("\n== reasoning-shaped turns escalate ==")
    for text in REASONING_SHAPED:
        result = reasoning_effort_for(text)
        check(f"escalates: {text!r}", result == "low", f"got {result!r}")

    print("\n" + "=" * 60)
    if failures:
        print(f"FAILED ({len(failures)}):")
        for label in failures:
            print(f"  - {label}")
        return 1
    print(f"{passed} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
