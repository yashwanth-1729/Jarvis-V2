import "fake-indexeddb/auto";
import { clearAll, expireBlocks, expireMemories, getRow, putRows } from "@/lib/localdb";
import { agendaForDay } from "@/lib/schedulePolicy";
import type { ScheduleEvent } from "@/types";

let failed = 0;
const check = (label: string, okay: boolean) => { console.log(`${okay ? "PASS" : "FAIL"} ${label}`); if (!okay) failed++; };
async function main() {
await clearAll();
await putRows("schedules", [{uid:"old-block",kind:"SESSION",event_name:"Done",time_start:"2026-09-09T08:00:00",time_end:"2026-09-09T09:00:00",updated_at:"2026-09-09T08:00:00"}]);
check("expired Block is removed", await expireBlocks(new Date("2026-09-09T09:00:01")) === 1 && !await getRow("schedules", "old-block"));
await putRows("memories", [{uid:"short-rule",key_concept:"Rule",content:"temporary",expires_at:"2026-09-10T00:00:00",updated_at:"2026-09-09T08:00:00"}]);
check("temporary memory is removed at its deadline", await expireMemories(new Date("2026-09-10T00:00:00")) === 1 && !await getRow("memories", "short-rule"));
const base = {id:1,uid:"routine",event_name:"Study",kind:"ROUTINE",time_start:null,time_end:null,day_of_week:0,start_time:"18:00",end_time:"23:00",location:null,notes:null,created_at:"",day_name:"Monday",display_start:"6:00 PM",display_end:"11:00 PM",window:"6:00 PM - 11:00 PM"} as ScheduleEvent;
const block = {...base,id:2,uid:"block",event_name:"Summit",kind:"SESSION",day_of_week:null,start_time:null,end_time:null,time_start:"2026-09-14T20:00:00",time_end:"2026-09-14T21:00:00"} as ScheduleEvent;
const agenda = agendaForDay([base, block], new Date("2026-09-14T10:00:00"));
check("Block overrides only its routine interval", agenda.length === 3 && agenda[0].time_start?.endsWith("18:00:00") === true && agenda[1].event_name === "Summit" && agenda[2].time_start?.endsWith("21:00:00") === true);
check("agenda remains nearest first", agenda.every((row, i) => i === 0 || row.time_start! >= agenda[i - 1].time_start!));
return failed ? 1 : 0;
}
main().then(code => process.exit(code));
