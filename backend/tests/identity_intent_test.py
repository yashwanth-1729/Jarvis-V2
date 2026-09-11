"""Identity/introduction intent classification: `identity.detect_special_intent`.

Pure regex matching over text already in hand -- no network call, no DB --
so this costs nothing and runs fast. Covers every example given in the
spec: the MUST-trigger set, the MUST-NOT-trigger set, and a few extra edge
cases (empty input, embedded mid-sentence, case variance).

    .venv/Scripts/python.exe tests/identity_intent_test.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.identity import JARVIS_INTRODUCTION, detect_special_intent

failures: list[str] = []
passed = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global passed
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if condition:
        passed += 1
    else:
        failures.append(label)


# Every "MUST trigger" example from the spec, verbatim.
MUST_TRIGGER = [
    "My name is Rahul, who are you?",
    "I'm a friend of Yashwanth. Who are you?",
    "Hey Jarvis, what exactly are you?",
    "Can you tell me who you are?",
    "So who created you and what are you supposed to do?",
    "Before we start, introduce yourself.",
    "I've heard about Jarvis, but what actually are you?",
    "Who built you?",
    "What is Jarvis?",
    "Tell me about yourself.",
    # Extra coverage of the intro-list phrasings not already above.
    "Who are you?",
    "What are you?",
    "Introduce yourself.",
    "Tell me about yourself.",
    "What exactly is Jarvis?",
    "Who made you?",
    "What kind of assistant are you?",
    "Who created Jarvis?",
]

# The exact TESTING section list from the spec.
TESTING_POSITIVE = [
    "who are you",
    "what are you",
    "Who exactly are you?",
    "introduce yourself",
    "tell me about yourself",
    "what is jarvis",
    "who made you",
    "who built you",
    "my name is Alex, who are you?",
    "I am a friend of Yashwanth, what exactly are you?",
    "before we continue can you introduce yourself",
]

# Every "MUST NOT trigger" example from the spec, verbatim.
MUST_NOT_TRIGGER = [
    "Who are you talking about?",
    "Who are you calling?",
    "What are you doing?",
    "What are you working on?",
    "Who is Yashwanth?",
    "What is artificial intelligence?",
    "Who are they?",
    "Who created Python?",
    "Why are you saying that?",
]

TESTING_NEGATIVE = [
    "who are you talking to",
    "what are you doing",
    "who is Yashwanth",
    "who created Linux",
    "what are you thinking about",
    "who are you calling",
]


def main() -> int:
    print("== single source of truth ==")
    check(
        "JARVIS_INTRODUCTION starts with the documented opener",
        JARVIS_INTRODUCTION.startswith("Who am I?"),
    )
    check(
        "JARVIS_INTRODUCTION names the founder and company",
        "Yashwanth Cherukuru" in JARVIS_INTRODUCTION and "Yashwanth Builds" in JARVIS_INTRODUCTION,
    )

    print("\n== MUST trigger (spec examples) ==")
    for text in MUST_TRIGGER:
        result = detect_special_intent(text)
        check(f"triggers: {text!r}", result is not None and result.name == "identity")

    print("\n== TESTING section: positive cases ==")
    for text in TESTING_POSITIVE:
        result = detect_special_intent(text)
        check(f"triggers: {text!r}", result is not None and result.name == "identity")

    print("\n== every positive match returns the exact canonical text ==")
    for text in MUST_TRIGGER + TESTING_POSITIVE:
        result = detect_special_intent(text)
        if result is not None:
            check(
                f"exact canonical response: {text!r}",
                result.response == JARVIS_INTRODUCTION,
            )

    print("\n== MUST NOT trigger (spec examples) ==")
    for text in MUST_NOT_TRIGGER:
        result = detect_special_intent(text)
        check(f"stays None: {text!r}", result is None, f"got {result!r}")

    print("\n== TESTING section: false-positive cases ==")
    for text in TESTING_NEGATIVE:
        result = detect_special_intent(text)
        check(f"stays None: {text!r}", result is None, f"got {result!r}")

    print("\n== embedded mid-sentence still triggers ==")
    embedded = [
        "So anyway, who are you, exactly, if you don't mind me asking?",
        "Quick question before I forget — what are you, some kind of bot?",
        "Random thought: who built you in the first place?",
    ]
    for text in embedded:
        result = detect_special_intent(text)
        check(f"triggers embedded: {text!r}", result is not None)

    print("\n== case-insensitivity ==")
    for text in ["WHO ARE YOU", "WhO aRe YoU", "TELL ME ABOUT YOURSELF"]:
        result = detect_special_intent(text)
        check(f"triggers regardless of case: {text!r}", result is not None)

    print("\n== unrelated conversation never triggers ==")
    unrelated = [
        "add a task to call the dentist",
        "what's my schedule today",
        "remind me at 5pm to check the oven",
        "what's the weather in Nellore",
        "who is the CEO of Google",
        "",
        None,
        "   ",
    ]
    for text in unrelated:
        result = detect_special_intent(text)  # type: ignore[arg-type]
        check(f"stays None: {text!r}", result is None)

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
