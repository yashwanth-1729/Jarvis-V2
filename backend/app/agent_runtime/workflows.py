"""Reviewed, host-owned workflow definitions; never executable model plans."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any

class WorkflowValidationError(ValueError): pass

@dataclass(frozen=True, slots=True)
class WorkflowSpec:
    name: str; version: str; allowed_tools: tuple[str, ...]; max_repairs: int
    def validate(self, inputs: dict[str, Any]) -> dict[str, str]: raise NotImplementedError
    def acceptance(self, inputs: dict[str, str]) -> dict[str, Any]: raise NotImplementedError

class FixtureInspectWorkflow(WorkflowSpec):
    def __init__(self) -> None: super().__init__('fixture-inspect','v1',('fixture.observe',),0)
    def validate(self, inputs: dict[str, Any]) -> dict[str, str]:
        query=inputs.get('query')
        if not isinstance(query,str) or not query.strip() or len(query)>500: raise WorkflowValidationError('query must be a non-empty string up to 500 characters')
        if set(inputs)!={'query'}: raise WorkflowValidationError('workflow input has unsupported fields')
        return {'query':query.strip()}
    def acceptance(self, inputs: dict[str,str]) -> dict[str,Any]: return {'kind':'non_empty_observation','query':inputs['query'],'verifier':'fixture-observation-v1'}

class WorkflowRegistry:
    def __init__(self) -> None: self._workflows={("fixture-inspect","v1"):FixtureInspectWorkflow()}
    def resolve(self,name:str,version:str)->WorkflowSpec:
        try:return self._workflows[(name,version)]
        except KeyError as exc: raise WorkflowValidationError(f'unsupported workflow: {name}@{version}') from exc
    def prepare(self,name:str,version:str,inputs:dict[str,Any])->dict[str,Any]:
        spec=self.resolve(name,version); normalized=spec.validate(inputs)
        return {'workflow_name':spec.name,'workflow_version':spec.version,'inputs':normalized,'allowed_tools':list(spec.allowed_tools),'acceptance':spec.acceptance(normalized),'max_repairs':spec.max_repairs}
