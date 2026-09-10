"use client";

/**
 * Search results as things you can act on, not a list of blue links.
 *
 * Deliberately not a search engine imitation. The results are already filtered
 * by JARVIS having asked a specific question, so the useful controls are the
 * ones that continue the work: open the page, or have JARVIS read it and tell
 * you what it says. The second is the one that matters — reading a page and
 * summarising it is the thing a search engine cannot do for you.
 *
 * "Read this" sends a message back into the conversation, which is what makes
 * this an instrument rather than a display: an interaction here triggers the
 * next tool call.
 */

import { Globe, Sparkles } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import type { SearchResult } from "@/lib/surfaces";
import { cn } from "@/lib/utils";

/** An encyclopedia entry, when the search found a clear one. */
export interface Knowledge {
  title: string;
  description?: string | null;
  extract: string;
  image?: string | null;
  url?: string | null;
}

interface SearchSurfaceProps {
  query: string;
  results: SearchResult[];
  knowledge?: Knowledge | null;
  /** Fetched page, when the tool call was a read rather than a search. */
  fetched?: { title: string; url: string } | null;
  /** Sends a follow-up into the conversation. */
  onAsk: (message: string) => void;
}

export function SearchSurface({
  query,
  results,
  knowledge,
  fetched,
  onAsk,
}: SearchSurfaceProps) {

  /**
   * The answer, assembled — not five places the answer might be.
   *
   * A row of link previews is what a search engine shows because it does not
   * know which one you want. By this point JARVIS has asked a specific
   * question, so showing the same list back is passing the work to the reader:
   * five truncated sentences, each cut mid-word, and they still have to piece
   * the facts together themselves.
   *
   * The encyclopedia entry is preferred when there is one. Failing that, the
   * best snippet is promoted to be the body — search snippets for a factual
   * question are usually lifted from an encyclopedia anyway — and the
   * remaining links are demoted to a quiet list of sources underneath.
   */
  const encyclopedic = results.find((r) =>
    /wikipedia|britannica|bharatpedia|wikiwand/i.test(r.domain),
  );
  const lead = knowledge
    ? {
        title: knowledge.title,
        description: knowledge.description ?? null,
        body: knowledge.extract,
        source: knowledge.url ? "wikipedia.org" : null,
        url: knowledge.url ?? null,
        image: knowledge.image ?? null,
      }
    : (() => {
        const best = encyclopedic ?? results[0];
        if (!best) return null;
        return {
          title: best.title.replace(/\s*[-–—|]\s*[^-–—|]*$/, "").trim() || best.title,
          description: null,
          body: best.snippet,
          source: best.domain,
          url: best.url,
          image: null,
        };
      })();

  const sources = results.filter((r) => r.url !== lead?.url).slice(0, 4);

  if (fetched && results.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3 pt-1">
        <p className="font-mono text-2xs uppercase tracking-[0.24em] text-ink-dim">
          Read
        </p>
        <h3 className="font-display text-xl font-semibold leading-tight text-ink">
          {fetched.title || fetched.url}
        </h3>
        <a
          href={fetched.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-2xs text-accent hover:underline"
        >
          <Globe className="h-3 w-3" />
          {fetched.url}
        </a>
        <p className="mt-2 text-sm text-ink-dim">
          JARVIS has the page contents and can answer from them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 pt-1">
      {/* The question, small — it is context, not the content. */}
      <p className="shrink-0 font-mono text-2xs uppercase tracking-[0.24em] text-ink-dim">
        {query}
      </p>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        {lead ? (
          <>
            <div className="flex items-start gap-3">
              {/* Portrait, when the source carried one. Its own block rather
                  than a thumbnail glued to a row: a face is the fastest way to
                  confirm you are being told about the right person. */}
              {lead.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={lead.image}
                  alt=""
                  className="h-24 w-24 shrink-0 rounded-sm object-cover ring-1 ring-[color:hsl(var(--accent)/0.35)]"
                />
              )}
              <div className="min-w-0">
                <h3 className="font-display text-xl font-semibold leading-tight text-ink">
                  {lead.title}
                </h3>
                {lead.description && (
                  <p className="mt-0.5 text-sm text-accent/90">{lead.description}</p>
                )}
              </div>
            </div>

            {/* The actual answer, as prose. */}
            <p className="text-sm leading-relaxed text-ink">{lead.body}</p>

            {lead.url && (
              <a
                href={lead.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.16em] text-ink-faint hover:text-accent"
              >
                <Globe className="h-3 w-3" />
                {lead.source}
              </a>
            )}

            {/* Everything else, demoted to what it is: other places that say
                the same thing. One line each, no snippets competing with the
                answer above them. */}
            {sources.length > 0 && (
              <div className="border-t border-line/60 pt-3">
                <p className="mb-2 font-mono text-[0.6rem] uppercase tracking-[0.22em] text-ink-faint">
                  Also found
                </p>
                <ul className="space-y-1.5">
                  {sources.map((result) => (
                    <li key={result.url}>
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-baseline gap-2 text-2xs hover:text-accent"
                      >
                        <span className="truncate text-ink-dim">{result.title}</span>
                        <span className="ml-auto shrink-0 font-mono text-ink-faint">
                          {result.domain}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onAsk(`Tell me more about ${lead.title}`)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Tell me more
            </Button>
          </>
        ) : (
          <p className="text-sm text-ink-dim">Nothing found for that.</p>
        )}
      </div>
    </div>
  );
}
