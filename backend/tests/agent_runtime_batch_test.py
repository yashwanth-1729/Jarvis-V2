"""P27–P31 fixture-only boundaries; no existing platform runtime invoked."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.scheduler import RuntimeScheduler
 from app.agent_runtime.voice_bridge import submitted_ack
 from app.agent_runtime.device import capabilities
 from app.agent_runtime.children import ChildRunBudget,ChildRunError
 from app.agent_runtime.telemetry import Telemetry
 s=RuntimeScheduler();unique=s.admit('s1','2026-09-15T10:00') and not s.admit('s1','2026-09-15T10:00');ack=submitted_ack('run-1','te-IN');android=capabilities('android');budget=ChildRunBudget(1);budget.admit_readonly();exhausted=False
 try:budget.admit_readonly()
 except ChildRunError:exhausted=True
 t=Telemetry(2);t.emit('fixture','token sk_abcdefghijklmnop');t.emit('fixture','next')
 checks=[('scheduled occurrence is unique',unique),('voice acknowledgement preserves language',ack.language=='te-IN'),('Android declares no background/desktop capability',not android.background_runtime and not android.desktop_control),('child budget blocks excess delegation',exhausted),('telemetry is bounded and redacted',len(t.events)==2 and '[REDACTED]' in t.events[0]['detail'])]
 for n,x in checks:print(f"  [{'PASS' if x else 'FAIL'}] {n}")
 return 0 if all(x for _,x in checks) else 1
if __name__=='__main__':raise SystemExit(main())
