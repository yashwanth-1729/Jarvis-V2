"""P19 reviewed-workflow boundary tests; no model/provider/tool runs."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.workflows import WorkflowRegistry,WorkflowValidationError
 registry=WorkflowRegistry(); plan=registry.prepare('fixture-inspect','v1',{'query':'status'})
 bad_tool=extra=unsupported=False
 try: registry.prepare('shell-install','v1',{'query':'x'})
 except WorkflowValidationError: unsupported=True
 try: registry.prepare('fixture-inspect','v1',{'query':'x','command':'rm'})
 except WorkflowValidationError: extra=True
 checks=[('workflow has exact criteria',plan['acceptance']['kind']=='non_empty_observation'),('only reviewed tool is allowed',plan['allowed_tools']==['fixture.observe'] and plan['max_repairs']==0),('unsupported workflow is refused',unsupported),('scope-expanding field is refused',extra)]
 for n,ok in checks:print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__':raise SystemExit(main())
