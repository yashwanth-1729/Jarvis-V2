"""Closed-by-default local API for fixture-safe durable run observation."""
from __future__ import annotations
import json
from typing import Annotated
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from app.agent_runtime.approvals import AuthenticationError, LocalAuthenticator
from app.agent_runtime.contracts import RunRequest
from app.agent_runtime.repository import RequestConflict, RuntimeRepository, TransitionConflict

router = APIRouter(prefix='/api/agent', tags=['agent-runtime'])

class PairIn(BaseModel): secret: str = Field(min_length=1); principal_id: str = Field(min_length=1, max_length=160)
class SessionIn(BaseModel): session_id: str = Field(min_length=8, max_length=160); device_id: str = Field(min_length=1, max_length=160); title: str = ''
class CancelIn(BaseModel): reason: str = Field(default='', max_length=500)

def _auth(request: Request, authorization: Annotated[str | None, Header()] = None) -> str:
    if not authorization or not authorization.startswith('Bearer '): raise HTTPException(401, 'Local pairing token required')
    try: return request.app.state.agent_auth.authenticate(authorization[7:])
    except AuthenticationError as exc: raise HTTPException(401, str(exc)) from exc

async def _owner(request: Request, run_id: str, principal: str) -> None:
    conn=request.app.state.agent_repository.database._connection
    row=await (await conn.execute('''SELECT s.principal_id FROM agent_runs r JOIN runtime_sessions s ON s.id=r.session_id WHERE r.id=?''',(run_id,))).fetchone()
    if row is None: raise HTTPException(404, 'Run not found')
    if row['principal_id'] != principal: raise HTTPException(403, 'Run belongs to another principal')

@router.post('/pair')
async def pair(payload: PairIn, request: Request):
    if not request.app.state.agent_pairing_enabled: raise HTTPException(503, 'Runtime pairing is disabled')
    try: return {'token': request.app.state.agent_auth.pair(payload.secret, principal_id=payload.principal_id)}
    except AuthenticationError as exc: raise HTTPException(401, str(exc)) from exc

@router.post('/sessions')
async def session(payload: SessionIn, request: Request, principal: Annotated[str, Depends(_auth)]):
    await request.app.state.agent_repository.create_session(session_id=payload.session_id,principal_id=principal,device_id=payload.device_id,title=payload.title)
    return {'id':payload.session_id}

@router.post('/runs')
async def submit(payload: RunRequest, request: Request, principal: Annotated[str, Depends(_auth)]):
    conn=request.app.state.agent_repository.database._connection
    owner=await (await conn.execute('SELECT principal_id FROM runtime_sessions WHERE id=?',(payload.session_id,))).fetchone()
    if owner is None or owner['principal_id'] != principal: raise HTTPException(403, 'Session is not owned by this principal')
    try: run,created=await request.app.state.agent_repository.submit_run(payload,policy_snapshot={'api':'fixture-only-v1'},budget_snapshot={'effects':'none'})
    except RequestConflict as exc: raise HTTPException(409,str(exc)) from exc
    return {'run':run,'created':created}

@router.get('/runs/{run_id}')
async def inspect(run_id: str, request: Request, principal: Annotated[str, Depends(_auth)]):
    await _owner(request,run_id,principal); repo:RuntimeRepository=request.app.state.agent_repository
    return {'run':await repo.get_run(run_id),'steps':await repo.list_steps(run_id)}

@router.get('/runs/{run_id}/events')
async def events(run_id: str, request: Request, principal: Annotated[str, Depends(_auth)], after: int = 0):
    if after < 0: raise HTTPException(422,'after must be non-negative')
    await _owner(request,run_id,principal); rows=await request.app.state.agent_repository.list_events(run_id,after=after)
    return {'events':[{**row,'payload':json.loads(row.pop('payload_json'))} for row in rows], 'next_after': rows[-1]['seq'] if rows else after}

@router.post('/runs/{run_id}/cancel')
async def cancel(run_id: str, payload: CancelIn, request: Request, principal: Annotated[str, Depends(_auth)]):
    await _owner(request,run_id,principal)
    try: return {'run':await request.app.state.agent_repository.request_cancel(run_id,reason=payload.reason)}
    except TransitionConflict as exc: raise HTTPException(409,str(exc)) from exc
