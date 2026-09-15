"""Serialized fixture desktop worker; no UI Automation calls are registered."""
from __future__ import annotations
import asyncio
from dataclasses import dataclass
class DesktopStateError(RuntimeError):pass
@dataclass(frozen=True,slots=True)
class WindowIdentity: process_id:int; creation_identity:str; handle:str
class DesktopWorker:
 def __init__(self)->None:self._lock=asyncio.Lock();self._paused=False
 def pause(self)->None:self._paused=True
 def resume(self)->None:self._paused=False
 async def inspect_fixture(self,identity:WindowIdentity,*,expected:WindowIdentity)->str:
  async with self._lock:
   if self._paused:raise DesktopStateError('desktop control is paused')
   if identity!=expected:raise DesktopStateError('window/process identity changed')
   await asyncio.sleep(0)
   return f'fixture-window:{identity.handle}'
