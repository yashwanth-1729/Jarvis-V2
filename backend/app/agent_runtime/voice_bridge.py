"""Voice-job acknowledgement contract; does not alter realtime audio."""
from dataclasses import dataclass
@dataclass(frozen=True,slots=True)
class VoiceJobAck: run_id:str; language:str; message:str
def submitted_ack(run_id:str,language:str)->VoiceJobAck:return VoiceJobAck(run_id,language,'I started that job. I will keep its progress separate from this conversation.')
