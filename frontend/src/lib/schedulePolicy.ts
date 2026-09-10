import type { ScheduleEvent } from "@/types";

/** Local wall-clock storage matches the backend. Missing legacy ends mean 1h. */
export function blockEnd(row: { kind?: unknown; time_start?: unknown; time_end?: unknown }): number | null {
  if (row.kind !== "SESSION" || !row.time_start) return null;
  const start = new Date(String(row.time_start)).getTime();
  const end = row.time_end ? new Date(String(row.time_end)).getTime() : start + 3_600_000;
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end : null;
}

export function localIso(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function chronological(a: ScheduleEvent, b: ScheduleEvent): number {
  return (new Date(a.time_start ?? "").getTime() || Infinity) - (new Date(b.time_start ?? "").getTime() || Infinity);
}

/** Expand weekly templates on a date, then trim only routine time occupied by Blocks. */
export function agendaForDay(events: ScheduleEvent[], day: Date): ScheduleEvent[] {
  const key = localIso(day).slice(0, 10);
  const midnight = new Date(`${key}T00:00:00`).getTime();
  const tomorrow = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const blocks = events.filter(e => e.kind === "SESSION" && e.time_start &&
    new Date(e.time_start).getTime() < tomorrow && (blockEnd(e) ?? 0) > midnight);
  const result: ScheduleEvent[] = [...blocks];
  for (const event of events) {
    if (event.kind === "SESSION" || event.day_of_week !== (day.getDay() + 6) % 7) continue;
    const start = new Date(`${key}T${event.start_time || "00:00"}`).getTime();
    let end = event.end_time ? new Date(`${key}T${event.end_time}`).getTime() : start + 3_600_000;
    if (end <= start) end += 86_400_000;
    let pieces = [[start, end]];
    if (event.kind === "ROUTINE" && event.start_time) {
      for (const block of blocks) {
        const bs = new Date(block.time_start!).getTime(), be = blockEnd(block)!;
        pieces = pieces.flatMap(([s, e]) => bs >= e || be <= s ? [[s, e]] :
          [[s, Math.min(bs, e)], [Math.max(be, s), e]].filter(([left, right]) => left < right));
      }
    }
    for (const [s, e] of pieces) {
      const display = (value: number) => new Date(value).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"});
      result.push({...event, time_start: localIso(new Date(s)), time_end: localIso(new Date(e)),
        display_start: display(s), display_end: display(e), window: `${display(s)} - ${display(e)}`});
    }
  }
  return result.sort(chronological);
}
