"""P16 outbox acknowledgements use isolated runtime databases only."""
from __future__ import annotations
import asyncio, sys, tempfile
from pathlib import Path
BACKEND_ROOT = Path(__file__).resolve().parents[1]; sys.path.insert(0, str(BACKEND_ROOT))
async def main() -> int:
 from app.agent_runtime.database import RuntimeDatabase
 from app.agent_runtime.repository import RuntimeRepository
 from app.agent_runtime.contracts import RunRequest
 from app.agent_runtime.domain_commands import DomainCommandService
 db=RuntimeDatabase(Path(tempfile.mkdtemp())/'runtime.db'); await db.connect(); repo=RuntimeRepository(db)
 await repo.create_session(session_id='session-domain-01',principal_id='owner',device_id='device')
 run,_=await repo.submit_run(RunRequest.model_validate({'schema_version':1,'client_request_id':'domain-client-01','session_id':'session-domain-01','input':{'text':'fixture'}}),policy_snapshot={},budget_snapshot={})
 service=DomainCommandService(db); first=await service.enqueue(operation_id='operation-domain-01',run_id=run['id'],destination_owner='CLIENT',command={'kind':'fixture'})
 duplicate=await service.enqueue(operation_id='operation-domain-01',run_id=run['id'],destination_owner='CLIENT',command={'kind':'fixture'})
 pending=await service.pending_for_owner('CLIENT'); applied=await service.acknowledge('operation-domain-01',status='APPLIED',result={'uid':'fixture-1','revision':'1'})
 again=await service.acknowledge('operation-domain-01',status='APPLIED',result={'uid':'other'})
 conflict=False
 try: await service.enqueue(operation_id='operation-domain-01',run_id=run['id'],destination_owner='CLIENT',command={'kind':'different'})
 except ValueError: conflict=True
 await db.disconnect(); checks=[('idempotent enqueue returns one durable command',first['operation_id']==duplicate['operation_id'] and len(pending)==1),('owner acknowledgement is durable',applied['status']=='APPLIED'),('duplicate acknowledgement does not reapply',again['result_json']==applied['result_json']),('changed duplicate operation is rejected',conflict)]
 for n,ok in checks: print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 print(f'{sum(ok for _,ok in checks)}/{len(checks)} checks passed'); return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__': raise SystemExit(asyncio.run(main()))
