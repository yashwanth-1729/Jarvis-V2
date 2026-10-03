"""The five plans and the features each one unlocks (docs/public-edition.md).

Features are cumulative up the tiers: every plan has everything the plans
below it have, plus its own additions. Prices and allowances are the locked
decisions; ``rpm`` (requests per minute) and ``daily_cap_aura`` are abuse limits,
not product promises, and can be tuned per plan with ``PLAN_OVERRIDES``.

Sizing the abuse limits: one voice minute is 3-4 turns, and each turn is one
STT call, one to three chat rounds and a TTS call per spoken sentence -- about
20-25 gateway requests a minute while someone talks. Side Quest (the first
plan with voice) therefore starts at 60 rpm.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

#: Every feature flag the gateway knows, in tier order. ``chat`` (text chat,
#: tasks, memory...) is on every plan; the rest are what plans add.
FEATURES: tuple[str, ...] = (
    "chat", "voice_en", "lockin", "voice_te", "news", "autonomy", "early_access",
)

FEATURE_NAMES: dict[str, str] = {
    "chat": "Text chat",
    "voice_en": "English voice",
    "lockin": "Lock-in",
    "voice_te": "Telugu voice",
    "news": "News Drops",
    "autonomy": "Autonomous agents",
    "early_access": "Early features",
}


@dataclass(frozen=True)
class Plan:
    id: str
    name: str
    price_inr: int
    monthly_aura: int
    #: Features this plan adds on top of the plans below it.
    adds: tuple[str, ...]
    rpm: int
    daily_cap_aura: int
    rank: int = 0
    #: Everything the plan unlocks, cumulative; filled in by ``PlanCatalog``.
    features: frozenset[str] = field(default_factory=frozenset)

    @property
    def monthly_milli(self) -> int:
        return self.monthly_aura * 1000


DEFAULT_PLANS: tuple[Plan, ...] = (
    Plan("spawn", "Spawn", 0, 50, ("chat",), rpm=30, daily_cap_aura=25),
    Plan("side_quest", "Side Quest", 99, 250, ("voice_en", "lockin"), rpm=60, daily_cap_aura=60),
    Plan("main_character", "Main Character", 299, 750, ("voice_te", "news"), rpm=90, daily_cap_aura=150),
    Plan("final_boss", "Final Boss", 599, 1500, ("autonomy",), rpm=120, daily_cap_aura=300),
    Plan("god_mode", "God Mode", 1999, 5000, ("early_access",), rpm=180, daily_cap_aura=1000),
)

FREE_PLAN = "spawn"

#: Fields PLAN_OVERRIDES may change. Features are not overridable: the tier
#: structure is a product decision, not a deployment knob.
_OVERRIDABLE = {"name", "price_inr", "monthly_aura", "rpm", "daily_cap_aura"}


class PlanCatalog:
    def __init__(self, overrides: dict[str, dict[str, Any]] | None = None) -> None:
        overrides = overrides or {}
        unknown = set(overrides) - {p.id for p in DEFAULT_PLANS}
        if unknown:
            raise ValueError(f"PLAN_OVERRIDES names unknown plans: {sorted(unknown)}")
        plans: list[Plan] = []
        cumulative: set[str] = set()
        for rank, base in enumerate(DEFAULT_PLANS):
            changes = overrides.get(base.id, {})
            bad = set(changes) - _OVERRIDABLE
            if bad:
                raise ValueError(f"PLAN_OVERRIDES[{base.id}] cannot set {sorted(bad)}")
            cumulative |= set(base.adds)
            plans.append(replace(base, **changes, rank=rank, features=frozenset(cumulative)))
        self._plans = {p.id: p for p in plans}
        self.ordered = tuple(plans)

    def get(self, plan_id: str) -> Plan:
        # An account row naming a plan that no longer exists is served as the
        # free plan rather than crashing every request it makes.
        return self._plans.get(plan_id) or self._plans[FREE_PLAN]

    def exists(self, plan_id: str) -> bool:
        return plan_id in self._plans

    def lowest_with(self, feature: str) -> Plan:
        for plan in self.ordered:
            if feature in plan.features:
                return plan
        return self.ordered[-1]
