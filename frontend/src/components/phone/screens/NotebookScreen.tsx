"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CaretLeft, Clock, MagnifyingGlass, NotePencil, PencilSimple, Plus, PushPin, X } from "@phosphor-icons/react";

import type { Idea, Memory, NotePage } from "@/types";
import { allPages, isMemoryPage, MEMORY_LABEL, MEMORY_TONE, pageIdeas, pageTone } from "../lib/derive";
import { when } from "../lib/time";
import { usePhone, type MemoryView } from "../PhoneContext";
import { MemorySheet, NoteSheet, PageSheet, type MemoryTarget, type NoteTarget, type PageTarget } from "../sheets/NoteSheets";
import { Chip, Empty, Sticker } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Tap } from "../ui/Tap";
import { pageIcon } from "./MemoryScreen";

const VIEWS: Array<{ value: MemoryView; label: string }> = [
  { value: "ALL", label: "Active" },
  { value: "SEMANTIC", label: "Knowledge" },
  { value: "PROCEDURAL", label: "Rules" },
  { value: "EPISODIC", label: "Episodes" },
  { value: "PROSPECTIVE", label: "Goals" },
  { value: "REFLECTIVE", label: "Patterns" },
  { value: "REVIEW", label: "Review" },
];

const VIEW_TONE: Partial<Record<MemoryView, string>> = {
  SEMANTIC: MEMORY_TONE.SEMANTIC,
  PROCEDURAL: MEMORY_TONE.PROCEDURAL,
  EPISODIC: MEMORY_TONE.EPISODIC,
  PROSPECTIVE: MEMORY_TONE.PROSPECTIVE,
  REFLECTIVE: MEMORY_TONE.REFLECTIVE,
  REVIEW: "amber",
};

/** One notes page: a memory page with role filters, or a page of notes. */
export function NotebookScreen({ uid, initialView = "ALL", fallback }: { uid: string; initialView?: MemoryView; fallback?: NotePage }) {
  const { app, pop } = usePhone();
  const [view, setView] = React.useState<MemoryView>(initialView);
  const [query, setQuery] = React.useState("");
  const [renamed, setRenamed] = React.useState<NotePage | null>(null);
  const [editingPage, setEditingPage] = React.useState<PageTarget>(null);
  const [editingMemory, setEditingMemory] = React.useState<MemoryTarget>(null);
  const [editingNote, setEditingNote] = React.useState<NoteTarget>(null);

  const pages = allPages(app.state?.note_pages);
  const stored = pages.find((page) => page.uid === uid);
  // Show a just-saved title until the refreshed dashboard carries it.
  const page = renamed && (!stored || stored.updated_at < renamed.updated_at) ? renamed : stored ?? fallback ?? pages[0];
  const memoryPage = isMemoryPage(page);
  const temporary = page.kind === "TEMPORARY";
  const memories = app.state?.memories ?? [];
  const ideas = app.state?.ideas ?? [];
  const needle = query.trim().toLocaleLowerCase();

  const inView = (memory: Memory, which: MemoryView) => {
    if (which === "REVIEW") return memory.memory_status === "CANDIDATE";
    if (memory.memory_status !== "ACTIVE" || Boolean(memory.expires_at) !== temporary) return false;
    return which === "ALL" || memory.memory_type === which;
  };
  const shownMemories = memories.filter((memory) => inView(memory, view) && `${memory.key_concept} ${memory.content}`.toLocaleLowerCase().includes(needle));
  const shownIdeas = pageIdeas(page, ideas, pages).filter((idea) => `${idea.title} ${idea.description}`.toLocaleLowerCase().includes(needle));
  const count = memoryPage ? shownMemories.length : shownIdeas.length;

  const hint = temporary
    ? "Rules for right now. Forgotten automatically when their time is up."
    : memoryPage
      ? "What JARVIS remembers about you, until you delete it."
      : "Ideas worth keeping. Yours to fill, revisit and refine.";

  return (
    <>
      <Screen
        title={page.title}
        tone={pageTone(page)}
        bottomPad={false}
        className="ph-notebook"
        leading={
          <Tap className="ph-icon-btn" aria-label="Back" onClick={pop} feel="select">
            <CaretLeft size={22} weight="bold" />
          </Tap>
        }
        actions={
          <Tap className="ph-icon-btn" aria-label={`Rename ${page.title}`} onClick={() => setEditingPage(page)}>
            <PencilSimple size={20} weight="bold" />
          </Tap>
        }
        eyebrow={<span className="ph-notebook-eyebrow" data-tone={pageTone(page)}>{pageIcon(page, 18)} {memoryPage ? "Memory" : "Notebook"}</span>}
        hero={<p className="ph-hero-hint">{hint}</p>}
      >
        <div className="ph-stack">
          {memoryPage && (
            <div className="ph-view-chips" role="tablist" aria-label="Memory roles">
              {VIEWS.map((option) => {
                const total = memories.filter((memory) => inView(memory, option.value)).length;
                const on = option.value === view;
                return (
                  <Tap
                    key={option.value}
                    role="tab"
                    aria-selected={on}
                    className="ph-view-chip"
                    data-on={on}
                    data-tone={VIEW_TONE[option.value] ?? "lime"}
                    feel="select"
                    squish={0.92}
                    onClick={() => setView(option.value)}
                  >
                    {option.label}
                    {total > 0 && <span>{total}</span>}
                  </Tap>
                );
              })}
            </div>
          )}
          <label className="ph-search ph-search-static">
            <MagnifyingGlass size={18} weight="bold" />
            <input aria-label="Search this page" placeholder={`Search ${page.title.toLowerCase()}`} value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={16} weight="bold" />
              </button>
            )}
          </label>

          <AnimatePresence mode="popLayout" initial={false}>
            {count ? (
              <motion.ul key={`${page.uid}-${view}`} className="ph-cards" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                {memoryPage
                  ? shownMemories.map((memory, index) => <MemoryCard key={memory.uid ?? memory.id} memory={memory} index={index} onOpen={() => setEditingMemory(memory)} />)
                  : shownIdeas.map((idea, index) => <IdeaCard key={idea.uid ?? idea.id} idea={idea} index={index} onOpen={() => setEditingNote(idea)} />)}
              </motion.ul>
            ) : (
              <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <Empty
                  icon={<NotePencil size={36} weight="duotone" />}
                  title={needle ? "Nothing matches" : view === "REVIEW" ? "Nothing to review" : "A little room for your next thought"}
                  hint={needle ? "Try another word." : temporary ? "Add a rule and choose when JARVIS should forget it." : "Tap + or ask JARVIS to save something here."}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </Screen>

      <Tap
        className="ph-fab"
        aria-label={memoryPage ? "Add a memory" : "Add a note"}
        feel="heavy"
        squish={0.88}
        onClick={() => (memoryPage ? setEditingMemory({ new: true, temporary, view }) : setEditingNote({ new: true, page: page.uid }))}
      >
        <Plus size={26} weight="bold" />
      </Tap>

      <MemorySheet target={editingMemory} onClose={() => setEditingMemory(null)} />
      <NoteSheet target={editingNote} onClose={() => setEditingNote(null)} pages={pages} />
      <PageSheet target={editingPage} onClose={() => setEditingPage(null)} pages={pages} onSaved={setRenamed} onDeleted={pop} />
    </>
  );
}

