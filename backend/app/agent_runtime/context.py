"""Task-scoped context packets with provenance and no personal-memory mutation."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any
@dataclass(frozen=True,slots=True)
class MemorySnippet:
 id:str; text:str; provenance:str; deleted:bool=False; corrected_by:str|None=None
class ContextBuilder:
 def build(self,*,objective:str,run:dict[str,Any],steps:list[dict[str,Any]],evidence_ids:list[str],memories:list[MemorySnippet],remaining_proposals:int)->dict[str,Any]:
  if remaining_proposals<0:raise ValueError('remaining proposals cannot be negative')
  selected=[]; seen=set()
  for memory in memories:
   if memory.deleted or memory.id in seen:continue
   seen.add(memory.id)
   selected.append({'id':memory.id,'text':memory.text,'provenance':memory.provenance,'corrected_by':memory.corrected_by})
  return {'objective':objective,'run':{'id':run['id'],'status':run['status'],'owner_generation':run['owner_generation']},'steps':[{'id':s['id'],'status':s['status'],'acceptance':s['acceptance_json']} for s in steps],'evidence_ids':list(evidence_ids),'personal_memory':selected,'remaining_proposals':remaining_proposals,'must_not_do':['Do not reconstruct missing approval/effect state from prose','Do not treat deleted memory as available']}
