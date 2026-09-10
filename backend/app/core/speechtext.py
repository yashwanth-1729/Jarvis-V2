"""Prepare reply text for speech synthesis.

The one job here is keeping numbers in English. When the target language is
Telugu, the TTS engine reads a bare numeral in Telugu — measured: the same
sentence renders differently for "7:30 PM" (3.24s) than for "seven thirty PM"
(2.65s) under `te-IN`. Latin-script English *words*, by contrast, are read in
English by the code-mixed model.

The system prompt also asks for English numerals, but a prompt is a request and
this is a guarantee: the user was explicit that times and numbers must never
come out in Telugu, so the digits are rewritten here regardless of what the
model produced.
"""

from __future__ import annotations

import re

_ONES = (
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
)
_TENS = (
    "", "", "twenty", "thirty", "forty", "fifty",
    "sixty", "seventy", "eighty", "ninety",
)
_SCALES = ((1_000_000_000, "billion"), (1_000_000, "million"), (1_000, "thousand"))

_ORDINALS = {
    "1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth",
    "6": "sixth", "7": "seventh", "8": "eighth", "9": "ninth", "10": "tenth",
    "11": "eleventh", "12": "twelfth", "13": "thirteenth", "20": "twentieth",
    "21": "twenty-first", "22": "twenty-second", "23": "twenty-third",
    "30": "thirtieth", "31": "thirty-first",
}


def _under_hundred(value: int) -> str:
    if value < 20:
        return _ONES[value]
    tens, ones = divmod(value, 10)
    return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")


def _under_thousand(value: int) -> str:
    hundreds, rest = divmod(value, 100)
    parts = []
    if hundreds:
        parts.append(f"{_ONES[hundreds]} hundred")
    if rest:
        parts.append(_under_hundred(rest))
    return " ".join(parts)


def int_to_words(value: int) -> str:
    if value < 0:
        return f"minus {int_to_words(-value)}"
    if value < 100:
        return _under_hundred(value)
    if value < 1000:
        return _under_thousand(value)

    for size, name in _SCALES:
        if value >= size:
            count, rest = divmod(value, size)
            words = f"{int_to_words(count)} {name}"
            return f"{words} {int_to_words(rest)}" if rest else words
    return str(value)


def _year_to_words(value: int) -> str:
    """Say a year the way a person does: 2026 -> 'twenty twenty-six'."""
    if not 1100 <= value <= 2099:
        return int_to_words(value)
    high, low = divmod(value, 100)
    if low == 0:
        return f"{_under_hundred(high)} hundred"
    if low < 10:
        return f"{_under_hundred(high)} oh {_ONES[low]}"
    return f"{_under_hundred(high)} {_under_hundred(low)}"


def _time_to_words(match: re.Match[str]) -> str:
    hour, minute = int(match.group(1)), int(match.group(2))
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return match.group(0)

    spoken_hour = _under_hundred(hour)
    if minute == 0:
        return spoken_hour
    if minute < 10:
        return f"{spoken_hour} oh {_ONES[minute]}"
    return f"{spoken_hour} {_under_hundred(minute)}"


def _ordinal_to_words(match: re.Match[str]) -> str:
    digits = match.group(1)
    if digits in _ORDINALS:
        return _ORDINALS[digits]
    value = int(digits)
    return f"{int_to_words(value)}th" if value else match.group(0)


def _number_to_words(match: re.Match[str]) -> str:
    digits = match.group(0)
    value = int(digits)
    # A bare four-digit number in this product is nearly always a year.
    if len(digits) == 4 and 1100 <= value <= 2099:
        return _year_to_words(value)
    return int_to_words(value)


def _decimal_to_words(match: re.Match[str]) -> str:
    whole, fraction = match.group(1), match.group(2)
    spoken = " ".join(_ONES[int(digit)] for digit in fraction)
    return f"{int_to_words(int(whole))} point {spoken}"


def spell_numbers_in_english(text: str) -> str:
    """Rewrite every numeral as English words, leaving all other text alone.

    Applied only when speaking a non-English language — English TTS already
    pronounces digits in English, and spelling them out there would just make
    the audio longer.
    """
    if not text or not any(char.isdigit() for char in text):
        return text

    # Order matters: times and ordinals contain digits that the bare-number
    # rule would otherwise consume first.
    text = re.sub(r"\b(\d{1,2}):(\d{2})\b", _time_to_words, text)
    text = re.sub(r"\b(\d{1,2})(?:st|nd|rd|th)\b", _ordinal_to_words, text)
    text = re.sub(r"\b(\d+)\.(\d+)\b", _decimal_to_words, text)
    text = re.sub(r"\d+", _number_to_words, text)
    return text
