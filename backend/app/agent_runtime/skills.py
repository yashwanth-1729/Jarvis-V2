"""Reviewed local skill manifests; no remote discovery or executable loading."""
from __future__ import annotations
import hashlib,json
from dataclasses import dataclass,asdict
from app.agent_runtime.contracts import EffectClass
@dataclass(frozen=True,slots=True)
class SkillManifest:
 id:str; version:str; purpose:str; workflow_name:str; workflow_version:str; effect_classes:tuple[EffectClass,...]; platforms:tuple[str,...]; required_components:tuple[str,...]
 def digest(self)->str:return hashlib.sha256(json.dumps(asdict(self),default=lambda x:x.value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
class SkillRegistry:
 def __init__(self,manifests:list[SkillManifest]|None=None)->None:
  self._skills={m.id:m for m in (manifests or [SkillManifest('fixture-inspect','1','Inspect an approved fixture','fixture-inspect','v1',(EffectClass.READ_SCOPED,),('windows','linux','darwin'),('workflow_registry','fixture_adapter'))])}
 def discover(self,query:str,*,platform:str,ready_components:set[str])->list[SkillManifest]:
  q=query.lower();return [m for m in self._skills.values() if (q in m.id or q in m.purpose.lower()) and platform in m.platforms and set(m.required_components)<=ready_components]
 def get(self,skill_id:str,expected_hash:str)->SkillManifest:
  m=self._skills[skill_id]
  if m.digest()!=expected_hash:raise ValueError('skill manifest changed; re-review required')
  return m
