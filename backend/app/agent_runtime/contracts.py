"""Strict, host-owned contracts for the future durable agent runtime.

These models describe untrusted client/model input and host-issued receipts.
They intentionally contain no writable approval, verification or run-status
claims from a model. Storage, leasing and worker execution arrive in later
packets after these boundaries have tests.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr


SCHEMA_VERSION = 1


class _StrictModel(BaseModel):
    # JSON transports naturally represent string enums as strings. Individual
    # identity/text fields remain Strict*, while enums validate only declared
    # values and unknown fields are never silently accepted.
    model_config = ConfigDict(extra="forbid")


class RequestedMode(str, Enum):
    DRAFT_ONLY = "draft_only"
    INTERACTIVE = "interactive"


class ExecutionPolicy(str, Enum):
    FOREGROUND = "foreground"
    CONTINUE_WITHOUT_UI = "continue_without_ui"


class BudgetProfile(str, Enum):
    CONSERVATIVE = "conservative"
    STANDARD = "standard"


class RunInput(_StrictModel):
    text: StrictStr = Field(min_length=1, max_length=20_000)
    language: StrictStr | None = Field(default=None, min_length=2, max_length=35)


class RunRequest(_StrictModel):
    """Client preference for one idempotent durable job submission."""

    schema_version: Literal[SCHEMA_VERSION]
    client_request_id: StrictStr = Field(min_length=8, max_length=160)
    session_id: StrictStr = Field(min_length=8, max_length=160)
    input: RunInput
    requested_mode: RequestedMode = RequestedMode.INTERACTIVE
    execution_policy: ExecutionPolicy = ExecutionPolicy.FOREGROUND
    artifact_ids: list[StrictStr] = Field(default_factory=list, max_length=100)
    budget_profile: BudgetProfile = BudgetProfile.STANDARD


class ToolProposal(_StrictModel):
    kind: Literal["tool"]
    step_id: StrictStr = Field(min_length=8, max_length=160)
    tool_name: StrictStr = Field(min_length=1, max_length=160)
    arguments: dict[str, Any] = Field(default_factory=dict)
    purpose: StrictStr = Field(min_length=1, max_length=1_000)
    expected_observation: StrictStr = Field(min_length=1, max_length=1_000)


class AskUserProposal(_StrictModel):
    kind: Literal["ask_user"]
    step_id: StrictStr = Field(min_length=8, max_length=160)
    question: StrictStr = Field(min_length=1, max_length=2_000)


class CompletionProposal(_StrictModel):
    kind: Literal["propose_completion"]
    step_id: StrictStr = Field(min_length=8, max_length=160)
    summary: StrictStr = Field(min_length=1, max_length=4_000)


class BlockedProposal(_StrictModel):
    kind: Literal["report_blocked"]
    step_id: StrictStr = Field(min_length=8, max_length=160)
    reason: StrictStr = Field(min_length=1, max_length=2_000)


ActionProposal = Annotated[
    ToolProposal | AskUserProposal | CompletionProposal | BlockedProposal,
    Field(discriminator="kind"),
]


class EffectState(str, Enum):
    NONE = "none"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    UNCERTAIN = "uncertain"


class ReceiptStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EffectClass(str, Enum):
    """Host-classified outcome risk; never an authority claim from a model."""

    READ_SCOPED = "READ_SCOPED"
    WRITE_DRAFT = "WRITE_DRAFT"
    WRITE_PERSONAL = "WRITE_PERSONAL"
    MODIFY_EXISTING = "MODIFY_EXISTING"
    EXTERNAL_COMMIT = "EXTERNAL_COMMIT"
    DESTRUCTIVE = "DESTRUCTIVE"
    PRIVILEGE_CHANGE = "PRIVILEGE_CHANGE"


class ApprovalDecision(str, Enum):
    GRANT = "grant"
    DENY = "deny"


class ApprovalRequest(_StrictModel):
    """Host-built exact effect displayed to a human before dispatch."""

    schema_version: Literal[SCHEMA_VERSION]
    operation_id: StrictStr = Field(min_length=8, max_length=160)
    tool_name: StrictStr = Field(min_length=1, max_length=160)
    tool_version: StrictStr = Field(min_length=1, max_length=80)
    effect_class: EffectClass
    scope: dict[str, Any] = Field(default_factory=dict)
    target: dict[str, Any] = Field(default_factory=dict)
    content_hash: StrictStr = Field(min_length=16, max_length=128)
    preconditions: dict[str, Any] = Field(default_factory=dict)
    summary: StrictStr = Field(min_length=1, max_length=2_000)


class ApprovalDecisionRequest(_StrictModel):
    """Authenticated human decision; no model-supplied confirmation field exists."""

    decision: ApprovalDecision


class ToolReceipt(_StrictModel):
    """Host-issued execution fact; distinct from a model's narrative claim."""

    schema_version: Literal[SCHEMA_VERSION]
    operation_id: StrictStr = Field(min_length=8, max_length=160)
    attempt_id: StrictStr = Field(min_length=8, max_length=160)
    status: ReceiptStatus
    effect_state: EffectState
    data: dict[str, Any] = Field(default_factory=dict)
    error: StrictStr | None = Field(default=None, max_length=4_000)
    evidence_ids: list[StrictStr] = Field(default_factory=list, max_length=100)
    artifact_ids: list[StrictStr] = Field(default_factory=list, max_length=100)
    started_at: StrictStr = Field(min_length=20, max_length=40)
    finished_at: StrictStr = Field(min_length=20, max_length=40)
