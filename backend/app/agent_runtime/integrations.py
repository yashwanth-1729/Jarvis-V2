"""Mock account-scoped integration adapter; never contacts external services."""
from __future__ import annotations
from dataclasses import dataclass
class IntegrationError(RuntimeError):pass
@dataclass(frozen=True,slots=True)
class IntegrationReceipt: account_id:str; operation_id:str; status:str; content:str
class MockIntegration:
 def __init__(self,account_id:str)->None:self.account_id=account_id;self.revoked=False;self._operations:set[str]=set()
 def draft(self,*,account_id:str,operation_id:str,content:str)->IntegrationReceipt:
  if self.revoked:raise IntegrationError('integration access is revoked')
  if account_id!=self.account_id:raise IntegrationError('wrong account scope')
  if 'ignore previous' in content.lower():raise IntegrationError('untrusted remote content cannot alter adapter policy')
  if operation_id in self._operations:return IntegrationReceipt(account_id,operation_id,'ALREADY_APPLIED',content)
  self._operations.add(operation_id);return IntegrationReceipt(account_id,operation_id,'DRAFTED',content)
 def revoke(self)->None:self.revoked=True
