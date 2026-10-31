"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
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
import { PRACTICE_OPEN_PREFIX, isPracticeOpen, type Coverage, type DroppedMaterial, type ResearchNotice } from "@/lib/ai/research/events";
import { isPracticeOnly } from "@/lib/materials";
import { PRACTICE_REGISTRY, type PracticeFormat } from "@/lib/practice";
import { approxDuration } from "@/lib/researchProgress";
import { KIND_LABEL, KIND_ORDER, hostOf, type Material, type MaterialKind, type MaterialPractice } from "@/lib/schemas/material";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<MaterialKind, ComponentType<{ className?: string; strokeWidth?: number }>> = {
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
  /** The topic's main areas: what research found until the allocation states the plan's. Known only for a fresh draft. */
  coverage?: Coverage | null;
  /** Whose `coverage` it is. Research's is labelled "Research found", never "Covered / Not covered". Default: research. */
  coverageSource?: "plan" | "research";
  /** What research found, for the thin-list notice; defaults to `coverage`. */
  researchCoverage?: Coverage | null;
  /** The plan's study hours in all, to set the list's size against. */
  totalHours?: number;
  /** Where each material is used, for the remove confirmation. Omit with `onRemove` for a read-only list. */
  usesOf?: (id: string) => MaterialUse[];
  onRemove?: (id: string) => void;
  /** Offered only before the plan is confirmed, with the "unavailable" notice. */
  onResearchAgain?: () => void;
  /** True between research and the allocation, which alone chooses the backbone: nothing is said about one yet. */
  awaitingBackbone?: boolean;
  /** Rows shown before "Show all", of the reading groups and of the Practice group each. */
  initialShown?: number;
  /**
   * Folds the list into its heading, open on the first visit only, so a returning learner sees the plan first. The
   * browser storage key that remembers the visit; omit for a list that is always open.
   */
  foldKey?: string;
  /** Leaves out the heading and the totals line, for a page that shows them beside the list. */
  bare?: boolean;
}

