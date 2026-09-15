"""Explicit platform capability matrix, preserving Android foreground limits."""
from dataclasses import dataclass
@dataclass(frozen=True,slots=True)
class DeviceCapabilities: platform:str; background_runtime:bool; browser_profiles:bool; desktop_control:bool
def capabilities(platform:str)->DeviceCapabilities:
 return DeviceCapabilities(platform,False,platform=='desktop',platform=='desktop')
