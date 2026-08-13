/**
 * Mirrors `backend/app/api/schemas.py`. Keep the two in sync.
 *
 * All datetimes are local-time naive ISO strings: `YYYY-MM-DDTHH:MM:SS`.
 */

export type Priority = "HIGH" | "MEDIUM" | "LOW";
export type TaskStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED";
export type IdeaStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
export type MemoryCategory = "LONG_TERM" | "GOAL" | "PREFERENCE" | "PRIVATE";

export interface Task {
  id: number;
  title: string;
  category: string;
  priority: Priority;
  status: TaskStatus;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleEvent {
  id: number;
  event_name: string;
  time_start: string;
  time_end: string | null;
  location: string | null;
  notes: string | null;
  created_at: string;
}

export interface Idea {
  id: number;
  title: string;
  description: string;
  tags: string;
  status: IdeaStatus;
  created_at: string;
  updated_at: string;
}

export interface Memory {
  id: number;
  key_concept: string;
  category: MemoryCategory;
  content: string;
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
  generated_at: string;
  counts: TaskCounts;
  brief: Brief;
  tasks: Task[];
  today: ScheduleEvent[];
  upcoming: ScheduleEvent[];
  ideas: Idea[];
  memories: Memory[];
}

export interface ToggleTaskResponse {
  task: Task;
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

export interface VoiceConfig {
  enabled: boolean;
  stt_provider: string;
  tts_provider: string;
  language: string;
  max_audio_mb: number;
}

export interface TranscriptResult {
  text: string;
  language_code: string | null;
  confidence: number | null;
}

export type MicState = "idle" | "recording" | "transcribing";

export type ChatStreamEvent =
  | { type: "start"; data: { model: string } }
  | { type: "text"; data: { text: string } }
  | { type: "thinking"; data: { text: string } }
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
