"""Accounts and the Aura ledger.

Lifecycle of one metered call (``proxy.py`` drives it):

1. ``account()`` -- load the user, creating them on first sight (Spawn, a
   one-month period, the plan's Aura granted) and applying any monthly reset
   or plan expiry that is due. Lazy: there is no cron, the next request or
   ``/v1/me`` does it.
2. ``reserve()`` -- refuse with 402 unless the balance covers the reserve and
   with 429 past the plan's daily cap; otherwise put a *hold* on the reserve.
   Holds are not ledger movements; they only lower the available balance, so
   concurrent requests cannot together overspend it.
3. ``settle()`` -- release the hold and spend the real cost (plan bucket first,
   then top-up), writing one usage row and one ``spend`` ledger row.

If the process dies between 2 and 3 the hold would lock that Aura forever, so
holds older than ``RESERVATION_TTL_SECONDS`` are swept: charged at their reserve
(the same rule as a stream that ends with no usage) and released.
"""

from __future__ import annotations

import logging
import uuid
from calendar import monthrange
from dataclasses import dataclass, fields, replace
from datetime import datetime, timedelta
from typing import Any, Callable, Mapping

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.config import Settings
from app.db import Database, accounts, aware, ledger, play_topups, reservations, usage
from app.errors import GatewayError
from app.metering import milli_to_aura
from app.plans import FREE_PLAN, PlanCatalog

logger = logging.getLogger("holo.gateway.accounts")

Clock = Callable[[], datetime]

#: A store expiry within this of "now" is taken as the end of the current
#: period (a monthly subscription). Anything longer gets monthly periods.
_STORE_PERIOD_MAX = timedelta(days=35)

_TIMESTAMPS = (
    "plan_expires_at", "period_start", "period_end", "trial_lockin_started_at",
    "trial_lockin_ends_at", "created_at", "updated_at",
)


def add_months(when: datetime, months: int) -> datetime:
    """Same day-of-month ``months`` later, clamped to the month's last day."""
    index = when.month - 1 + months
    year, month = when.year + index // 12, index % 12 + 1
    return when.replace(year=year, month=month, day=min(when.day, monthrange(year, month)[1]))


@dataclass(frozen=True)
class Account:
    user_id: str
    email: str | None
    plan: str
    plan_source: str
    plan_expires_at: datetime | None
    plan_milli: int
    topup_milli: int
    held_milli: int
    period_start: datetime
    period_end: datetime
    trial_lockin_started_at: datetime | None
    trial_lockin_ends_at: datetime | None
    play_purchase_token: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> "Account":
        values = {f.name: row[f.name] for f in fields(cls)}
        for name in _TIMESTAMPS:
            values[name] = aware(values[name])
        return cls(**values)

    @property
    def balance_milli(self) -> int:
        """What a new request can use: both buckets minus open holds."""
        return self.plan_milli + self.topup_milli - self.held_milli

    def lockin_trial_active(self, now: datetime) -> bool:
        return self.trial_lockin_ends_at is not None and now < self.trial_lockin_ends_at


@dataclass(frozen=True)
class Reservation:
    id: str
    user_id: str
    endpoint: str
    model: str
    amount_milli: int
    created_at: datetime


def split_spend(plan_milli: int, topup_milli: int, cost: int) -> tuple[int, int]:
    """How much of ``cost`` comes from each bucket: plan Aura first (it expires
    at the period end anyway), then top-up. A cost larger than both lands on
    the plan bucket as a small negative balance -- bounded by one request's
    overrun, since the next reserve then fails -- and is written off at the
    next reset rather than eating into a future top-up."""
    from_plan = min(max(plan_milli, 0), cost)
    from_topup = min(max(topup_milli, 0), cost - from_plan)
    return from_plan + (cost - from_plan - from_topup), from_topup


