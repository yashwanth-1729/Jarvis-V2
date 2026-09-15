"""Fixture runtime occurrence deduplication; separate from reminder scheduling."""
class RuntimeScheduler:
 def __init__(self)->None:self._occurrences:set[tuple[str,str]]=set()
 def admit(self,schedule_id:str,occurrence_key:str)->bool:
  key=(schedule_id,occurrence_key)
  if key in self._occurrences:return False
  self._occurrences.add(key);return True
