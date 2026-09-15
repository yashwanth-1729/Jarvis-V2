"""Redacted bounded diagnostic events; never stores raw secret-bearing text."""
import re
class Telemetry:
 def __init__(self,limit:int=100)->None:self.limit=limit;self.events:list[dict[str,str]]=[]
 def emit(self,kind:str,detail:str)->None:
  redacted=re.sub(r'(?:sk|api)[-_][A-Za-z0-9_-]{8,}','[REDACTED]',detail)
  self.events.append({'kind':kind,'detail':redacted})
  self.events=self.events[-self.limit:]