class AuraBank:
    def __init__(
        self, db: Database, settings: Settings, plans: PlanCatalog, clock: Clock,
    ) -> None:
        self.db = db
        self.settings = settings
        self.plans = plans
        self.clock = clock

    # ------------------------------------------------------------------
    # Accounts
    # ------------------------------------------------------------------

    async def account(self, user_id: str, *, email: str | None = None) -> Account:
        """The user's account, created on first sight and brought up to date.

        The common case is one plain read. A write transaction is only taken
        for a brand-new user or when a reset/expiry is due.
        """
        now = self.clock()
        acct = await self._read(user_id)
        if acct is None:
            try:
                async with self.db.tx() as conn:
                    return await self._create(conn, user_id, email, now)
            except IntegrityError:
                # A concurrent first request created it; use that one.
                acct = await self._read(user_id)
                assert acct is not None
        if self._due(acct, now) is None:
            return acct
        async with self.db.tx() as conn:
            return await self._refresh(conn, await self._lock(conn, user_id), now)

    async def spent_today(self, user_id: str) -> int:
        async with self.db.read() as conn:
            return await self._spent_today(conn, user_id, self.clock())

    async def _read(self, user_id: str) -> Account | None:
        async with self.db.read() as conn:
            row = (await conn.execute(
                select(accounts).where(accounts.c.user_id == user_id)
            )).mappings().first()
        return Account.from_row(row) if row else None

    async def _lock(self, conn: AsyncConnection, user_id: str) -> Account:
        # FOR UPDATE serializes this user's balance changes on Postgres; the
        # SQLite dialect drops the clause (Database.tx() locks there instead).
        row = (await conn.execute(
            select(accounts).where(accounts.c.user_id == user_id).with_for_update()
        )).mappings().first()
        if row is None:
            raise LookupError(f"no account {user_id}")
        return Account.from_row(row)

    async def _create(
        self, conn: AsyncConnection, user_id: str, email: str | None, now: datetime,
    ) -> Account:
        values: dict[str, Any] = dict(
            user_id=user_id, email=email, plan=FREE_PLAN, plan_source="default",
            plan_expires_at=None, plan_milli=0, topup_milli=0, held_milli=0,
            period_start=now, period_end=add_months(now, 1),
            trial_lockin_started_at=None, trial_lockin_ends_at=None,
            play_purchase_token=None, created_at=now, updated_at=now,
        )
        await conn.execute(insert(accounts).values(**values))
        logger.info("account created: %s", user_id)
        acct = Account(**values)
        allowance = self.plans.get(FREE_PLAN).monthly_milli
        return await self._move(
            conn, acct, "grant", allowance, 0, now=now, note="new account: Spawn plan Aura",
        )

    # ------------------------------------------------------------------
    # Periods: monthly reset and plan expiry
    # ------------------------------------------------------------------

    def _due(self, acct: Account, now: datetime) -> str | None:
        paid = acct.plan != FREE_PLAN and acct.plan_expires_at is not None
        grace = timedelta(minutes=self.settings.plan_expiry_grace_minutes)
        if paid and now >= acct.plan_expires_at + grace:
            return "expire"
        if now >= acct.period_end:
            if paid and acct.period_end >= acct.plan_expires_at:
                # The period ran to the store expiry: hold the balance as it
                # is while the renewal notification is (briefly) in flight.
                return None
            return "reset"
        return None

    async def _refresh(self, conn: AsyncConnection, acct: Account, now: datetime) -> Account:
        due = self._due(acct, now)
        if due == "expire":
            logger.info("plan %s ended for %s; back to Spawn", acct.plan, acct.user_id)
            return await self._start_period(
                conn, acct, now, plan=FREE_PLAN, start=now, end=add_months(now, 1),
                note=f"{acct.plan} ended: back to Spawn",
                plan_source="default", plan_expires_at=None, play_purchase_token=None,
            )
        if due == "reset":
            start, end = acct.period_start, acct.period_end
            while end <= now:  # catch up however many months were skipped
                start, end = end, add_months(end, 1)
            if acct.plan != FREE_PLAN and acct.plan_expires_at is not None:
                end = min(end, acct.plan_expires_at)
            return await self._start_period(
                conn, acct, now, plan=acct.plan, start=start, end=end,
                note="monthly reset: plan Aura refilled",
            )
        return acct

    async def _start_period(
        self, conn: AsyncConnection, acct: Account, now: datetime, *, plan: str,
        start: datetime, end: datetime, note: str, ref: str | None = None,
        **changes: Any,
    ) -> Account:
        """Begin a period on ``plan`` and reset the plan bucket to its allowance.

        Plan Aura does not roll over, so whatever was left (or overdrawn) is
        zeroed with an ``adjust`` row before the ``grant`` -- two rows, so the
        ledger shows exactly what expired and what was given."""
        values = dict(plan=plan, period_start=start, period_end=end, updated_at=now, **changes)
        await conn.execute(
            update(accounts).where(accounts.c.user_id == acct.user_id).values(**values)
        )
        acct = replace(acct, **values)
        if acct.plan_milli:
            acct = await self._move(
                conn, acct, "adjust", -acct.plan_milli, 0, now=now, ref=ref,
                note=(
                    "unspent plan Aura expired" if acct.plan_milli > 0
                    else "overrun beyond the balance written off"
                ),
            )
        allowance = self.plans.get(plan).monthly_milli
        if allowance:
            acct = await self._move(conn, acct, "grant", allowance, 0, now=now, ref=ref, note=note)
        return acct

    def _store_period_end(self, now: datetime, expires_at: datetime | None) -> datetime:
        if expires_at is not None and now < expires_at <= now + _STORE_PERIOD_MAX:
            return expires_at
        return add_months(now, 1)

    async def set_plan(
        self, user_id: str, plan: str, *, source: str, note: str,
        expires_at: datetime | None = None, purchase_token: str | None = None,
        ref: str | None = None,
    ) -> Account:
        """Put the user on ``plan`` from now: a fresh period and a full plan
        bucket. Used for purchases, renewals, upgrades, downgrades and admin
        grants alike -- a renewal *is* a new period."""
        if not self.plans.exists(plan):
            raise ValueError(f"unknown plan {plan!r}")
        await self.account(user_id)
        now = self.clock()
        async with self.db.tx() as conn:
            acct = await self._lock(conn, user_id)
            return await self._start_period(
                conn, acct, now, plan=plan, start=now,
                end=self._store_period_end(now, expires_at), note=note, ref=ref,
                plan_source=source if plan != FREE_PLAN else "default",
                plan_expires_at=expires_at if plan != FREE_PLAN else None,
                play_purchase_token=purchase_token,
            )

    async def extend_plan(self, user_id: str, expires_at: datetime | None) -> Account:
        """Move a paid plan's end date without starting a new period (a
        cancellation that keeps access until expiry, a grace-period update)."""
        now = self.clock()
        async with self.db.tx() as conn:
            acct = await self._lock(conn, user_id)
            await conn.execute(
                update(accounts).where(accounts.c.user_id == user_id)
                .values(plan_expires_at=expires_at, updated_at=now)
            )
            return replace(acct, plan_expires_at=expires_at, updated_at=now)

    async def add_aura(
        self, user_id: str, milli: int, *, kind: str = "topup", note: str,
        ref: str | None = None,
    ) -> Account:
        """Credit (or with ``adjust``, debit) the top-up bucket, which persists."""
        if kind not in ("topup", "refund", "adjust"):
            raise ValueError(kind)
        await self.account(user_id)
        now = self.clock()
        async with self.db.tx() as conn:
            acct = await self._lock(conn, user_id)
            return await self._move(conn, acct, kind, 0, milli, now=now, note=note, ref=ref)

    async def credit_purchase_once(
        self, user_id: str, purchase_token: str, product_id: str, aura: int,
    ) -> bool:
        """Credit a consumable Play purchase to the top-up bucket exactly once
        per purchase token. The dedupe row and the credit share one
        transaction, so a crash cannot leave one without the other. Returns
        False for a token already credited."""
        await self.account(user_id)
        now = self.clock()
        try:
            async with self.db.tx() as conn:
                await conn.execute(insert(play_topups).values(
                    purchase_token=purchase_token, user_id=user_id, product_id=product_id,
                    aura=aura, created_at=now,
                ))
                acct = await self._lock(conn, user_id)
                await self._move(
                    conn, acct, "topup", 0, aura * 1000, now=now, ref=purchase_token,
                    note=f"Play top-up {product_id}",
                )
        except IntegrityError:
            return False
        return True

    async def start_lockin_trial(self, user_id: str) -> tuple[Account, bool]:
        """Start the Lock-in trial. Once per account, ever: returns
        ``(account, False)`` if it was already used."""
        await self.account(user_id)
        now = self.clock()
        async with self.db.tx() as conn:
            acct = await self._lock(conn, user_id)
            if acct.trial_lockin_started_at is not None:
                return acct, False
            ends = now + timedelta(days=self.settings.trial_lockin_days)
            await conn.execute(
                update(accounts).where(accounts.c.user_id == user_id).values(
                    trial_lockin_started_at=now, trial_lockin_ends_at=ends, updated_at=now,
                )
            )
            return replace(acct, trial_lockin_started_at=now, trial_lockin_ends_at=ends), True

    # ------------------------------------------------------------------
    # Reserve and settle
    # ------------------------------------------------------------------

    async def reserve(
        self, user_id: str, endpoint: str, model: str, amount_milli: int,
    ) -> Reservation:
        now = self.clock()
        refusal: GatewayError | None = None
        reservation: Reservation | None = None
        async with self.db.tx() as conn:
            acct = await self._lock(conn, user_id)
            acct = await self._refresh(conn, acct, now)
            acct = await self._sweep_user(conn, acct, now)
            plan = self.plans.get(acct.plan)
            if acct.balance_milli < amount_milli:
                refusal = self._insufficient(acct, amount_milli)
            else:
                spent = await self._spent_today(conn, user_id, now)
                cap = plan.daily_cap_aura * 1000
                if spent + acct.held_milli + amount_milli > cap:
                    refusal = self._daily_cap(acct, spent, cap, now)
                else:
                    reservation = Reservation(
                        uuid.uuid4().hex, user_id, endpoint, model, amount_milli, now,
                    )
                    await conn.execute(insert(reservations).values(
                        id=reservation.id, user_id=user_id, endpoint=endpoint, model=model,
                        amount_milli=amount_milli, created_at=now,
                    ))
                    await conn.execute(
                        update(accounts).where(accounts.c.user_id == user_id)
                        .values(held_milli=acct.held_milli + amount_milli, updated_at=now)
                    )
        # Raised after the transaction commits, so a reset applied on the way
        # in is kept and the refusal reports the up-to-date balance.
        if refusal is not None:
            raise refusal
        assert reservation is not None
        return reservation

    async def settle(
        self, reservation: Reservation, milli: int, record: dict[str, Any],
    ) -> int:
        """Release the hold, spend ``milli`` and write the usage row. Returns
        the usage row id."""
        now = self.clock()
        async with self.db.tx() as conn:
            acct = await self._lock(conn, reservation.user_id)
            released = (await conn.execute(
                delete(reservations).where(reservations.c.id == reservation.id)
            )).rowcount
            if released:
                acct = replace(acct, held_milli=max(acct.held_milli - reservation.amount_milli, 0))
                await conn.execute(
                    update(accounts).where(accounts.c.user_id == acct.user_id)
                    .values(held_milli=acct.held_milli, updated_at=now)
                )
            else:
                # The stale-hold sweep got here first and already charged the
                # reserve; only the excess over it is still owed.
                milli = max(milli - reservation.amount_milli, 0)
            usage_id = await self._record_usage(conn, reservation, milli, record, now)
            if milli > 0:
                from_plan, from_topup = split_spend(acct.plan_milli, acct.topup_milli, milli)
                await self._move(
                    conn, acct, "spend", -from_plan, -from_topup, now=now, usage_id=usage_id,
                    note=f"{reservation.endpoint} {reservation.model}",
                )
        return usage_id

    async def sweep_stale(self) -> int:
        """Charge and release every expired hold (called at startup)."""
        now = self.clock()
        cutoff = now - timedelta(seconds=self.settings.reservation_ttl_seconds)
        async with self.db.read() as conn:
            users = (await conn.execute(
                select(reservations.c.user_id).where(reservations.c.created_at < cutoff).distinct()
            )).scalars().all()
        for user_id in users:
            async with self.db.tx() as conn:
                await self._sweep_user(conn, await self._lock(conn, user_id), now)
        return len(users)

    async def _sweep_user(self, conn: AsyncConnection, acct: Account, now: datetime) -> Account:
        cutoff = now - timedelta(seconds=self.settings.reservation_ttl_seconds)
        stale = (await conn.execute(
            select(reservations).where(
                reservations.c.user_id == acct.user_id, reservations.c.created_at < cutoff,
            )
        )).mappings().all()
        for row in stale:
            hold = Reservation(
                row["id"], row["user_id"], row["endpoint"], row["model"],
                row["amount_milli"], aware(row["created_at"]),
            )
            logger.warning("charging stale hold %s for %s at its reserve", hold.id, acct.user_id)
            await conn.execute(delete(reservations).where(reservations.c.id == hold.id))
            acct = replace(acct, held_milli=max(acct.held_milli - hold.amount_milli, 0))
            await conn.execute(
                update(accounts).where(accounts.c.user_id == acct.user_id)
                .values(held_milli=acct.held_milli, updated_at=now)
            )
            usage_id = await self._record_usage(
                conn, hold, hold.amount_milli, {"status": "stale_hold"}, now,
            )
            from_plan, from_topup = split_spend(acct.plan_milli, acct.topup_milli, hold.amount_milli)
            acct = await self._move(
                conn, acct, "spend", -from_plan, -from_topup, now=now, usage_id=usage_id,
                note="unsettled request charged at its reserve",
            )
        return acct

    # ------------------------------------------------------------------
    # Rows
    # ------------------------------------------------------------------

    async def _move(
        self, conn: AsyncConnection, acct: Account, kind: str, plan_delta: int,
        topup_delta: int, *, now: datetime, note: str | None = None,
        ref: str | None = None, usage_id: int | None = None,
    ) -> Account:
        """Apply one balance movement and append its ledger row."""
        plan_after = acct.plan_milli + plan_delta
        topup_after = acct.topup_milli + topup_delta
        await conn.execute(
            update(accounts).where(accounts.c.user_id == acct.user_id)
            .values(plan_milli=plan_after, topup_milli=topup_after, updated_at=now)
        )
        await conn.execute(insert(ledger).values(
            user_id=acct.user_id, kind=kind, plan_delta_milli=plan_delta,
            topup_delta_milli=topup_delta, plan_after_milli=plan_after,
            topup_after_milli=topup_after, usage_id=usage_id, ref=ref, note=note,
            created_at=now,
        ))
        return replace(acct, plan_milli=plan_after, topup_milli=topup_after, updated_at=now)

    async def _record_usage(
        self, conn: AsyncConnection, reservation: Reservation, milli: int,
        record: dict[str, Any], now: datetime,
    ) -> int:
        result = await conn.execute(insert(usage).values(
            user_id=reservation.user_id, endpoint=reservation.endpoint,
            model=reservation.model, milli_aura=milli,
            reserve_milli=reservation.amount_milli, created_at=now,
            **{"streamed": False, **record},
        ))
        return int(result.inserted_primary_key[0])

    async def _spent_today(self, conn: AsyncConnection, user_id: str, now: datetime) -> int:
        start = self._day_start(now)
        total = (await conn.execute(
            select(func.coalesce(func.sum(usage.c.milli_aura), 0))
            .where(usage.c.user_id == user_id, usage.c.created_at >= start)
        )).scalar_one()
        return int(total)

    def _day_start(self, now: datetime) -> datetime:
        offset = timedelta(minutes=self.settings.daily_cap_utc_offset_minutes)
        local = now + offset
        return local.replace(hour=0, minute=0, second=0, microsecond=0) - offset

    # ------------------------------------------------------------------
    # Refusals the app shows
    # ------------------------------------------------------------------

    def _insufficient(self, acct: Account, needed: int) -> GatewayError:
        balance = max(acct.balance_milli, 0)
        top = acct.plan == self.plans.ordered[-1].id
        return GatewayError(
            402, "insufficient_aura",
            f"Not enough Aura: this needs about {milli_to_aura(needed):g} and you have "
            f"{milli_to_aura(balance):g}. Top up"
            f"{'' if top else ', upgrade'} or wait for your plan Aura to refill on "
            f"{acct.period_end:%d %b}.",
            aura_balance=milli_to_aura(balance), aura_required=milli_to_aura(needed),
            plan=acct.plan, refills_at=acct.period_end.isoformat(),
            upgrade_available=not top,
        )

    def _daily_cap(self, acct: Account, spent: int, cap: int, now: datetime) -> GatewayError:
        resets = self._day_start(now) + timedelta(days=1)
        return GatewayError(
            429, "daily_cap_reached",
            f"Daily limit reached: {milli_to_aura(spent):g} of {milli_to_aura(cap):g} Aura "
            "used today. It resets at midnight.",
            headers={"Retry-After": str(max(int((resets - now).total_seconds()), 1))},
            plan=acct.plan, daily_cap_aura=milli_to_aura(cap),
            spent_today_aura=milli_to_aura(spent), resets_at=resets.isoformat(),
        )
