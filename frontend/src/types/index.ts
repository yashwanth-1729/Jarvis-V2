/**
 * Mirrors `backend/app/api/schemas.py`. Keep the two in sync.
 *
 * All datetimes are local-time naive ISO strings: `YYYY-MM-DDTHH:MM:SS`.
 */

export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";
export type IdeaStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type MemoryCategory = "LONG_TERM" | "GOAL" | "PREFERENCE";
export type MemoryType = "WORKING" | "EPISODIC" | "SEMANTIC" | "PROCEDURAL" | "PROSPECTIVE" | "REFLECTIVE";
export type MemoryStatus = "ACTIVE" | "CANDIDATE" | "SUPERSEDED" | "ARCHIVED";

export interface NotePage {
  uid: string;
  title: string;
  kind: "LONG_TERM" | "TEMPORARY" | "OTHER" | "CUSTOM";
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  /**
   * The sync identity — stable across reseeds, unlike `id`.
   *
   * `id` is a rowid on the desktop and a hash of this uid on a client-owned
   * device. Both are now derived from the same value, but `uid` is the one
   * that is genuinely durable, so prefer it whenever a reference has to
   * outlive a refresh.
   */
  uid?: string;
  title: string;
  category: string;
  priority: Priority;
  status: TaskStatus;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The three kinds of schedule entry.
 *   COLLEGE — weekly class timetable
 *   ROUTINE — any other weekly block the user keeps
 *   SESSION — a one-off booking at a specific date and time
 * COLLEGE and ROUTINE recur, so they carry `day_of_week` + `start_time`
 * rather than `time_start`.
 */
export type ScheduleKind = "COLLEGE" | "ROUTINE" | "SESSION";

export interface ScheduleEvent {
  id: number;
  /**
   * The sync identity — stable across reseeds, unlike `id`.
   *
   * `id` is a rowid on the desktop and a hash of this uid on a client-owned
   * device. Both are now derived from the same value, but `uid` is the one
   * that is genuinely durable, so prefer it whenever a reference has to
   * outlive a refresh.
   */
  uid?: string;
  event_name: string;
  kind: ScheduleKind;
  time_start: string | null;
  time_end: string | null;
  /** 0 = Monday … 6 = Sunday. Null for one-off sessions. */
  day_of_week: number | null;
  /** 'HH:MM'. Null for one-off sessions, or a class with no time recorded. */
  start_time: string | null;
  end_time: string | null;
  location: string | null;
  notes: string | null;
  created_at: string;
  /** Server-rendered, so the client never branches on kind to format a time. */
  day_name: string;
  display_start: string;
  display_end: string;
  window: string;
}

export interface ScheduleConflict {
  a_id: number;
  b_id: number;
  a_label: string;
  b_label: string;
  detail: string;
}

export interface GroupedSchedule {
  college: ScheduleEvent[];
  routine: ScheduleEvent[];
  session: ScheduleEvent[];
  conflicts: ScheduleConflict[];
}

export interface Reminder {
  id: number;
  text: string;
  due_at: string;
  /**
   * The real moment an early-notice row stands in for (e.g. a 5pm class when
   * `due_at` is 4:45pm) — set only on that row, by the voice/chat tool's
   * default two-row reminder. Null for an instant reminder, the exact-time
   * row of a default one, and anything created or edited from this UI.
   */
  target_at: string | null;
  created_at: string;
  fired_at: string | null;
}

export interface Idea {
  page_uid?: string | null;
  id: number;
  /**
   * The sync identity — stable across reseeds, unlike `id`.
   *
   * `id` is a rowid on the desktop and a hash of this uid on a client-owned
   * device. Both are now derived from the same value, but `uid` is the one
   * that is genuinely durable, so prefer it whenever a reference has to
   * outlive a refresh.
   */
  uid?: string;
  title: string;
  description: string;
  tags: string;
  status: IdeaStatus;
  created_at: string;
  updated_at: string;
}

export interface Memory {
  expires_at?: string | null;
  id: number;
  /**
   * The sync identity — stable across reseeds, unlike `id`.
   *
   * `id` is a rowid on the desktop and a hash of this uid on a client-owned
   * device. Both are now derived from the same value, but `uid` is the one
   * that is genuinely durable, so prefer it whenever a reference has to
   * outlive a refresh.
   */
  uid?: string;
  key_concept: string;
  category: MemoryCategory;
  content: string;
  memory_type: MemoryType;
  memory_status: MemoryStatus;
  confidence: number;
  importance: number;
  source_kind: string;
  source_ref?: string | null;
  valid_from?: string | null;
  supersedes_uid?: string | null;
  pinned: boolean;
  evidence_count: number;
  tags: string[];
  revision_count: number;
  created_at: string;
  updated_at: string;
}

export interface Brief {
  id: number | null;
  summary_text: string;
  urgent_count: number;
  generated_at: string | null;
  bullets: string[];
}

export interface TaskCounts {
  PENDING: number;
  IN_PROGRESS: number;
  COMPLETED: number;
  OVERDUE: number;
}

export interface DashboardState {
  note_pages?: NotePage[];
  generated_at: string;
  counts: TaskCounts;
  brief: Brief;
  tasks: Task[];
  today: ScheduleEvent[];
  upcoming: ScheduleEvent[];
  schedule: GroupedSchedule;
  ideas: Idea[];
  memories: Memory[];
}

export interface ToggleTaskResponse {
  task: Task;
  /** Completing a task removes it, so the row must be dropped, not re-rendered. */
  cleared: boolean;
  counts: TaskCounts;
  brief: Brief;
}

/* --------------------------------------------------------------------------
 * Chat
 * ----------------------------------------------------------------------- */

export type ToolCallState = "running" | "ok" | "error";

export interface ToolCall {
  id: string;
  name: string;
  state: ToolCallState;
  summary?: string;
  display?: Record<string, unknown> | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  error?: string;
  streaming?: boolean;
  createdAt: string;
}

export interface HistoryMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  created_at: string;
}

