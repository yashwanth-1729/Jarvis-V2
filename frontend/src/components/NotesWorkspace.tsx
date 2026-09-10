"use client";

import * as React from "react";
import { BookOpen, Brain, Clock3, FileText, Pencil, Pin, Plus, Search, X } from "lucide-react";
import { RecordEditor, type RecordValues } from "@/components/RecordEditor";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { createIdea, createMemory, deleteIdea, deleteMemory, deleteNotePage, saveNotePage, updateIdea, updateMemory, type RecordsMode } from "@/lib/records";
import { transitionUi } from "@/lib/uiMotion";
import { localIso } from "@/lib/schedulePolicy";
import { formatDateTime } from "@/lib/utils";
import type { Idea, Memory, NotePage } from "@/types";

const DEFAULT_PAGES: NotePage[] = [
  {uid: "notes-long-term", title: "Long-term memory", kind: "LONG_TERM", created_at: "", updated_at: ""},
  {uid: "notes-temporary", title: "Temporary memory", kind: "TEMPORARY", created_at: "", updated_at: ""},
  {uid: "notes-other", title: "Other", kind: "OTHER", created_at: "", updated_at: ""},
];
type Fields = React.ComponentProps<typeof RecordEditor>["fields"];
type MemoryView = "ALL" | "SEMANTIC" | "PROCEDURAL" | "EPISODIC" | "PROSPECTIVE" | "REFLECTIVE" | "REVIEW";
const MEMORY_VIEWS: Array<{value: MemoryView; label: string}> = [
  {value: "ALL", label: "Active"},
  {value: "SEMANTIC", label: "Knowledge"},
  {value: "PROCEDURAL", label: "Rules"},
  {value: "EPISODIC", label: "Episodes"},
  {value: "PROSPECTIVE", label: "Goals"},
  {value: "REFLECTIVE", label: "Patterns"},
  {value: "REVIEW", label: "Review"},
];
const text = (values: RecordValues, key: string) => String(values[key] ?? "").trim();