function MemoryCard({ memory, index, onOpen }: { memory: Memory; index: number; onOpen: () => void }) {
  const tone = MEMORY_TONE[memory.memory_type];
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 30, delay: Math.min(index, 8) * 0.035 }}
    >
      <Tap className="ph-memory" data-tone={tone} data-review={memory.memory_status === "CANDIDATE"} onClick={onOpen} squish={0.97} aria-label={`Edit ${memory.key_concept}`}>
        <span className="ph-memory-head">
          <Chip tone={tone}>{MEMORY_LABEL[memory.memory_type]}</Chip>
          {memory.memory_status === "CANDIDATE" && <Sticker tone="amber" tilt={3}>REVIEW</Sticker>}
          {memory.pinned && <span className="ph-memory-pin" aria-label="Pinned"><PushPin size={15} weight="fill" /></span>}
        </span>
        <strong>{memory.key_concept}</strong>
        <p>{memory.content}</p>
        <span className="ph-memory-foot">
          <span className="ph-meter" aria-label={`${Math.round(memory.confidence * 100)}% confidence`}>
            <span style={{ transform: `scaleX(${Math.max(0.04, Math.min(1, memory.confidence))})` }} />
          </span>
          <small>{Math.round(memory.confidence * 100)}% sure</small>
          {memory.expires_at && (
            <Chip tone="mint" icon={<Clock size={12} weight="bold" />}>until {when(memory.expires_at)}</Chip>
          )}
        </span>
      </Tap>
    </motion.li>
  );
}

function IdeaCard({ idea, index, onOpen }: { idea: Idea; index: number; onOpen: () => void }) {
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 30, delay: Math.min(index, 8) * 0.035 }}
    >
      <Tap className="ph-idea" onClick={onOpen} squish={0.97} aria-label={`Edit ${idea.title}`}>
        <strong>{idea.title}</strong>
        <p>{idea.description || "Add a few details…"}</p>
      </Tap>
    </motion.li>
  );
}
