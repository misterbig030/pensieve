"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  BookOpen,
  Check,
  CircleAlert,
  CirclePlay,
  Code,
  FileText,
  FlaskConical,
  GitBranch,
  GraduationCap,
  RotateCw,
  ShieldCheck,
  StickyNote,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DroppedMaterial, ResearchNotice } from "@/lib/ai/research/events";
import { KIND_LABEL, KIND_ORDER, hostOf, type Material, type MaterialKind } from "@/lib/schemas/material";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<MaterialKind, ComponentType<{ className?: string; strokeWidth?: number }>> = {
  book: BookOpen,
  course: GraduationCap,
  video: CirclePlay,
  docs: Code,
  essay: FileText,
  paper: FlaskConical,
  repo: GitBranch,
  tool: Wrench,
  note: StickyNote,
};

export interface MaterialUse {
  label: string;
  role: "covers" | "assigned";
}

export interface MaterialsListProps {
  topic: string;
  materials: Material[];
  /** Candidates the gate refused, shown struck through with the reason. */
  dropped?: DroppedMaterial[];
  notice?: ResearchNotice;
  /** Where each material is used, for the remove confirmation. Omit with `onRemove` for a read-only list. */
  usesOf?: (id: string) => MaterialUse[];
  onRemove?: (id: string) => void;
  /** Offered only before the plan is confirmed, with the "unavailable" notice. */
  onResearchAgain?: () => void;
  /** Rows shown before "Show all". */
  initialShown?: number;
}

