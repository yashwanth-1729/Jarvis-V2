"""Held-out fixture evaluation reports with explicit denominators."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
class Outcome(str,Enum): PASS='PASS'; FAIL='FAIL'; UNSUPPORTED='UNSUPPORTED'
@dataclass(frozen=True,slots=True)
class EvaluationCase: id:str; family:str; outcome:Outcome; expected:Outcome
class EvaluationHarness:
 def report(self,cases:list[EvaluationCase])->dict[str,object]:
  matched=[c for c in cases if c.outcome==c.expected];supported=[c for c in cases if c.outcome is not Outcome.UNSUPPORTED]
  return {'total':len(cases),'matched':len(matched),'supported':len(supported),'unsupported':len(cases)-len(supported),'all_expectations_met':len(matched)==len(cases),'families':{f:sum(1 for c in cases if c.family==f) for f in {c.family for c in cases}}}
