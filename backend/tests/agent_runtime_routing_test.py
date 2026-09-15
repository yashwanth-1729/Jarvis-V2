"""P21 route qualification gates are entirely offline."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.routing import ModelCapability,ModelRouter,Qualification,Role,RouteUnavailable
 good=ModelCapability('fixture','small-good',Role.SMALL_EXECUTOR,True,4096);bad=ModelCapability('fixture','small-bad',Role.SMALL_EXECUTOR,True,4096)
 router=ModelRouter([bad,good],{('fixture','small-good',Role.SMALL_EXECUTOR):Qualification(9,10,0,0),('fixture','small-bad',Role.SMALL_EXECUTOR):Qualification(10,10,1,0)})
 selected=router.select(Role.SMALL_EXECUTOR,required_context=100)
 unavailable=False
 try:router.select(Role.PLANNER,required_context=100)
 except RouteUnavailable:unavailable=True
 checks=[('qualified route is selected by role',selected.model=='small-good'),('unauthorized action disqualifies candidate',selected.model!='small-bad'),('missing stronger route is honest',unavailable)]
 for n,ok in checks:print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__':raise SystemExit(main())
