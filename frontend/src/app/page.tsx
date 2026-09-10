"use client";

import * as React from "react";
import { transitionUi } from "@/lib/uiMotion";

import { Chat } from "@/components/Chat";
import { Dashboard } from "@/components/Dashboard";
import { SurfaceLayer } from "@/components/surfaces/SurfaceLayer";
import { MobileNav } from "@/components/MobileNav";
import { MobileTopBar } from "@/components/MobileTopBar";
import { Rail } from "@/components/Rail";
import { SettingsPanel } from "@/components/SettingsPanel";
import { SyncBanner } from "@/components/SyncBanner";
import { VoiceLauncher } from "@/components/VoiceLauncher";
import { VoiceMode } from "@/components/VoiceMode";
import { ShaderBackground } from "@/components/ui/simplex-noise-first-contact";
import {
  ApiError,
  fetchClientOwnsData,
  fetchDashboard,
  regenerateBrief,
  toggleTask,
} from "@/lib/api";
import { drainAgentStore, seedAgentStore, sendProviderKey } from "@/lib/agentBridge";
import { localDashboard } from "@/lib/localDashboard";
import { syncNativeNotifications } from "@/lib/nativeNotifications";
import { reportLocation } from "@/lib/geo";
import { blockEnd } from "@/lib/schedulePolicy";
import type { SurfaceDescriptor } from "@/lib/surfaces";
import { toggleTaskLocally } from "@/lib/localMutations";
import { fetchVoiceConfig, isRecordingSupported } from "@/lib/voice";
import type { DashboardState, RefreshDomain, TaskStatus, ViewKey } from "@/types";

/** Background poll interval. The chat stream pushes targeted refreshes, so this
 *  only has to catch drift (e.g. an event becoming "now"). */
const POLL_MS = 60_000;

/** How soon to retry after the backend refuses a connection.
 *
 *  On the phone the backend starts *with* the app: CPython, FastAPI and SQLite
 *  take several seconds to come up, so the first fetch reliably lands before
 *  anything is listening. At the normal poll interval that showed an error for
 *  a full minute before correcting itself, which reads as broken rather than
 *  starting. Backing off from 1.5s up to the poll interval covers the gap
 *  without hammering a backend that is genuinely absent. */
const RETRY_MS = [1_500, 2_500, 4_000, 8_000, 15_000];

/**
 * True only on a wide viewport, decided in JavaScript rather than CSS.
 *
 * The difference matters here. The voice launcher panel was gated with
 * `hidden lg:block`, which stops it painting but does not stop it existing:
 * on a phone it still mounted a full three.js scene -- ~15k additive line
 * segments through an UnrealBloomPass -- allocating a WebGL context and its
 * render targets on the same GPU driving the interface, to produce nothing at
 * all. Gating the mount means the phone never pays for it.
 *
 * Defaults to false so the server renders the phone layout and no scene is
 * created during hydration.
 */
function useWideViewport(): boolean {
  const [wide, setWide] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return wide;
}

