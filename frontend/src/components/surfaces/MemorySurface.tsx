"use client";

/**
 * What JARVIS knows that bears on the question — not everything it knows.
 *
 * This was a search interface: a filter box, six category chips, an entry
 * count, and every memory and idea listed beneath. That is the right design
 * for a page someone opens to go looking. It is the wrong one entirely for a
 * panel that appears because a question was asked out loud, where the honest
 * response to "eleven entries, filter them yourself" is that the panel has
 * handed the work straight back.
 *
 * So there are no controls. The panel shows the entries, most recent first,
 * capped — because a spoken question deserves an answer, and a scrollable
 * archive with a search box is a place to look for one.
 */

import { Brain, Lightbulb } from "lucide-react";
import * as React from "react";

import { stagger } from "@/lib/motion";
import { cn } from "@/lib/utils";
import type { Idea, Memory } from "@/types";

/** Enough to answer with; past this it is an archive, not a reply. */
const MAX_SHOWN = 6;

const CATEGORY_LABEL: Record<string, string> = {
  LONG_TERM: "long term",
  PREFERENCE: "preference",
  GOAL: "goal",
};

interface MemorySurfaceProps {
  memories: Memory[];
  ideas: Idea[];
  onEditMemory: (memory: Memory) => void;
  onEditIdea: (idea: Idea) => void;
}

export function MemorySurface({
  memories,
  ideas,
  onEditMemory,
  onEditIdea,
}: MemorySurfaceProps) {
  const activeMemories = memories.filter(memory => memory.memory_status === "ACTIVE");
  const shownMemories = activeMemories.slice(0, MAX_SHOWN);
  const shownIdeas = ideas.slice(0, Math.max(0, MAX_SHOWN - shownMemories.length));
  const hidden =
    activeMemories.length + ideas.length - shownMemories.length - shownIdeas.length;

  return (
    <div className="flex h-full flex-col gap-3 pt-1">
      <h3 className="shrink-0 font-display text-2xl font-semibold tracking-tight text-ink">
        Memory
      </h3>

      {shownMemories.length === 0 && shownIdeas.length === 0 ? (
        <p className="text-sm text-ink-dim">Nothing remembered yet.</p>
      ) : (
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain">
          {shownMemories.map((memory, index) => (
            <li
              key={memory.uid ?? memory.id}
              style={{ animationDelay: `${stagger(index, 30)}ms` }}
              className="animate-row-in"
            >
              <button
                type="button"
                onClick={() => onEditMemory(memory)}
                className={cn(
                  "flex w-full gap-2.5 rounded-sm px-2 py-2 text-left",
                  "transition-colors duration-150 hover:bg-surface-2/50",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                )}
              >
                <Brain aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/70" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 break-words text-sm leading-snug text-ink">
                      {memory.key_concept}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[0.6rem] uppercase tracking-[0.16em] text-ink-faint">
                      {memory.memory_type?.toLocaleLowerCase() ?? CATEGORY_LABEL[memory.category] ?? ""}
                    </span>
                  </span>
                  {/* The content, not a teaser of it. A one-line preview that
                      stops mid-sentence is the shape that made this panel
                      useless — the answer was always the part cut off. */}
                  <span className="mt-0.5 block break-words text-2xs leading-relaxed text-ink-dim">
                    {memory.content}
                  </span>
                </span>
              </button>
            </li>
          ))}

          {shownIdeas.map((idea, index) => (
            <li
              key={idea.uid ?? idea.id}
              style={{ animationDelay: `${stagger(shownMemories.length + index, 30)}ms` }}
              className="animate-row-in"
            >
              <button
                type="button"
                onClick={() => onEditIdea(idea)}
                className={cn(
                  "flex w-full gap-2.5 rounded-sm px-2 py-2 text-left",
                  "transition-colors duration-150 hover:bg-surface-2/50",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                )}
              >
                <Lightbulb aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent/70" />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm leading-snug text-ink">
                    {idea.title}
                  </span>
                  {idea.description && (
                    <span className="mt-0.5 block break-words text-2xs leading-relaxed text-ink-dim">
                      {idea.description}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <p className="shrink-0 font-mono text-2xs text-ink-faint">
          {hidden} more — ask for what you need.
        </p>
      )}
    </div>
  );
}
