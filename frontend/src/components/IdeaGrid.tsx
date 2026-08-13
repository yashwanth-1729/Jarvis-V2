"use client";

import { Brain, Lightbulb } from "lucide-react";
import * as React from "react";

import { Badge, IdeaStatusBadge, MemoryBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDateTime, splitTags } from "@/lib/utils";
import type { Idea, Memory } from "@/types";

function SectionHeading({
  icon,
  label,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <div className="mb-3 flex items-baseline gap-2.5">
      <span className="translate-y-[2px] text-ink-faint">{icon}</span>
      <h3 className="font-display text-md font-semibold tracking-tight text-ink">
        {label}
      </h3>
      <span className="tnum font-mono text-2xs text-ink-faint">
        {String(count).padStart(2, "0")}
      </span>
      <span aria-hidden className="ml-1 h-px flex-1 bg-line" />
    </div>
  );
}

export function IdeaGrid({ ideas, memories }: { ideas: Idea[]; memories: Memory[] }) {
  if (!ideas.length && !memories.length) {
    return (
      <div className="p-5">
        <EmptyState
          icon={<Lightbulb className="h-4 w-4" />}
          title="No ideas or notes yet"
          hint='Try: "Remember that I prefer morning meetings" or "Save an idea: a CLI for tracking reading"'
        />
      </div>
    );
  }

  return (
    <ScrollArea className="mask-fade-y h-full min-h-0 px-5 py-4">
      <div className="space-y-8">
        {ideas.length > 0 && (
          <section>
            <SectionHeading
              icon={<Lightbulb className="h-3.5 w-3.5" strokeWidth={1.75} />}
              label="Ideas & notes"
              count={ideas.length}
            />

            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 2xl:grid-cols-3">
              {ideas.map((idea) => {
                const tags = splitTags(idea.tags);
                return (
                  <article
                    key={idea.id}
                    className="flex flex-col bg-surface-1 p-4 transition-colors duration-150 hover:bg-surface-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h4 className="break-words text-base font-medium leading-snug text-ink">
                        {idea.title}
                      </h4>
                      <IdeaStatusBadge status={idea.status} />
                    </div>

                    {idea.description && (
                      <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-dim">
                        {idea.description}
                      </p>
                    )}

                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                      {tags.map((tag) => (
                        <Badge key={tag} tone="outline">
                          {tag}
                        </Badge>
                      ))}
                      <span className="tnum ml-auto font-mono text-2xs text-ink-faint">
                        {formatDateTime(idea.updated_at)}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {memories.length > 0 && (
          <section>
            <SectionHeading
              icon={<Brain className="h-3.5 w-3.5" strokeWidth={1.75} />}
              label="Long-term memory"
              count={memories.length}
            />

            {/* Memory reads as a keyed record, so it gets a definition-list
                treatment rather than the card grid used for ideas. */}
            <dl className="overflow-hidden rounded-lg border border-line">
              {memories.map((memory) => (
                <div
                  key={memory.id}
                  className="grid grid-cols-1 gap-1 border-b border-line bg-surface-1 px-4 py-3 last:border-0 transition-colors duration-150 hover:bg-surface-2 sm:grid-cols-[minmax(140px,220px)_1fr] sm:gap-5"
                >
                  <dt className="flex items-start justify-between gap-2 sm:flex-col sm:justify-start sm:gap-1.5">
                    <span className="break-words text-base font-medium leading-snug text-ink">
                      {memory.key_concept}
                    </span>
                    <MemoryBadge category={memory.category} />
                  </dt>
                  <dd className="min-w-0">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-dim">
                      {memory.content}
                    </p>
                    <span className="tnum mt-1.5 block font-mono text-2xs text-ink-faint">
                      {formatDateTime(memory.updated_at)}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}
