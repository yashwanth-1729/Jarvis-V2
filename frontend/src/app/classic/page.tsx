"use client";

import { transitionUi } from "@/lib/uiMotion";
import { useCommandCenter } from "@/lib/useCommandCenter";
import { Chat } from "@/components/Chat";
import { AgentRunStatus } from "@/components/AgentRunStatus";
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
import type { RefreshDomain } from "@/types";

export default function CommandCenterPage() {
  const {
    state, view, setView, loading, refreshing, error, voiceOpen, setVoiceOpen, settingsOpen, setSettingsOpen, chatOpen, setChatOpen, voiceAvailable, recordsLocal, wideViewport, refresh, handleSynced, handleRegenerateBrief, handleToggleTask, handleRecordChanged, handleAgentRefresh, railCounts, status, surfaceProps, setSurface
  } = useCommandCenter();

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
          enabled={recordsLocal}
          onSynced={handleSynced}
        />

        <MobileTopBar
          className="lg:hidden"
          status={status}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* Shell: rail · one content pane.
            Below `lg` the rail is replaced by bottom navigation; at every
            width there is exactly one content pane, switched by nav choice —
            Chat, or whichever workspace view is selected. Desktop used to
            show the console and the work surface as two permanent side-by-
            side columns alongside the rail. Three simultaneous regions read
            as cluttered rather than considered, and it fought the console
            for width it did not have to give up: a full-width Chat reads
            like a real destination instead of a cramped sidebar, and the
            same is true in reverse for the board. This is the exact
            one-pane-at-a-time model the phone already used (see `chatOpen`
            below) — desktop now gets it too instead of being the one layout
            that never adopted it. */}
        <main
          className={
            "relative grid min-h-0 flex-1 grid-cols-1 overflow-hidden " +
            "lg:grid-cols-[var(--rail-w)_1fr] lg:grid-rows-1"
          }
        >
          <div className="hidden lg:block">
            <Rail
              view={view}
              chatOpen={chatOpen}
              onSelectView={(next) =>
                transitionUi(() => {
                  setChatOpen(false);
                  setView(next);
                })
              }
              onOpenChat={() => transitionUi(() => setChatOpen(true))}
              counts={railCounts}
              status={status}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>

          {/* Console. Voice is the primary interface, so its CTA leads the column
              and typing sits below as the fallback. One emphasised control here;
              everything else on the screen is subordinate to it. */}
          <div
            className={
              "min-h-0 flex-col border-b border-line lg:border-b-0 " +
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
            <AgentRunStatus />
          </div>

          <div className={"min-h-0 overflow-hidden " + (chatOpen ? "hidden" : "block")}>
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
        // Was `surface !== null` -- the panel itself is disabled above
        // (`false && voiceOpen && <SurfaceLayer .../>`) for latency testing,
        // but `surface` state was still being set on every tool_result, so
        // the globe kept shrinking/dimming as if a panel were opening with
        // nothing there to show for it. Hard-false here so the core has zero
        // reaction while the panel stays off. Revert both together.
        panelOpen={false}
      />

      {/* Rendered after the HUD rather than inside it, for two reasons: it
          stacks above a z-50 overlay without fighting it, and VoiceMode stays
          ignorant of records, mutations and dashboard state — it asks for a
          surface and does not care who draws it. */}
      {/* Temporarily disabled (2026-09-16) for raw voice-latency testing --
          the user wants no tool-result panel popping up over the HUD while
          timing the cloud voice stack. Re-enable by restoring the `voiceOpen &&`
          block below; nothing else changed, `surfaceProps` still exists. */}
      {false && voiceOpen && (
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
