"""P17 API auth, idempotency and event replay against a temporary runtime DB."""
from __future__ import annotations
import asyncio, sys, tempfile
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1]; sys.path.insert(0,str(BACKEND_ROOT))
async def main() -> int:
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 from app.api.agent_runs import router
 from app.agent_runtime.approvals import LocalAuthenticator
 from app.agent_runtime.database import RuntimeDatabase
 from app.agent_runtime.repository import RuntimeRepository
 db=RuntimeDatabase(Path(tempfile.mkdtemp())/'runtime.db'); await db.connect()
 app=FastAPI(); app.include_router(router); app.state.agent_pairing_enabled=True; app.state.agent_auth=LocalAuthenticator('fixture-secret'); app.state.agent_repository=RuntimeRepository(db)
 client=TestClient(app); token=client.post('/api/agent/pair',json={'secret':'fixture-secret','principal_id':'owner'}).json()['token']; headers={'Authorization':f'Bearer {token}'}
 unauth=client.post('/api/agent/sessions',json={'session_id':'session-api-0001','device_id':'device'}).status_code==401
 client.post('/api/agent/sessions',headers=headers,json={'session_id':'session-api-0001','device_id':'device'})
 body={'schema_version':1,'client_request_id':'api-client-0001','session_id':'session-api-0001','input':{'text':'fixture'}}
 first=client.post('/api/agent/runs',headers=headers,json=body); second=client.post('/api/agent/runs',headers=headers,json=body); run=first.json()['run']; replay=client.get(f"/api/agent/runs/{run['id']}/events?after=0",headers=headers).json(); cursor=client.get(f"/api/agent/runs/{run['id']}/events?after={replay['next_after']}",headers=headers).json()
 changed=client.post('/api/agent/runs',headers=headers,json={**body,'input':{'text':'changed'}}).status_code==409
 other=client.post('/api/agent/pair',json={'secret':'fixture-secret','principal_id':'other'}).json()['token']; forbidden=client.get(f"/api/agent/runs/{run['id']}",headers={'Authorization':f'Bearer {other}'}).status_code==403
 await db.disconnect(); checks=[('unauthenticated request is rejected',unauth),('duplicate submit does not create another run',first.status_code==200 and second.json()['created'] is False),('event cursor replays then advances',len(replay['events'])==1 and cursor['events']==[]),('changed idempotency request conflicts',changed),('cross-principal inspection is rejected',forbidden)]
 for n,ok in checks: print(f"  [{'PASS' if ok else 'FAIL'}] {n}")
 return 0 if all(ok for _,ok in checks) else 1
if __name__=='__main__': raise SystemExit(asyncio.run(main()))