/** The plan-level materials list: the backbone pinned first, the rest grouped by kind. */
export function MaterialsList(props: MaterialsListProps) {
  const { materials, dropped = [], notice, coverage, coverageSource = "research", initialShown = 6 } = props;
  const checked = dropped.filter((d) => d.stage !== "plan");
  const unused = dropped.filter((d) => d.stage === "plan");
  const [showAll, setShowAll] = useState(false);
  const [removing, setRemoving] = useState<Material | null>(null);

  const backbone = materials.find((m) => m.backbone) ?? null;
  const rest = materials.filter((m) => m !== backbone);
  const ordered = [...KIND_ORDER.flatMap((kind) => rest.filter((m) => m.kind === kind && !isPracticeOnly(m))), ...rest.filter(isPracticeOnly)];
  const shown = showAll ? ordered : shownRows(ordered, initialShown);
  const researched = materials.filter((m) => m.origin === "research").length;
  const { readingMinutes: sized, practiceMinutes } = materialTotals(materials);
  const unsized = materials.filter((m) => !m.minutes && !m.practice?.minutes).length;
  const fold = useRef<HTMLDetailsElement>(null);

  // The fold is closed when rendered; the first visit opens it. Set on the element, so React leaves it to the learner.
  useEffect(() => {
    if (!props.foldKey || !fold.current) return;
    try {
      if (window.localStorage.getItem(props.foldKey)) return;
      window.localStorage.setItem(props.foldKey, "seen");
    } catch {
      return;
    }
    fold.current.open = true;
  }, [props.foldKey]);

  const heading = (
    <div className="flex flex-wrap items-center gap-2.5">
      <h2 id="materials-h" className="m-0 font-heading text-lg font-normal">
        Materials
      </h2>
      <span className="inline-flex items-center gap-[5px] rounded-full bg-accent-2-200 px-[9px] py-[3px] text-[11px] font-semibold text-accent-2-800">
        <Check className="size-3" strokeWidth={3} />
        {checkedLine(materials)}
      </span>
      {props.foldKey && <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open/fold:rotate-180" />}
      <span className="ml-auto text-[12.5px] text-muted-foreground max-[640px]:ml-0 max-[640px]:basis-full">Gather these up front. Each week assigns a slice.</span>
    </div>
  );

  const body = (
    <>
      {!props.bare && sized + practiceMinutes > 0 && (
        <p className="m-0 text-[13px] leading-normal text-neutral-800">
          <strong className="font-semibold">{totalsLine(sized, practiceMinutes)}</strong>
          {props.totalHours ? ` for a plan of about ${props.totalHours} hours` : ""}
          {unsized > 0 ? `, not counting ${unsized} with no size` : ""}. Sizes are for the part the plan uses. How much of it is required is the plan&apos;s call, week by week.
        </p>
      )}
      {coverage && (coverage.covered.length > 0 || coverage.open.length > 0) && <CoverageChips coverage={coverage} source={coverageSource} />}

      {backbone ? (
        <div id={BACKBONE_ANCHOR} className="scroll-mt-4">
          <BackboneCard material={backbone} onRemove={props.onRemove ? () => setRemoving(backbone) : undefined} />
        </div>
      ) : props.awaitingBackbone ? null : (
        <span className="text-[13px] text-muted-foreground">No backbone: units draw on the materials below directly.</span>
      )}

      {/* Bare, the list flows into columns as its container widens, so rows never run the width of a wide screen. */}
      <div className={props.bare ? "block gap-x-8 @min-[1000px]:columns-2 @min-[1600px]:columns-3" : "flex flex-col gap-0.5"}>
        {shown.map((m, i) => (
          <div key={m.id} className="contents">
            {(i === 0 || groupLabel(shown[i - 1]) !== groupLabel(m)) && (
              <span id={groupAnchor(groupLabel(m))} className="block scroll-mt-4 break-after-avoid px-1 pt-1.5 pb-1 text-[11px] tracking-wide text-muted-foreground uppercase">
                {groupLabel(m)}
              </span>
            )}
            <div className="break-inside-avoid">
              <MaterialRow material={m} onRemove={props.onRemove ? () => setRemoving(m) : undefined} />
            </div>
          </div>
        ))}
      </div>

      {shownRows(ordered, initialShown).length < ordered.length && (
        <Button variant="secondary" size="sm" className="min-h-10 self-start border border-border bg-transparent px-4 text-[12.5px]" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${materials.length}`}
        </Button>
      )}

      <DroppedGroup heading="Rejected by checks" items={checked} />
      <DroppedGroup heading="Found but not used" items={unused} />
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <ResearchNoticeBanner notice={notice} topic={props.topic} researched={researched} sizedMinutes={sized} coverage={props.researchCoverage ?? coverage} hasBackbone={!!backbone} backboneKnown={!props.awaitingBackbone} onResearchAgain={props.onResearchAgain} />
      )}

      {materials.length > 0 && (
        <section
          aria-labelledby={props.bare ? undefined : "materials-h"}
          aria-label={props.bare ? "Materials" : undefined}
          className="flex flex-col gap-3.5 rounded-[28px] bg-secondary px-[22px] pt-5 pb-[18px]"
        >
          {props.bare ? (
            body
          ) : props.foldKey ? (
            <details ref={fold} className="group/fold">
              <summary className="cursor-pointer list-none rounded-xl select-none [&::-webkit-details-marker]:hidden">{heading}</summary>
              <div className="mt-3.5 flex flex-col gap-3.5">{body}</div>
            </details>
          ) : (
            <>
              {heading}
              {body}
            </>
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

/**
 * The rows shown before "Show all": the first `initialShown` of the reading groups and of the Practice group, which
 * comes last, so the Practice group shows whatever the list's length.
 */
export function shownRows(ordered: Material[], initialShown: number): Material[] {
  return [...ordered.filter((m) => !isPracticeOnly(m)).slice(0, initialShown), ...ordered.filter(isPracticeOnly).slice(0, initialShown)];
}

/** A practice-only source goes in the "Practice" group instead of a kind group. */
export function groupLabel(m: Material): string {
  return isPracticeOnly(m) ? "Practice" : KIND_LABEL[m.kind];
}

const BACKBONE_ANCHOR = "materials-backbone";

function groupAnchor(label: string): string {
  return `materials-${label.toLowerCase()}`;
}

/** The list's groups in its order, the backbone first when there is one, each with its anchor and how many it holds. */
export function materialGroups(materials: Material[]): { label: string; anchor: string; count: number }[] {
  const backbone = materials.find((m) => m.backbone) ?? null;
  const rest = materials.filter((m) => m !== backbone);
  const ordered = [...KIND_ORDER.flatMap((kind) => rest.filter((m) => m.kind === kind && !isPracticeOnly(m))), ...rest.filter(isPracticeOnly)];
  const groups: { label: string; anchor: string; count: number }[] = backbone ? [{ label: "Backbone", anchor: BACKBONE_ANCHOR, count: 1 }] : [];
  for (const m of ordered) {
    const label = groupLabel(m);
    const last = groups.at(-1);
    if (last && last.label === label) last.count += 1;
    else groups.push({ label, anchor: groupAnchor(label), count: 1 });
  }
  return groups;
}

/** Whose materials these are: "13 · all opened and checked", "2 yours" or "11 checked · 2 yours". */
export function checkedLine(materials: Material[]): string {
  const researched = materials.filter((m) => m.origin === "research").length;
  const yours = materials.length - researched;
  return yours === 0 ? `${researched} · all opened and checked` : researched === 0 ? `${yours} yours` : `${researched} checked · ${yours} yours`;
}

/** What a kind of practice item is called in a count. */
const ITEM_NOUN: Partial<Record<PracticeFormat, string>> = { "problem-set": "problem", recall: "question", lab: "step" };

/** "Problems · 150 problems · answers included": what the source is as practice, how much of it, and whether it checks you. */
export function practiceTag(p: MaterialPractice): string {
  const noun = ITEM_NOUN[p.format] ?? "item";
  return [PRACTICE_REGISTRY[p.format].label, p.items ? `${p.totalItems && p.totalItems > p.items ? `${p.items} of ${p.totalItems}` : p.items} ${noun}${(p.totalItems ?? p.items) === 1 ? "" : "s"}` : null, p.answers ? "answers included" : null].filter(Boolean).join(" · ");
}

/** Minutes of reading and minutes of practice over the list. A source counts toward each role it has. */
export function materialTotals(materials: Material[]): { readingMinutes: number; practiceMinutes: number } {
  return {
    readingMinutes: materials.reduce((sum, m) => sum + (m.minutes ?? 0), 0),
    practiceMinutes: materials.reduce((sum, m) => sum + (m.practice?.minutes ?? 0), 0),
  };
}

/** "≈ 5 h 35 of reading + 9 h of practice"; a list with no practice stays "≈ 5 h 35 of material". */
export function totalsLine(readingMinutes: number, practiceMinutes: number): string {
  if (practiceMinutes === 0) return `${approxDuration(readingMinutes)} of material`;
  if (readingMinutes === 0) return `${approxDuration(practiceMinutes)} of practice`;
  return `${approxDuration(readingMinutes)} of reading + ${approxDuration(practiceMinutes).replace("≈ ", "")} of practice`;
}

/** Separates the practice picks research found no source for (as their labels) from the topic areas it left open. */
export function splitCoverage(open: string[]): { areas: string[]; practice: string[] } {
  const practice = open.filter(isPracticeOpen).map((a) => a.slice(PRACTICE_OPEN_PREFIX.length));
  return { areas: open.filter((a) => !isPracticeOpen(a)), practice };
}

export function byline(m: Material, withKind = false): string {
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
        <SizeLine material={m} />
        <PracticeLine material={m} />
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
        <SizeLine material={m} />
        <PracticeLine material={m} />
      </div>
      <div className="flex items-center gap-1 justify-self-end max-[640px]:col-start-2 max-[640px]:-ml-2.5 max-[640px]:justify-self-start">
        <VerifiedButton material={m} />
        {onRemove && <RemoveButton title={m.title} onClick={onRemove} />}
      </div>
    </div>
  );
}

/** "≈ 5 h · ch. 1, 7–9 · estimated": the size of the part the plan uses, and whether code measured it. */
function SizeLine({ material: m }: { material: Material }) {
  if (!m.minutes && !m.uses && !m.toc) return null;
  const parts = [
    m.minutes ? approxDuration(m.minutes) : null,
    m.uses,
    m.minutes ? (m.minutesBasis === "measured" ? "measured" : "estimated") : null,
    m.toc ? `${m.toc.chapters.length} chapters` : null,
  ].filter(Boolean);
  const sizeTitle = m.minutesBasis === "measured" ? "Counted from a page count, a runtime or the page's own length" : "A judgement, so treat it as rough";
  const chaptersTitle = m.toc ? `; chapters from ${m.toc.source === "catalogue" ? "Open Library" : (hostOf(m.toc.url) ?? "a page")}` : "";
  return (
    <span className="text-xs text-muted-foreground" title={`${sizeTitle}${chaptersTitle}`}>
      {parts.join(" · ")}
    </span>
  );
}

/** "9 groups · 100 of 150": a listed source's groups and, when the plan cut the list, how many of its items it keeps. Null without a list or groups. */
export function listSummary(p: MaterialPractice): string | null {
  const items = p.list?.items;
  if (!items) return null;
  const groups = new Set(items.flatMap((i) => (i.group ? [i.group] : []))).size;
  if (groups === 0) return null;
  const whole = p.totalItems ?? items.length;
  return `${groups} group${groups === 1 ? "" : "s"}${whole > items.length ? ` · ${items.length} of ${whole}` : ""}`;
}

/** "Problems · 150 problems · answers included · ≈ 25 h": the source's role as practice, with the time it takes to do; a listed source's groups under it. */
function PracticeLine({ material: m }: { material: Material }) {
  if (!m.practice) return null;
  const summary = listSummary(m.practice);
  return (
    <>
      <span className="text-xs text-muted-foreground">{[practiceTag(m.practice), m.practice.minutes ? approxDuration(m.practice.minutes) : null].filter(Boolean).join(" · ")}</span>
      {summary && <span className="text-xs text-muted-foreground">{summary}</span>}
    </>
  );
}

/** One group of what was considered and left out, with its count and each one's reason; nothing when it is empty. */
function DroppedGroup({ heading, items }: { heading: string; items: DroppedMaterial[] }) {
  if (items.length === 0) return null;
  return (
    <details className="group text-[12.5px]">
      <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">
        {heading} ({items.length})
      </summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
        {items.map((d, i) => (
          <li key={`${d.title}-${i}`} className="flex min-w-0 items-baseline gap-2 text-muted-foreground">
            <X className="size-3 shrink-0 translate-y-0.5" strokeWidth={2.75} />
            <span className="min-w-0">
              <span className="line-through">{d.title}</span> · {d.reason}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Research's coverage reads "Research found" (what it found, not what the plan does); the plan's reads covered / not covered. */
function CoverageChips({ coverage, source }: { coverage: Coverage; source: "plan" | "research" }) {
  const { areas, practice } = splitCoverage(coverage.open);
  const research = source === "research";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {coverage.covered.length > 0 && <span className="text-muted-foreground">{research ? "Research found" : "Covered"}</span>}
      {coverage.covered.map((area) => (
        <span key={`c-${area}`} className="rounded-full bg-accent-2-200 px-2.5 py-1 font-semibold text-accent-2-800">
          {area}
        </span>
      ))}
      {areas.length > 0 && <span className={cn("text-muted-foreground", coverage.covered.length > 0 && "ml-2")}>{research ? "Research found nothing on" : "Not covered"}</span>}
      {areas.map((area) => (
        <span key={`o-${area}`} className="rounded-full border border-dashed border-neutral-600 px-2.5 py-1 text-neutral-800">
          {area}
        </span>
      ))}
      {practice.length > 0 && <span className="basis-full text-muted-foreground">No practice source found for: {practice.join(", ")}</span>}
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
  sizedMinutes,
  coverage,
  hasBackbone,
  backboneKnown,
  onResearchAgain,
}: {
  notice: ResearchNotice;
  topic: string;
  researched: number;
  sizedMinutes: number;
  coverage?: Coverage | null;
  hasBackbone: boolean;
  backboneKnown: boolean;
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
        {thinText({ researched, sizedMinutes, open: splitCoverage(coverage?.open ?? []).areas, hasBackbone, backboneKnown })} for <strong className="font-semibold">{topic}</strong>.{" "}
        {researched === 0 ? "The plan uses your own sources" : "The plan uses what was found plus your own sources"} and leans on practice where there is nothing to read. Paste links in the
        conversation to have them checked the same way.
      </span>
    </div>
  );
}

/** "Pensieve could check only 3 materials, about 9 h, and found nothing on advanced stitches or finishing" */
export function thinText(input: { researched: number; sizedMinutes: number; open: string[]; hasBackbone: boolean; backboneKnown?: boolean }): string {
  const { researched, sizedMinutes, open, backboneKnown = true } = input;
  const count = researched === 0 ? "Pensieve could not check any materials" : `Pensieve could check ${researched < 5 ? "only " : ""}${researched} material${researched === 1 ? "" : "s"}`;
  const size = researched > 0 && sizedMinutes > 0 ? `, ${approxDuration(sizedMinutes).replace("≈", "about")},` : "";
  const gaps = open.length > 0 ? ` and found nothing on ${joinAnd(open.map((a) => a.toLowerCase()))}` : input.hasBackbone || !backboneKnown ? "" : " and no textbook stood out";
  return `${count}${gaps ? size : size.replace(/,$/, "")}${gaps}`;
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