export default function CommandCenterPage() {
  const [state, setState] = React.useState<DashboardState | null>(null);
  const [view, setView] = React.useState<ViewKey>("board");
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [voiceOpen, setVoiceOpen] = React.useState(false);
  /**
   * The instrument panel currently materialised over the dashboard.
   *
   * Owned here rather than inside Chat because both transports feed it — typed
   * turns over SSE and spoken ones over the websocket — and because it has to
   * outlive the message that produced it. Asking a question and then scrolling
   * the transcript should not dismiss the answer.
   */
  const [surface, setSurface] = React.useState<SurfaceDescriptor | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  /** Phones show one pane at a time; this is the chat destination. */
  const [chatOpen, setChatOpen] = React.useState(false);
  const [voiceAvailable, setVoiceAvailable] = React.useState(false);
  /** Bumped once credentials reach the runtime, to re-ask about voice. */
  const [credentialsSent, setCredentialsSent] = React.useState(0);

  // Guards against two refreshes landing out of order and showing stale data.
  const requestSeq = React.useRef(0);
  /** Consecutive failed backend fetches, for the retry backoff. */
  const missedRef = React.useRef(0);
  /** Whether the agent's working copy has been seeded this session. */
  const seededRef = React.useRef(false);
  /**
   * True when this runtime is only the AI and the local store is
   * authoritative — the arrangement on mobile. Asked of the runtime rather
   * than assumed from the platform, and held in a ref because the read path
   * consults it mid-flight rather than rendering from it.
   */
  const clientOwnsRef = React.useRef(false);
  /** False until a runtime has actually answered; see refresh(). */
  const modeKnownRef = React.useRef(false);

  /** Local data exists and is being shown because the backend is unreachable. */
  const [localOnly, setLocalOnly] = React.useState(false);
  const [clientOwned, setClientOwned] = React.useState(false);
  const recordsLocal = clientOwned || localOnly;
  const wideViewport = useWideViewport();

  /**
   * Read IndexedDB, but only accept it if it actually holds something.
   *
   * On mobile the sync client fills IndexedDB and it is the authoritative
   * store, so this is the real dashboard. On desktop the Python backend owns
   * SQLite and syncs it directly, leaving IndexedDB empty — falling back to an
   * empty store there would blank a working dashboard, so an empty result is
   * treated as "no local data" rather than "no data".
   */
  const loadLocal = React.useCallback(async () => {
    try {
      const local = await localDashboard();
      const populated =
        local.tasks.length + local.schedule.college.length + local.schedule.routine.length +
        local.schedule.session.length + local.ideas.length + local.memories.length;
      return populated > 0 ? local : null;
    } catch {
      return null; // IndexedDB unavailable (private mode, prerender)
    }
  }, []);

  const refresh = React.useCallback(async () => {
    const seq = ++requestSeq.current;
    setRefreshing(true);
    try {
      // Which store is authoritative has to be settled *before* choosing a read
      // path, and it can only be answered by a runtime that is up. On mobile the
      // runtime boots with the app and takes several seconds, so asking once at
      // mount reliably failed and latched "backend owns the data" forever —
      // which is what overwrote a correctly-rendered board with an empty one a
      // couple of seconds after launch. Asking until answered costs one request
      // per refresh while the runtime starts, and nothing afterwards.
      if (!modeKnownRef.current) {
        const owns = await fetchClientOwnsData();
        if (seq !== requestSeq.current) return;
        if (owns) {
          modeKnownRef.current = true;
          clientOwnsRef.current = true;
          setClientOwned(true);
        }
      }

      // Where the runtime is only the AI, the local store is authoritative and
      // the dashboard renders from it -- always, not merely as a fallback.
      // Reading the runtime's copy here is what let a stale working copy show
      // "no tasks" while the real board sat in IndexedDB.
      if (clientOwnsRef.current) {
        const local = await localDashboard();
        if (seq !== requestSeq.current) return;

        let merged = local;
        try {
          const remote = await fetchDashboard();
          if (seq !== requestSeq.current) return;
          // Only the brief is taken. It is computed by the runtime from
          // overdue windows and upcoming blocks -- deterministic, not a model
          // call -- and richer than what the client derives on its own. Every
          // row stays local.
          merged = { ...local, brief: remote.brief };
          missedRef.current = 0;
          if (!seededRef.current) {
            seededRef.current = true;
            // Credentials first: the runtime cannot answer anything without
            // them, and both belong to the same first-contact handshake.
            void sendProviderKey()
              .then(() => seedAgentStore())
              // The brief is computed from the runtime's database and cached,
              // so the one fetched a moment ago describes the *empty* working
              // copy that existed before the seed — "all clear" over a board
              // showing three overdue tasks. It is deterministic, not a model
              // call, so rebuilding it costs nothing.
              .then(() => regenerateBrief().catch(() => null))
              .then((brief) => {
                if (brief) setState((current) => (current ? { ...current, brief } : current));
              })
              // Voice availability depends on the key, and was already
              // read before we sent it.
              .finally(() => setCredentialsSent((n) => n + 1));
          }
        } catch {
          // No runtime means no brief. The board is unaffected, so this is not
          // an error state.
          missedRef.current += 1;
        }

        setState(merged);
        setLocalOnly(false);
        setError(null);
        return;
      }

      const next = await fetchDashboard();
      if (seq !== requestSeq.current) return;
      missedRef.current = 0;
      setState(next);
      setLocalOnly(false);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      missedRef.current += 1;

      // The backend being down is not the same as having no data. Where local
      // records exist they are the dashboard, and losing the AI runtime costs
      // the brief and voice -- not the board.
      const local = await loadLocal();
      if (seq !== requestSeq.current) return;
      if (local) {
        setState(local);
        setLocalOnly(true);
        setError(null);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not load the dashboard. Is the backend running?",
        );
      }
    } finally {
      if (seq === requestSeq.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [loadLocal]);

  // Paint from local storage before anything touches the network. Startup must
  // not wait on a backend that may not be running or a sync that may not be
  // configured.
  React.useEffect(() => {
    let cancelled = false;
    void loadLocal().then((local) => {
      if (cancelled || !local) return;
      clientOwnsRef.current = true;
      setClientOwned(true);
      // Only fills the gap before the first response; a completed fetch wins.
      setState((current) => current ?? local);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [loadLocal]);

  // Self-scheduling rather than a fixed interval, so the delay can shorten
  // while the backend is still starting and relax once it answers.
  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      await refresh();
      if (cancelled) return;
      const misses = missedRef.current;
      const delay = misses === 0 ? POLL_MS : (RETRY_MS[misses - 1] ?? POLL_MS);
      timer = setTimeout(() => void tick(), delay);
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  // Wake at the next Block's end, and reconcile immediately after suspension.
  React.useEffect(() => {
    const ends = [...(state?.schedule.session ?? []).map(blockEnd), ...(state?.memories ?? []).map(memory => memory.expires_at ? new Date(memory.expires_at).getTime() : null)].filter((end): end is number => end !== null && Number.isFinite(end) && end > Date.now());
    const timer = ends.length ? setTimeout(() => void refresh(), Math.min(2_147_483_647, Math.max(50, Math.min(...ends) - Date.now() + 20))) : null;
    const resume = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", resume);
    return () => { if (timer !== null) clearTimeout(timer); document.removeEventListener("visibilitychange", resume); };
  }, [state?.schedule.session, state?.memories, refresh]);

  // Android owns notification delivery after the WebView and Python runtime
  // close. Refresh the native alarm plan whenever the local dashboard changes,
  // and once more if the bridge attaches after React has already mounted.
  React.useEffect(() => {
    if (!state) return;
    const sync = () => void syncNativeNotifications();
    const timer = setTimeout(sync, 200);
    window.addEventListener("jarvis-native-notifications-ready", sync);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("jarvis-native-notifications-ready", sync);
    };
  }, [state]);

  React.useEffect(() => {
    let cancelled = false;
    fetchVoiceConfig()
      .then((config) => {
        if (!cancelled) setVoiceAvailable(config.enabled && isRecordingSupported());
      })
      .catch(() => {
        if (!cancelled) setVoiceAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [credentialsSent]);

  // The agent tells us which panels its tools invalidated. The dashboard is one
  // aggregate endpoint, so any non-empty domain list means "refetch".
  const handleAgentRefresh = React.useCallback(
    (domains: RefreshDomain[]) => {
      if (!domains.length) return;
      // The agent wrote to its working copy, not to the store the UI reads.
      // Collect those changes first so they land in IndexedDB and queue for
      // Supabase; refreshing before that would render the old state.
      void drainAgentStore().finally(() => void refresh());
    },
    [refresh],
  );

  /**
   * A sync brought rows in or pushed rows out.
   *
   * The runtime holds a working copy taken at connect, which is now behind the
   * local store. Re-seeding keeps the agent answering from the same data the
   * user is looking at — without it, "what's on my board?" describes a snapshot
   * from launch.
   */
  const handleSynced = React.useCallback(() => {
    if (clientOwnsRef.current) void seedAgentStore();
    void refresh();
  }, [refresh]);

  const handleRegenerateBrief = React.useCallback(async () => {
    setRefreshing(true);
    try {
      const brief = await regenerateBrief();
      setState((current) => (current ? { ...current, brief } : current));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not regenerate the brief.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleToggleTask = React.useCallback(
    async (taskId: number, next: TaskStatus) => {
      // Optimistic: the row flips immediately, then the server response
      // reconciles the task, counters and brief in one shot.
      setState((current) =>
        current
          ? {
              ...current,
              tasks: current.tasks.map((task) =>
                task.id === taskId ? { ...task, status: next } : task,
              ),
            }
          : current,
      );

      // Running on local data means IndexedDB is the store, so the write lands
      // there and is queued for sync. No network is involved and none is
      // needed — this is the path that keeps editing working in every one of
      // the degraded modes.
      if (clientOwnsRef.current || localOnly) {
        const applied = await toggleTaskLocally(taskId, next);
        if (!applied) return;
        const local = await loadLocal();
        setState(local ?? (await localDashboard()));
        setError(null);
        void seedAgentStore();
        return;
      }

      try {
        const result = await toggleTask(taskId, next);
        setState((current) =>
          current
            ? {
                ...current,
                counts: result.counts,
                brief: result.brief,
                // Completing a task clears it off the board, so the row is
                // dropped rather than re-rendered in a done state.
                tasks: result.cleared
                  ? current.tasks.filter((task) => task.id !== result.task.id)
                  : current.tasks.map((task) =>
                      task.id === result.task.id ? result.task : task,
                    ),
              }
            : current,
        );
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not update that task.");
        void refresh(); // roll the optimistic update back to server truth
      }
    },
    [refresh, localOnly, loadLocal],
  );

  /**
   * Reload after a hand edit.
   *
   * Deliberately a full refresh rather than an optimistic patch. A create can
   * change the counters and the brief, an edit can move a task between
   * filters, and a delete removes it — reconciling all of that by hand is how
   * the board and the banner end up disagreeing. The status toggle stays
   * optimistic because it happens constantly and a round trip would be felt.
   */
  const handleRecordChanged = React.useCallback(() => {
    if (clientOwnsRef.current || localOnly) {
      // IndexedDB already has the write; re-read it and re-seed the agent's
      // working copy so JARVIS sees what the user just changed.
      void loadLocal().then((next) => {
        if (next) setState(next);
        else void refresh();
        void seedAgentStore();
      });
      return;
    }
    void refresh();
  }, [localOnly, loadLocal, refresh]);

  const railCounts = React.useMemo(
    () => ({
      board: state ? state.counts.PENDING + state.counts.IN_PROGRESS : 0,
      schedule: state?.today.length ?? 0,
      vault: state ? state.ideas.length + state.memories.length : 0,
    }),
    [state],
  );

  // `localOnly` is not an error state: the board is intact, the AI runtime
  // simply is not answering. Only a genuine failure to produce any data at
  // all reads as offline.
  const status = error || localOnly ? "offline" : refreshing ? "syncing" : "online";

  // Learn where the user is, once, in the background.
  //
  // Delayed rather than fired on mount: the first seconds after launch are
  // spent seeding local data and waking the backend, and a permission dialog
  // landing on top of that is both a jarring first frame and a fix with
  // nowhere to be posted yet. `reportLocation` decides for itself whether to
  // ask at all — it stays quiet if it asked recently or was refused before.
  React.useEffect(() => {
    const timer = setTimeout(() => void reportLocation(), 4000);
    return () => clearTimeout(timer);
  }, []);

  // Ctrl/Cmd+J opens voice mode from anywhere. Voice is the primary interface,
  // so it deserves a shortcut that works without reaching for the mouse —
  // including from inside the message box.
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "j" || !(event.ctrlKey || event.metaKey)) return;
      if (!voiceAvailable) return;
      event.preventDefault();
      setVoiceOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [voiceAvailable]);

  // One panel, two possible homes. Which one is live depends on whether the
  // HUD is up, because the HUD is a fixed opaque overlay and a panel mounted
  // in the shell simply renders beneath it.
  const surfaceProps = {
    surface,
    state,
    mode: { local: recordsLocal },
    onClose: () => setSurface(null),
    onToggleTask: handleToggleTask,
    onChanged: handleRecordChanged,
  };

  return (
    <div className="product-shell relative h-dvh overflow-hidden bg-surface-0">
      {/* Ambient field. Two scrims sit between it and the UI: a heavy gradient
          for contrast safety, and a hairline grid for drafting-table structure.
          Everything above renders on opaque surfaces, so token contrast ratios
          hold regardless of what the shader is doing underneath. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.28]">
        <ShaderBackground className="h-full w-full" speed={0.5} />
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-surface-0/85"
      />
      <div
        aria-hidden
        className="grid-texture pointer-events-none absolute inset-0 opacity-40"
      />

      {/* Column so the sync bar takes its own space instead of overlaying the
          shell. A bar that covers content is just a modal with extra steps.

          The safe-area padding lives here rather than on the root so the
          ambient shader above still bleeds edge to edge behind the status and
          gesture bars — the background is meant to fill the screen, the
          controls are not. Left/right matter in landscape, where a display
          cutout eats into the rail. */}
      <div
        className={
          "app-frame relative flex h-full flex-col " +
          "pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] " +
          "pt-[env(safe-area-inset-top)] lg:pb-[env(safe-area-inset-bottom)]"
        }
      >
        <SyncBanner
          className="shrink-0"
          onSynced={handleSynced}
        />

        <MobileTopBar
          className="lg:hidden"
          status={status}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* Shell: rail · console · work surface.
            Below `lg` the console and work surface stack, rail stays fixed. */}
        <main
          className={
            // One pane at a time on a phone, everything at once on a desktop.
            // Below `lg` the rail is replaced by bottom navigation, so the
            // content gets the full width instead of losing a strip of it to
            // chrome that a thumb cannot comfortably reach anyway.
            "relative grid min-h-0 flex-1 grid-cols-1 overflow-hidden " +
            "lg:grid-cols-[var(--rail-w)_var(--console-w)_1fr] lg:grid-rows-1"
          }
        >
          <div className="hidden lg:block">
            <Rail
              view={view}
              onViewChange={(next) => transitionUi(() => setView(next))}
              counts={railCounts}
              status={status}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>

          {/* Console. Voice is the primary interface, so its CTA leads the column
              and typing sits below as the fallback. One emphasised control here;
              everything else on the screen is subordinate to it.

              On a phone this is a destination rather than a permanent column:
              it used to occupy 44% of the height at all times, which left the
              board — the thing most glances are for — squeezed into the
              remainder. */}
          <div
            className={
              "min-h-0 flex-col border-b border-line lg:flex lg:border-b-0 " +
              (chatOpen ? "flex" : "hidden")
            }
          >
            {/* The bottom bar carries the voice action on a phone, so this
                panel would be a second entry point competing with it. */}
            {voiceAvailable && wideViewport && (
              <div className="shrink-0 border-b border-line bg-surface-1 p-3">
                <VoiceLauncher onClick={() => setVoiceOpen(true)} />
              </div>
            )}
            <div className="min-h-0 flex-1">
              <Chat onRefresh={handleAgentRefresh} onSurface={setSurface} />
            </div>
          </div>

          <div className={"min-h-0 overflow-hidden lg:block " + (chatOpen ? "hidden" : "block")}>
            <Dashboard
              view={view}
              state={state}
              loading={loading}
              refreshing={refreshing}
              error={error}
              onRefresh={() => void refresh()}
              onRegenerateBrief={() => void handleRegenerateBrief()}
              onToggleTask={handleToggleTask}
              mode={{ local: recordsLocal }}
              onChanged={handleRecordChanged}
            />
          </div>

          {/* Mounted beside the panes, not inside one.
              It used to live in the dashboard column, which a phone sets to
              `display:none` the moment the console opens — so asking a question
              on mobile materialised the panel into a hidden pane and nothing
              appeared. Measured on the device: 0x0, hidden by an ancestor.
              Here it can cover the pane on a phone and sit beside the globe on
              a wide screen, without either layout hiding it. */}
          {/* No instrument panel in the shell. It belongs to voice only.

              In the HUD a panel is the only place an answer can be shown, so it
              earns the screen. In the app it does not: the board, the schedule
              and the notes are already on screen as full, scrollable, editable
              views, so a panel over them is a worse copy of what it is
              covering — and it appeared over the dashboard while the user was
              typing, which is simply in the way. */}
        </main>

        <MobileNav
          className="lg:hidden"
          pane={chatOpen ? "chat" : view}
          onPaneChange={(pane) => transitionUi(() => {
            if (pane === "chat") {
              setChatOpen(true);
            } else {
              setChatOpen(false);
              setView(pane);
            }
          })}
          onVoice={() => setVoiceOpen(true)}
          voiceAvailable={voiceAvailable}
          counts={railCounts}
        />
      </div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onRefresh={(domains) => handleAgentRefresh(domains as RefreshDomain[])}
        onSurface={setSurface}
        panelOpen={surface !== null}
      />

      {/* Rendered after the HUD rather than inside it, for two reasons: it
          stacks above a z-50 overlay without fighting it, and VoiceMode stays
          ignorant of records, mutations and dashboard state — it asks for a
          surface and does not care who draws it. */}
      {voiceOpen && (
        <SurfaceLayer
          {...surfaceProps}
          placement="voice"
          onAsk={(message) => {
            // Typing a follow-up means leaving the spoken conversation, so the
            // HUD comes down rather than the console opening behind it.
            setVoiceOpen(false);
            setChatOpen(true);
            setSurface(null);
            window.dispatchEvent(new CustomEvent("jarvis:ask", { detail: message }));
          }}
        />
      )}
    </div>
  );
}
