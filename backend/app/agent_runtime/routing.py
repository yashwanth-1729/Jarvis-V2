"""Capability-first model routing and downgrade qualification; no provider calls."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
class Role(str,Enum): ROUTER='router'; SMALL_EXECUTOR='small_executor'; PLANNER='planner'; REVIEWER='reviewer'; VERIFIER='verifier'
@dataclass(frozen=True,slots=True)
class ModelCapability: provider:str; model:str; role:Role; structured_output:bool; max_context:int; enabled:bool=True
@dataclass(frozen=True, slots=True)
class Qualification:
    completed: int
    total: int
    unauthorized_actions: int
    false_successes: int

    def qualifies(self, minimum: float = 0.9) -> bool:
        return (
            self.total > 0
            and self.completed / self.total >= minimum
            and self.unauthorized_actions == 0
            and self.false_successes == 0
        )
class RouteUnavailable(RuntimeError):pass
class ModelRouter:
 def __init__(self,capabilities:list[ModelCapability],qualifications:dict[tuple[str,str,Role],Qualification])->None:self.capabilities=capabilities;self.qualifications=qualifications
 def select(self,role:Role,*,required_context:int,requires_structured:bool=True)->ModelCapability:
  for candidate in self.capabilities:
   q=self.qualifications.get((candidate.provider,candidate.model,role))
   if candidate.role==role and candidate.enabled and candidate.max_context>=required_context and (not requires_structured or candidate.structured_output) and q and q.qualifies():return candidate
  raise RouteUnavailable(f'No qualified {role.value} route for this task; do not silently fall back')
