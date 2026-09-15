"""Closed-by-default feature flags for staged durable-runtime rollout."""
from dataclasses import dataclass
@dataclass(frozen=True,slots=True)
class RuntimeReleaseFlags:
 admit_new_runs:bool=False; domain_writes:bool=False; sensitive_effects:bool=False; background_jobs:bool=False; persistent_browser_profiles:bool=False; parallel_runs:bool=False; android_execution:bool=False
 def may_inspect_or_cancel(self)->bool:return True
 def can_admit(self)->bool:return self.admit_new_runs
