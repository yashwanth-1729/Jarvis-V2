"""Deterministic evidence and verification facts; no self-attested success."""
from __future__ import annotations
import hashlib,json,uuid
from datetime import datetime,timezone
from typing import Any
from app.agent_runtime.database import RuntimeDatabase
def _now()->str:return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
class VerificationService:
 def __init__(self,database:RuntimeDatabase)->None:self.database=database
 async def record_evidence(self,*,run_id:str,payload:dict[str,Any],source_kind:str='fixture',step_id:str|None=None)->dict[str,Any]:
  raw=json.dumps(payload,sort_keys=True,separators=(',',':')); evidence_id=f'evidence_{uuid.uuid4().hex}'; stamp=_now()
  async with self.database.transaction() as c: await c.execute('INSERT INTO evidence_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)',(evidence_id,run_id,step_id,source_kind,stamp,hashlib.sha256(raw.encode()).hexdigest(),raw,stamp))
  return await self.get_evidence(evidence_id)
 async def verify_non_empty(self,*,run_id:str,evidence_id:str,criterion_id:str,step_id:str|None=None,max_age_seconds:int=60)->dict[str,Any]:
  e=await self.get_evidence(evidence_id); now=datetime.now(timezone.utc); observed=datetime.fromisoformat(e['observed_at'].replace('Z','+00:00')); payload=json.loads(e['payload_json']); result='STALE' if (now-observed).total_seconds()>max_age_seconds else ('PASSED' if isinstance(payload.get('observation'),str) and payload['observation'].strip() else 'FAILED'); detail='fresh non-empty observation' if result=='PASSED' else ('evidence is stale' if result=='STALE' else 'missing non-empty observation')
  vid=f'verification_{uuid.uuid4().hex}'
  async with self.database.transaction() as c: await c.execute('INSERT INTO verification_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',(vid,run_id,step_id,criterion_id,'non-empty-observation-v1',result,evidence_id,detail,_now()))
  return {'id':vid,'result':result,'detail':detail}
 async def get_evidence(self,evidence_id:str)->dict[str,Any]:
  c=self.database._connection; row=await (await c.execute('SELECT * FROM evidence_records WHERE id=?',(evidence_id,))).fetchone()
  if row is None:raise KeyError(evidence_id)
  return dict(row)
