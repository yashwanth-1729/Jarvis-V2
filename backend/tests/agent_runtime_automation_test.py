"""P24/P25 fixture observation and serialized desktop worker checks."""
from __future__ import annotations
import asyncio,sys
from pathlib import Path
BACKEND_ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(BACKEND_ROOT))
async def main()->int:
 from app.agent_runtime.browser import BrowserRegistry,ProfileMode,BrowserStateError
 from app.agent_runtime.desktop import DesktopWorker,WindowIdentity,DesktopStateError
 b=BrowserRegistry();obs=b.observe(profile_id='fixture-profile',mode=ProfileMode.EPHEMERAL_FIXTURE,tab_id='tab-1',url='https://fixture.invalid',elements=['link-1']);b.require_fresh_target(obs,'link-1');stale=False;default=False
 b.observe(profile_id='fixture-profile',mode=ProfileMode.EPHEMERAL_FIXTURE,tab_id='tab-1',url='https://fixture.invalid/next',elements=['link-2'])
 try:b.require_fresh_target(obs,'link-1')
 except BrowserStateError:stale=True
 try:b.observe(profile_id='default',mode=ProfileMode.DEDICATED,tab_id='x',url='x',elements=[])
 except BrowserStateError:default=True
 w=DesktopWorker();ident=WindowIdentity(1,'pid:created','fixture');ok=await w.inspect_fixture(ident,expected=ident);w.pause();paused=False
 try:await w.inspect_fixture(ident,expected=ident)
 except DesktopStateError:paused=True
 checks=[('fresh named-profile target is accepted',ok.endswith('fixture')),('stale browser target is rejected',stale),('default profile is forbidden',default),('paused desktop worker performs no action',paused)]
 for n,x in checks:print(f"  [{'PASS' if x else 'FAIL'}] {n}")
 return 0 if all(x for _,x in checks) else 1
if __name__=='__main__':raise SystemExit(asyncio.run(main()))
