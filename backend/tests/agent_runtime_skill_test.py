"""P23 local manifest hash/readiness fixtures."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.skills import SkillRegistry
 r=SkillRegistry(); available=r.discover('fixture',platform='windows',ready_components={'workflow_registry','fixture_adapter'}); absent=r.discover('fixture',platform='windows',ready_components={'workflow_registry'}); manifest=available[0]; changed=False
 try:r.get(manifest.id,'0'*64)
 except ValueError:changed=True
 checks=[('manifest declares reviewed read-only scope',manifest.effect_classes[0].value=='READ_SCOPED'),('only ready skills are discoverable',len(available)==1 and absent==[]),('manifest hash change requires review',changed)]
 for n,ok in checks:print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__':raise SystemExit(main())
