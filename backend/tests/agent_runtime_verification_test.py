"""P20 deterministic evidence fixtures, with no model success claim."""
from __future__ import annotations
import asyncio,sys,tempfile
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
async def main()->int:
 from app.agent_runtime.database import RuntimeDatabase
 from app.agent_runtime.repository import RuntimeRepository
 from app.agent_runtime.contracts import RunRequest
 from app.agent_runtime.verification import VerificationService
 db=RuntimeDatabase(Path(tempfile.mkdtemp())/'runtime.db');await db.connect();repo=RuntimeRepository(db);await repo.create_session(session_id='session-verify-01',principal_id='owner',device_id='device');run,_=await repo.submit_run(RunRequest.model_validate({'schema_version':1,'client_request_id':'verify-client-01','session_id':'session-verify-01','input':{'text':'fixture'}}),policy_snapshot={},budget_snapshot={});service=VerificationService(db)
 good=await service.record_evidence(run_id=run['id'],payload={'observation':'real fixture fact'}); passed=await service.verify_non_empty(run_id=run['id'],evidence_id=good['id'],criterion_id='nonempty')
 empty=await service.record_evidence(run_id=run['id'],payload={'model_claim':'completed'}); failed=await service.verify_non_empty(run_id=run['id'],evidence_id=empty['id'],criterion_id='nonempty')
 async with db.transaction() as c:await c.execute("UPDATE evidence_records SET observed_at='2000-01-01T00:00:00Z' WHERE id=?",(good['id'],))
 stale=await service.verify_non_empty(run_id=run['id'],evidence_id=good['id'],criterion_id='fresh',max_age_seconds=1);await db.disconnect();checks=[('independent non-empty evidence passes',passed['result']=='PASSED'),('model claim without observation fails',failed['result']=='FAILED'),('stale evidence cannot pass',stale['result']=='STALE')]
 for n,ok in checks:print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__':raise SystemExit(asyncio.run(main()))
