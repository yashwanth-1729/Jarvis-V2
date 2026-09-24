"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ArrowRight, Brain, Hourglass, Lightbulb, Notebook, Plus, PushPin, Sparkle } from "@phosphor-icons/react";

import type { NotePage } from "@/types";
import { allPages, MEMORY_LABEL, MEMORY_TONE, pageCount, pageTone } from "../lib/derive";
import { usePhone } from "../PhoneContext";
import { PageSheet, type PageTarget } from "../sheets/NoteSheets";
import { Chip, SectionHead, Skeleton, Sticker } from "../ui/Bits";
import { Screen } from "../ui/Screen";
import { Tap } from "../ui/Tap";
import { Num } from "../ui/Num";

export function pageIcon(page: NotePage, size = 30) {
  if (page.kind === "LONG_TERM") return <Brain size={size} weight="duotone" />;
  if (page.kind === "TEMPORARY") return <Hourglass size={size} weight="duotone" />;
  if (page.kind === "OTHER") return <Lightbulb size={size} weight="duotone" />;
  return <Notebook size={size} weight="duotone" />;
}

export function MemoryScreen() {
  const { app, push } = usePhone();
  const [editingPage, setEditingPage] = React.useState<PageTarget>(null);
  // A page created from the sheet opens once the sheet has closed, so the
  // sheet's history entry is rewound before the notebook's is pushed.
  const [created, setCreated] = React.useState<NotePage | null>(null);
  React.useEffect(() => {
    if (editingPage !== null || !created) return;
    push({ kind: "notebook", uid: created.uid, page: created });
    setCreated(null);
  }, [editingPage, created, push]);
  const state = app.state;
  const pages = allPages(state?.note_pages);
  const memories = state?.memories ?? [];
  const ideas = state?.ideas ?? [];
  const active = memories.filter((memory) => memory.memory_status === "ACTIVE");
  const review = memories.filter((memory) => memory.memory_status === "CANDIDATE");
  const recent = [...active].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 3);

  return (
    <Screen
      title="Memory"
      tone="lilac"
      eyebrow={<><Num value={active.length} /> things JARVIS knows · <Num value={ideas.length} /> notes</>}
      actions={
        <Tap className="ph-icon-btn ph-icon-btn-accent" aria-label="New page" onClick={() => setEditingPage("new")} feel="heavy">
          <Plus size={22} weight="bold" />
        </Tap>
      }
    >
      <div className="ph-stack">
        {!state ? (
          <Skeleton rows={4} />
        ) : (
          <>
            {review.length > 0 && (
              <Tap className="ph-review" onClick={() => push({ kind: "notebook", uid: "notes-long-term", view: "REVIEW" })} squish={0.97}>
                <Sparkle size={24} weight="fill" />
                <span>
                  <strong><Num value={review.length} /> {review.length === 1 ? "memory needs" : "memories need"} your call</strong>
                  <small>JARVIS picked these up. Keep or bin them.</small>
                </span>
                <ArrowRight size={18} weight="bold" />
              </Tap>
            )}

            <div className="ph-books">
              {pages.map((page, index) => (
                <motion.div
                  key={page.uid}
                  initial={{ opacity: 0, y: 18, rotate: index % 2 ? 2 : -2 }}
                  animate={{ opacity: 1, y: 0, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 320, damping: 24, delay: index * 0.05 }}
                >
                  <Tap className="ph-book" data-tone={pageTone(page)} onClick={() => push({ kind: "notebook", uid: page.uid, page })} squish={0.94}>
                    <span className="ph-book-icon">{pageIcon(page)}</span>
                    <span className="ph-book-count"><Num value={pageCount(page, ideas, memories, pages)} /></span>
                    <strong className="ph-book-title">{page.title}</strong>
                    <span className="ph-book-kind">{page.kind === "LONG_TERM" || page.kind === "TEMPORARY" ? "memory" : "notebook"}</span>
                  </Tap>
                </motion.div>
              ))}
              <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 320, damping: 24, delay: pages.length * 0.05 }}>
                <Tap className="ph-book ph-book-new" onClick={() => setEditingPage("new")} squish={0.94}>
                  <Plus size={30} weight="bold" />
                  <strong className="ph-book-title">New page</strong>
                </Tap>
              </motion.div>
            </div>

            {recent.length > 0 && (
              <section className="ph-section">
                <SectionHead title="Fresh in memory" />
                <ul className="ph-recent">
                  {recent.map((memory, index) => (
                    <motion.li
                      key={memory.uid ?? memory.id}
                      initial={{ opacity: 0, x: 16 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ type: "spring", stiffness: 360, damping: 30, delay: 0.1 + index * 0.05 }}
                    >
                      <Tap className="ph-recent-card" data-tone={MEMORY_TONE[memory.memory_type]} squish={0.97} onClick={() => push({ kind: "notebook", uid: memory.expires_at ? "notes-temporary" : "notes-long-term" })}>
                        <span className="ph-recent-head">
                          <Chip tone={MEMORY_TONE[memory.memory_type]}>{MEMORY_LABEL[memory.memory_type]}</Chip>
                          {memory.pinned && <PushPin size={14} weight="fill" />}
                        </span>
                        <strong>{memory.key_concept}</strong>
                        <p>{memory.content}</p>
                      </Tap>
                    </motion.li>
                  ))}
                </ul>
              </section>
            )}
            {!memories.length && !ideas.length && (
              <p className="ph-note-hint">
                <Sticker tone="lilac" tilt={-2}>TIP</Sticker> Say “remember that I prefer morning classes” and it lands here.
              </p>
            )}
          </>
        )}
      </div>
      <PageSheet
        target={editingPage}
        onClose={() => setEditingPage(null)}
        pages={pages}
        onSaved={setCreated}
      />
    </Screen>
  );
}
