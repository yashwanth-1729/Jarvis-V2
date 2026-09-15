"""P22 context provenance/compaction fixtures."""
from __future__ import annotations
import sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
def main()->int:
 from app.agent_runtime.context import ContextBuilder,MemorySnippet
 packet=ContextBuilder().build(objective='inspect fixture',run={'id':'run-1','status':'RUNNING','owner_generation':2},steps=[{'id':'step-1','status':'VERIFIED','acceptance_json':'{}'}],evidence_ids=['evidence-1'],memories=[MemorySnippet('deleted','old','explicit',True),MemorySnippet('new','corrected','explicit',False,'deleted'),MemorySnippet('new','duplicate','inferred')],remaining_proposals=1)
 checks=[('deleted memory is never restored',all(m['id']!='deleted' for m in packet['personal_memory'])),('correction provenance is retained',packet['personal_memory'][0]['corrected_by']=='deleted'),('authoritative run/evidence state remains explicit',packet['run']['owner_generation']==2 and packet['evidence_ids']==['evidence-1']),('compaction deduplicates memory by stable id',len(packet['personal_memory'])==1)]
 for n,ok in checks:print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__':raise SystemExit(main())
