"""P32 held-out reporting fixtures, including a known-bad expected failure."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.evaluation import EvaluationHarness,EvaluationCase,Outcome
 report=EvaluationHarness().report([EvaluationCase('good','workflow',Outcome.PASS,Outcome.PASS),EvaluationCase('known-bad','approval',Outcome.FAIL,Outcome.FAIL),EvaluationCase('not-built','browser',Outcome.UNSUPPORTED,Outcome.UNSUPPORTED)])
 checks=[('known-bad fixture remains a required expected failure',report['all_expectations_met']),('unsupported work remains visible',report['unsupported']==1 and report['total']==3),('supported denominator is explicit',report['supported']==2)]
 for n,x in checks:print(f"  [{'PASS' if x else 'FAIL'}] {n}")
 return 0 if all(x for _,x in checks) else 1
if __name__=='__main__':raise SystemExit(main())