export function NotesWorkspace({ideas, memories, pages = [], mode, onChanged}: {
  ideas: Idea[]; memories: Memory[]; pages?: NotePage[]; mode: RecordsMode; onChanged: () => void;
}) {
  const [selected, setSelected] = React.useState("notes-long-term");
  const [query, setQuery] = React.useState("");
  const [editingPage, setEditingPage] = React.useState<NotePage | "new" | null>(null);
  const [savedPage, setSavedPage] = React.useState<NotePage | null>(null);
  const [editingIdea, setEditingIdea] = React.useState<Idea | "new" | null>(null);
  const [editingMemory, setEditingMemory] = React.useState<Memory | "new" | null>(null);
  const [memoryView, setMemoryView] = React.useState<MemoryView>("ALL");
  React.useEffect(() => {
    if (savedPage && pages.some(page => page.uid === savedPage.uid && page.updated_at >= savedPage.updated_at)) setSavedPage(null);
  }, [pages, savedPage]);
  const allPages = React.useMemo(() => {
    const all = new Map(DEFAULT_PAGES.map(page => [page.uid, page]));
    for (const page of pages) all.set(page.uid, page);
    if (savedPage) all.set(savedPage.uid, savedPage);
    return [...all.values()];
  }, [pages, savedPage]);
  const active = allPages.find(page => page.uid === selected) ?? allPages[0];
  const isMemory = active.kind === "LONG_TERM" || active.kind === "TEMPORARY";
  const temporary = active.kind === "TEMPORARY";
  const needle = query.toLocaleLowerCase().trim();
  const pageMemories = memories.filter(memory => {
    if (memoryView === "REVIEW") return memory.memory_status === "CANDIDATE";
    if (memory.memory_status !== "ACTIVE" || Boolean(memory.expires_at) !== temporary) return false;
    return memoryView === "ALL" || memory.memory_type === memoryView;
  });
  const pageIdeas = ideas.filter(idea => active.kind === "OTHER" ? !idea.page_uid || idea.page_uid === active.uid || !allPages.some(page => page.uid === idea.page_uid) : idea.page_uid === active.uid);
  const foundMemories = pageMemories.filter(memory => `${memory.key_concept} ${memory.content}`.toLocaleLowerCase().includes(needle));
  const foundIdeas = pageIdeas.filter(idea => `${idea.title} ${idea.description}`.toLocaleLowerCase().includes(needle));
  const Icon = temporary ? Clock3 : isMemory ? Brain : BookOpen;
  const count = isMemory ? pageMemories.length : pageIdeas.length;
  const noteFields: Fields = [
    {kind: "text", name: "title", label: "Title", required: true},
    {kind: "textarea", name: "description", label: "Note", rows: 7},
    {kind: "select", name: "page_uid", label: "Page", options: allPages.filter(page => page.kind === "OTHER" || page.kind === "CUSTOM").map(page => ({value: page.uid, label: page.title}))},
  ];
  const memoryFields: Fields = [
    {kind: "text", name: "key_concept", label: "Title", required: true},
    {kind: "textarea", name: "content", label: "What should JARVIS remember?", required: true, rows: 6},
    {kind: "select", name: "memory_type", label: "Memory role", options: [
      {value: "SEMANTIC", label: "Knowledge or preference"},
      {value: "PROCEDURAL", label: "Rule or procedure"},
      {value: "EPISODIC", label: "Event or experience"},
      {value: "PROSPECTIVE", label: "Goal or intention"},
      {value: "WORKING", label: "Working context"},
      {value: "REFLECTIVE", label: "Learned pattern"},
    ]},
    {kind: "select", name: "memory_status", label: "State", options: [{value: "ACTIVE", label: "Active"}, {value: "CANDIDATE", label: "Review first"}, {value: "ARCHIVED", label: "Archived"}]},
    {kind: "select", name: "importance", label: "Importance", options: [{value: "0.4", label: "Useful"}, {value: "0.65", label: "Important"}, {value: "0.85", label: "Critical"}]},
    {kind: "select", name: "pinned", label: "Always consider", options: [{value: "false", label: "Only when relevant"}, {value: "true", label: "Pinned"}]},
    {kind: "select", name: "duration", label: "Keep this memory", options: [{value: "permanent", label: "Until I delete it"}, {value: "temporary", label: "Until a date"}]},
    {kind: "datetime", name: "expires_at", label: "Forget after", visibleWhen: {field: "duration", values: ["temporary"]}},
  ];
  const memoryInitial: RecordValues = editingMemory && editingMemory !== "new" ? {
    key_concept: editingMemory.key_concept,
    content: editingMemory.content,
    memory_type: editingMemory.memory_type,
    memory_status: editingMemory.memory_status,
    importance: String(editingMemory.importance),
    pinned: String(editingMemory.pinned),
    duration: editingMemory.expires_at ? "temporary" : "permanent",
    expires_at: editingMemory.expires_at,
  } : {
    memory_type: temporary ? "PROCEDURAL" : memoryView !== "ALL" && memoryView !== "REVIEW" ? memoryView : "SEMANTIC",
    memory_status: "ACTIVE",
    importance: "0.65",
    pinned: "false",
    duration: temporary ? "temporary" : "permanent",
  };

  return <div className="notes-workspace">
    <div className="notes-page-toolbar">
      <nav className="notes-pages" aria-label="Notes pages">
        {allPages.map(page => <button key={page.uid} type="button" aria-current={page.uid === active.uid ? "page" : undefined}
          title={page.title} onClick={() => transitionUi(() => {setSelected(page.uid); setQuery("");})}>{page.title}</button>)}
      </nav>
      <Button size="sm" variant="ghost" onClick={() => setEditingPage("new")} aria-label="Add a Notes page"><Plus size={17} /> New page</Button>
    </div>
    <section className="notes-page-content" key={active.uid} aria-label={active.title}>
      <div className="notes-page-heading">
        <span className="notes-page-icon"><Icon size={23} strokeWidth={1.5} /></span>
        <div><span className="notes-page-count">{count} {count === 1 ? "entry" : "entries"}</span><h2>{active.title}</h2></div>
        <button className="notes-rename" aria-label={`Rename ${active.title}`} onClick={() => setEditingPage(active)}><Pencil size={17} /><span>Rename</span></button>
      </div>
      <p className="notes-page-hint">{temporary ? "Rules for right now. Forgotten automatically when their time is up." : isMemory ? "The things you want JARVIS to remember, until you delete them." : "A place for ideas worth keeping. Yours to fill, revisit and refine."}</p>
      {isMemory && <nav className="memory-views" aria-label="Memory roles">
        {MEMORY_VIEWS.map(view => <button key={view.value} type="button" aria-pressed={memoryView === view.value}
          onClick={() => transitionUi(() => setMemoryView(view.value))}>{view.label}</button>)}
      </nav>}
      <div className="notes-actions">
        <label className="search-field"><Search size={17} aria-hidden /><input aria-label="Search this page" placeholder="Find something on this page…" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear notes search" onClick={() => setQuery("")}><X size={16} /></button>}</label>
        <Button variant="primary" onClick={() => isMemory ? setEditingMemory("new") : setEditingIdea("new")}><Plus size={17} />{isMemory ? "Add memory" : "Add note"}</Button>
      </div>
      <div className="notes-cards">
        {isMemory ? foundMemories.map(memory => <button type="button" className="note-card" data-memory-status={memory.memory_status} key={memory.uid ?? memory.id} onClick={() => setEditingMemory(memory)} aria-label={`Edit ${memory.key_concept}`}>
          <div className="note-card-title"><h3>{memory.key_concept}</h3><Pencil size={15} /></div>
          <p>{memory.content}</p>
          <span className="note-card-meta"><span>{memory.memory_status === "CANDIDATE" ? "Needs review" : memory.memory_type.toLocaleLowerCase()}</span>{memory.pinned && <span><Pin size={12} />Pinned</span>}<span>{Math.round(memory.confidence * 100)}% confidence</span></span>
          {memory.expires_at && <span className="note-expiry"><Clock3 size={13} />Until {formatDateTime(memory.expires_at)}</span>}
        </button>) : foundIdeas.map(idea => <button type="button" className="note-card" key={idea.uid ?? idea.id} onClick={() => setEditingIdea(idea)} aria-label={`Edit ${idea.title}`}>
          <div className="note-card-title"><h3>{idea.title}</h3><Pencil size={15} /></div><p>{idea.description || "Add a few details…"}</p>
        </button>)}
      </div>
      {!(isMemory ? foundMemories.length : foundIdeas.length) && <EmptyState icon={<FileText size={24} />} title={query ? "Nothing matches yet" : "A little room for your next thought."} hint={query ? "Try another word, or clear the search." : temporary ? "Add a rule and choose when JARVIS should forget it." : "Use Add above, or ask JARVIS to save something here."} />}
    </section>
    <RecordEditor open={editingPage !== null} title={editingPage === "new" ? "Create a page" : "Rename page"}
      fields={[{kind: "text", name: "title", label: "Page name", required: true, placeholder: "Startup ideas"}]}
      initial={{title: editingPage && editingPage !== "new" ? editingPage.title : ""}} onClose={() => setEditingPage(null)}
      onSave={async values => {
        const title = text(values, "title");
        if (!title || title.length > 80) throw new Error("Use a page name between 1 and 80 characters.");
        if (allPages.some(page => page.title.toLocaleLowerCase() === title.toLocaleLowerCase() && (editingPage === "new" || page.uid !== editingPage?.uid))) throw new Error("A page already has that name.");
        const page = await saveNotePage(mode, editingPage && editingPage !== "new" ? {...editingPage, title} : {title, kind: "CUSTOM"});
        setSavedPage(page); setSelected(page.uid); onChanged();
      }} onDelete={editingPage && editingPage !== "new" && editingPage.kind === "CUSTOM" ? async () => {
        await deleteNotePage(mode, editingPage);
        setSelected("notes-other"); setSavedPage(null); onChanged();
      } : undefined} />
    <RecordEditor open={editingIdea !== null} title={editingIdea === "new" ? "New note" : "Edit note"} fields={noteFields}
      initial={editingIdea && editingIdea !== "new" ? {...editingIdea, page_uid: editingIdea.page_uid || "notes-other"} : {page_uid: active.uid}}
      onClose={() => setEditingIdea(null)} onSave={async values => {
        const draft = {title: text(values, "title"), description: text(values, "description"), page_uid: text(values, "page_uid") || null};
        if (editingIdea === "new") await createIdea(mode, draft);
        else if (editingIdea) await updateIdea(mode, editingIdea.uid ?? editingIdea.id, draft);
        onChanged();
      }} onDelete={editingIdea && editingIdea !== "new" ? async () => {await deleteIdea(mode, editingIdea.uid ?? editingIdea.id); onChanged();} : undefined} />
    <RecordEditor open={editingMemory !== null} title={editingMemory === "new" ? "New memory" : "Edit memory"} fields={memoryFields}
      initial={memoryInitial}
      onClose={() => setEditingMemory(null)} onSave={async values => {
        const memory_type = text(values, "memory_type") as Memory["memory_type"];
        let expires_at = values.duration === "temporary" ? text(values, "expires_at") : null;
        if (memory_type === "WORKING" && !expires_at) expires_at = localIso(new Date(Date.now() + 8 * 60 * 60 * 1000));
        if (values.duration === "temporary" && (!expires_at || !(new Date(expires_at).getTime() > Date.now()))) throw new Error("Choose a future date and time to forget this memory.");
        const draft = {
          key_concept: text(values, "key_concept"),
          content: text(values, "content"),
          expires_at,
          memory_type,
          memory_status: text(values, "memory_status") as Memory["memory_status"],
          importance: Number(values.importance ?? 0.65),
          pinned: String(values.pinned) === "true",
        };
        if (editingMemory === "new") await createMemory(mode, draft);
        else if (editingMemory) await updateMemory(mode, editingMemory.uid ?? editingMemory.id, draft);
        onChanged();
      }} onDelete={editingMemory && editingMemory !== "new" ? async () => {await deleteMemory(mode, editingMemory.uid ?? editingMemory.id); onChanged();} : undefined} />
  </div>;
}