/** Refreshable dashboard domains reported by the agent after a tool runs. */
export type RefreshDomain = "tasks" | "schedule" | "ideas" | "memories" | "brief";

/** Primary views, switched from the left rail. */
export type ViewKey = "board" | "schedule" | "vault";

/* --------------------------------------------------------------------------
 * Voice
 * ----------------------------------------------------------------------- */

export interface LanguageOption {
  code: string;
  label: string;
  native: string;
}

export interface VoiceOption {
  id: string;
  label: string;
  gender: "female" | "male";
  note: string;
}

export interface VoiceConfig {
  enabled: boolean;
  stt_provider: string;
  tts_provider: string;
  /** Spoken-output language. Speech input is always auto-detected. */
  language: string;
  max_audio_mb: number;
  languages: LanguageOption[];
  /** Currently selected speaking voice. */
  voice: string;
  voices: VoiceOption[];
}

export interface TranscriptResult {
  text: string;
  language_code: string | null;
  confidence: number | null;
}

export type MicState = "idle" | "recording" | "transcribing";

/**
 * Conversational voice mode.
 *   connecting → opening the socket and acquiring the mic
 *   listening  → waiting for you to speak
 *   hearing    → speech detected, still capturing
 *   thinking   → transcribing / running the agent
 *   speaking   → audio is playing (barge-in armed)
 */
export type VoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "hearing"
  | "thinking"
  | "speaking";

export interface VoiceExchange {
  id: string;
  role: "user" | "jarvis";
  text: string;
}

export type ChatStreamEvent =
  | { type: "start"; data: { model: string } }
  | { type: "text"; data: { text: string } }
  | { type: "thinking"; data: { text: string } }
  | { type: "progress"; data: { message: string } }
  | { type: "tool_use"; data: { id: string; name: string } }
  | {
      type: "tool_result";
      data: {
        id: string;
        name: string;
        ok: boolean;
        summary: string;
        display: Record<string, unknown> | null;
      };
    }
  // Emitted before the model answers, from the user's own words, so the panel
  // opens while JARVIS is still thinking rather than after it has replied.
  | { type: "surface"; data: { kind: string } }
  | { type: "refresh"; data: { domains: RefreshDomain[] } }
  | { type: "error"; data: { message: string } }
  | {
      type: "done";
      data: {
        stop_reason: string | null;
        refresh: RefreshDomain[];
        usage: Record<string, number>;
        text: string;
      };
    };
