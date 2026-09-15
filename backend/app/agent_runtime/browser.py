"""Fixture-only browser profile/tab observation identities; no browser launch."""
from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
class ProfileMode(str,Enum): EPHEMERAL_FIXTURE='ephemeral_fixture'; DEDICATED='dedicated'; EXISTING_ATTACHMENT='existing_attachment'
class BrowserStateError(RuntimeError):pass
@dataclass(frozen=True,slots=True)
class TabObservation: profile_id:str; tab_id:str; generation:int; url:str; elements:tuple[str,...]
class BrowserRegistry:
 def __init__(self)->None:self._tabs:dict[tuple[str,str],TabObservation]={}
 def observe(self,*,profile_id:str,mode:ProfileMode,tab_id:str,url:str,elements:list[str])->TabObservation:
  if mode is ProfileMode.EXISTING_ATTACHMENT:raise BrowserStateError('existing-session attachment is not implemented')
  if profile_id.lower() in {'default','chrome-default','user-default'}:raise BrowserStateError('default browser profile is forbidden')
  old=self._tabs.get((profile_id,tab_id));obs=TabObservation(profile_id,tab_id,(old.generation+1 if old else 1),url,tuple(elements));self._tabs[(profile_id,tab_id)]=obs;return obs
 def require_fresh_target(self,observation:TabObservation,element_id:str)->None:
  current=self._tabs.get((observation.profile_id,observation.tab_id))
  if current is None or current.generation!=observation.generation:raise BrowserStateError('stale browser observation')
  if element_id not in current.elements:raise BrowserStateError('target is missing or ambiguous')
