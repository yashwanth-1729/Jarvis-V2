"""Bounded read-only child admission; no shared-write parallelism."""
class ChildRunError(RuntimeError):pass
class ChildRunBudget:
 def __init__(self,total:int)->None:self.remaining=total
 def admit_readonly(self,count:int=1)->None:
  if count<1 or count>self.remaining:raise ChildRunError('child budget exhausted')
  self.remaining-=count