/** The plan-level materials list: the backbone pinned first, the rest grouped by kind. */
export function MaterialsList(props: MaterialsListProps) {
  const { materials, dropped = [], notice, initialShown = 6 } = props;
  const [showAll, setShowAll] = useState(false);
  const [removing, setRemoving] = useState<Material | null>(null);

  const backbone = materials.find((m) => m.backbone) ?? null;
  const rest = materials.filter((m) => m !== backbone);
  const ordered = KIND_ORDER.flatMap((kind) => rest.filter((m) => m.kind === kind));
  const shown = showAll ? ordered : ordered.slice(0, initialShown);
  const researched = materials.filter((m) => m.origin === "research").length;
  const yours = materials.length - researched;

  return (
    <div className="flex flex-col gap-3">
      {notice && <ResearchNoticeBanner notice={notice} topic={props.topic} researched={researched} hasBackbone={!!backbone} onResearchAgain={props.onResearchAgain} />}

      {materials.length > 0 && (
        <section aria-labelledby="materials-h" className="flex flex-col gap-3.5 rounded-[28px] bg-secondary px-[22px] pt-5 pb-[18px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 id="materials-h" className="m-0 font-heading text-lg font-normal">
              Materials
            </h2>
            <span className="inline-flex items-center gap-[5px] rounded-full bg-accent-2-200 px-[9px] py-[3px] text-[11px] font-semibold text-accent-2-800">
              <Check className="size-3" strokeWidth={3} />
              {yours === 0 ? `${researched} · all opened and checked` : researched === 0 ? `${yours} yours` : `${researched} checked · ${yours} yours`}
            </span>
            <span className="ml-auto text-[12.5px] text-muted-foreground max-[640px]:ml-0 max-[640px]:basis-full">Gather these up front. Each week assigns a slice.</span>
          </div>

          {backbone ? (
            <BackboneCard material={backbone} onRemove={props.onRemove ? () => setRemoving(backbone) : undefined} />
          ) : (
            <span className="text-[13px] text-muted-foreground">No backbone: units draw on the materials below directly.</span>
          )}

          <div className="flex flex-col gap-0.5">
            {shown.map((m, i) => (
              <div key={m.id} className="contents">
                {(i === 0 || shown[i - 1].kind !== m.kind) && (
                  <span className="px-1 pt-1.5 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">{KIND_LABEL[m.kind]}</span>
                )}
                <MaterialRow material={m} onRemove={props.onRemove ? () => setRemoving(m) : undefined} />
              </div>
            ))}
          </div>

          {ordered.length > initialShown && (
            <Button variant="secondary" size="sm" className="min-h-10 self-start border border-border bg-transparent px-4 text-[12.5px]" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${materials.length}`}
            </Button>
          )}

          {dropped.length > 0 && (
            <details className="group text-[12.5px]">
              <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
                {dropped.length} more considered and left out
              </summary>
              <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {dropped.map((d, i) => (
                  <li key={`${d.title}-${i}`} className="flex min-w-0 items-baseline gap-2 text-muted-foreground">
                    <X className="size-3 shrink-0 translate-y-0.5" strokeWidth={2.75} />
                    <span className="min-w-0">
                      <span className="line-through">{d.title}</span> · {d.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {removing && props.onRemove && (
        <RemoveDialog
          material={removing}
          uses={props.usesOf?.(removing.id) ?? []}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            props.onRemove!(removing.id);
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

function byline(m: Material, withKind = false): string {
  return [m.author, hostOf(m.url) && m.kind !== "note" && !m.author ? hostOf(m.url) : null, m.year, withKind ? m.kind : null].filter(Boolean).join(" · ");
}

function titleLink(m: Material, className?: string) {
  if (m.type === "note" || m.type === "file") return <span className={className}>{m.title}</span>;
  return (
    <a href={m.url} target="_blank" rel="noreferrer" className={cn("hover:text-accent-700 hover:underline", className)}>
      {m.title}
    </a>
  );
}

function BackboneCard({ material: m, onRemove }: { material: Material; onRemove?: () => void }) {
  return (
    <div className="flex gap-4 rounded-[20px] border-[1.5px] border-accent-2-700 bg-background px-[18px] py-4 max-[640px]:flex-col max-[640px]:gap-3">
      <div className="flex h-[72px] w-14 shrink-0 items-center justify-center rounded-lg bg-accent-2-800 max-[640px]:hidden">
        <BookOpen className="size-6 text-accent-2-100" strokeWidth={2.25} />
      </div>
      <div className="flex min-w-0 grow flex-col gap-[5px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex rounded-full bg-accent-2-800 px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-accent-2-100 uppercase">Backbone</span>
          {titleLink(m, "font-heading text-[17px]")}
          {m.origin === "learner" && <YoursBadge />}
        </div>
        <span className="text-[12.5px] text-muted-foreground">{byline(m, true)}</span>
        {m.why && <p className="m-0 text-[13px] leading-normal text-neutral-800">{m.why}</p>}
      </div>
      <div className="flex shrink-0 items-start gap-1 self-start">
        <VerifiedButton material={m} prominent />
        {onRemove && <RemoveButton title={m.title} onClick={onRemove} />}
      </div>
    </div>
  );
}

function MaterialRow({ material: m, onRemove }: { material: Material; onRemove?: () => void }) {
  const Icon = KIND_ICON[m.kind];
  const meta = byline(m);
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-start gap-3 px-1 py-2 text-[13px] max-[640px]:grid-cols-[22px_minmax(0,1fr)] max-[640px]:gap-y-1">
      <Icon className="mt-0.5 size-4 text-muted-foreground" strokeWidth={2.25} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="min-w-0 break-words">
          {titleLink(m, "font-semibold")}
          {meta && <span className="text-muted-foreground"> · {meta}</span>}
          {m.origin === "learner" && (
            <>
              {" "}
              <YoursBadge />
            </>
          )}
        </span>
        {m.why && <span className="text-neutral-800">{m.why}</span>}
      </div>
      <div className="flex items-center gap-1 justify-self-end max-[640px]:col-start-2 max-[640px]:-ml-2.5 max-[640px]:justify-self-start">
        <VerifiedButton material={m} />
        {onRemove && <RemoveButton title={m.title} onClick={onRemove} />}
      </div>
    </div>
  );
}

function YoursBadge() {
  return <span className="inline-flex rounded-full bg-accent-200 px-[7px] py-px align-[1px] text-[10.5px] font-semibold text-accent-800">Yours</span>;
}

function RemoveButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${title}`}
      title="Remove"
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/7 hover:text-foreground"
    >
      <X className="size-3.5" strokeWidth={2.5} />
    </button>
  );
}

/** "✓ Verified" and its popover: when the page was opened, what it was titled, where it lives, who recommended it. */
export function VerifiedButton({ material: m, prominent = false }: { material: Material; prominent?: boolean }) {
  const [open, setOpen] = useState(false);
  const [showRecs, setShowRecs] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!m.verifiedAt) {
    return m.origin === "learner" && m.type !== "note" && m.type !== "file" ? (
      <span className="text-xs whitespace-nowrap text-muted-foreground">Not opened</span>
    ) : null;
  }
  const opened = new Date(m.verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const host = hostOf(m.url);
  // A researched book whose own page could not be used links to its Open Library entry instead.
  const catalogued = m.kind === "book" && m.origin === "research" && host === "openlibrary.org";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Verification details for ${m.title}`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex min-h-8 items-center gap-[5px] rounded-full px-2.5 text-xs font-semibold whitespace-nowrap text-accent-2-800 hover:bg-accent-2-200",
          open && "bg-background",
        )}
      >
        {prominent ? <ShieldCheck className="size-[15px] text-accent-2-700" strokeWidth={2.5} /> : "✓"} Verified
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`How ${m.title} was checked`}
          className="absolute top-10 right-0 z-20 flex w-[340px] max-w-[calc(100vw-48px)] flex-col gap-1.5 rounded-2xl bg-neutral-900 px-4 py-3.5 text-[12.5px] leading-normal text-neutral-100 shadow-md"
        >
          <span className="font-semibold">{catalogued ? "Found on Open Library" : "Opened"} {opened}</span>
          {m.fetchedTitle && (
            <span>
              {catalogued ? "Catalogue title" : "Page title"}: “{m.fetchedTitle}”
            </span>
          )}
          <span>
            {host}
            {catalogued
              ? " · matched by title and author"
              : m.kind === "book" && m.origin === "research"
                ? m.year
                  ? " · matched on Open Library by title and author"
                  : " · Open Library was unavailable, so not matched"
                : ""}
          </span>
          {m.recommendedBy.length > 0 && (
            <span className="text-neutral-300">
              Recommended by {m.recommendedBy.length} source{m.recommendedBy.length === 1 ? "" : "s"} ·{" "}
              <button type="button" className="text-accent-300 underline-offset-2 hover:underline" onClick={() => setShowRecs((v) => !v)}>
                {showRecs ? "hide them" : "see them"}
              </button>
            </span>
          )}
          {showRecs && (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {m.recommendedBy.map((r) => (
                <li key={r} className="min-w-0 truncate">
                  <a href={r} target="_blank" rel="noreferrer" className="text-accent-300 hover:underline">
                    {r.replace(/^https:\/\/(www\.)?/, "")}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ResearchNoticeBanner({
  notice,
  topic,
  researched,
  hasBackbone,
  onResearchAgain,
}: {
  notice: ResearchNotice;
  topic: string;
  researched: number;
  hasBackbone: boolean;
  onResearchAgain?: () => void;
}) {
  if (notice === "unavailable") {
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 rounded-[20px] bg-neutral-200 py-3 pr-3 pl-4 text-[13px] leading-normal">
        <X className="size-[18px] shrink-0 text-muted-foreground" strokeWidth={2.5} />
        <span className="min-w-[200px] flex-1">Couldn&apos;t search the web just now, so this plan is drafted from your sources only.</span>
        {onResearchAgain && (
          <Button variant="secondary" size="sm" className="min-h-10 border border-border bg-background px-4 text-[12.5px]" onClick={onResearchAgain}>
            <RotateCw className="size-3.5" strokeWidth={2.5} />
            Research again
          </Button>
        )}
      </div>
    );
  }
  return (
    <div role="status" className="flex gap-3 rounded-[20px] bg-accent-200 px-4 py-3.5 text-[13px] leading-normal text-accent-900">
      <CircleAlert className="mt-px size-[18px] shrink-0 text-accent-700" strokeWidth={2.5} />
      <span>
        {researched === 0 ? "No materials could be checked" : `Only ${researched} material${researched === 1 ? "" : "s"} could be checked`} for{" "}
        <strong className="font-semibold">{topic}</strong>
        {hasBackbone ? "" : ", and no textbook stood out"}. The plan uses {researched === 0 ? "your own sources" : researched === 1 ? "that one plus your own sources" : "those plus your own sources"}.
      </span>
    </div>
  );
}

function RemoveDialog({ material, uses, onCancel, onConfirm }: { material: Material; uses: MaterialUse[]; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="rm-h" aria-describedby="rm-d" className="flex w-full max-w-[460px] flex-col gap-2.5 rounded-[28px] bg-secondary px-[22px] py-5 shadow-md">
        <h3 id="rm-h" className="m-0 font-heading text-[17px] font-normal">
          Remove {material.title}?
        </h3>
        <p id="rm-d" className="m-0 text-[13px] leading-normal text-neutral-800">
          {describeUses(uses)}
        </p>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} variant="secondary" className="min-h-11 border border-border bg-transparent px-[18px]" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="min-h-11 px-[18px]" onClick={onConfirm}>
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "It's assigned in Week 2 and Week 11, and reserved by Month 3. Those units keep their other materials." */
export function describeUses(uses: MaterialUse[]): string {
  const assigned = uses.filter((u) => u.role === "assigned").map((u) => u.label);
  const reserved = uses.filter((u) => u.role === "covers").map((u) => u.label);
  if (assigned.length === 0 && reserved.length === 0) return "No unit uses it yet.";
  const parts: string[] = [];
  if (assigned.length > 0) parts.push(`assigned in ${joinAnd(assigned)}`);
  if (reserved.length > 0) parts.push(`reserved by ${joinAnd(reserved)}`);
  return `It's ${parts.join(", and ")}. Those units keep their other materials.`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  const shown = items.length > 5 ? [...items.slice(0, 4), `${items.length - 4} more`] : items;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}
