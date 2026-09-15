"""P33 feature flags preserve safe inspection/cancellation under rollback."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.release import RuntimeReleaseFlags
 flags=RuntimeReleaseFlags();enabled=RuntimeReleaseFlags(admit_new_runs=True)
 checks=[('unfinished runtime paths default off',not any([flags.admit_new_runs,flags.domain_writes,flags.sensitive_effects,flags.background_jobs,flags.persistent_browser_profiles,flags.parallel_runs,flags.android_execution])),('rollback keeps inspect/cancel possible',flags.may_inspect_or_cancel() and not flags.can_admit()),('admission is explicit',enabled.can_admit())]
 for n,x in checks:print(f"  [{'PASS' if x else 'FAIL'}] {n}")
 return 0 if all(x for _,x in checks) else 1
if __name__=='__main__':raise SystemExit(main())
