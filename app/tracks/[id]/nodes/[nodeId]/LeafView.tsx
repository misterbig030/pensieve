"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ReadTable, type ReadRow } from "@/components/pensieve/ReadTable";
import { ShieldCheck } from "lucide-react";
import { formatCostUsd } from "@/lib/formatCost";
import { generateLeafContentAction } from "./actions";
import { logSessionAction, markCompleteAction } from "../../actions";

interface Source {
  url: string;
  title: string | null;
}

interface Props {
  trackId: string;
  nodeId: string;
  unit: "day" | "week";
  /** Week leaves only. */
  budgetHours: number | null;
  initialSessions: { hours: number }[];
  initialContent: { contentMarkdown: string; citations: { title: string; url: string }[] } | null;
  youtubeSources: Source[];
  isCompleted: boolean;
  /** The leaf's Read table; empty for plans saved before materials were assigned. */
  readRows: ReadRow[];
  budgetMinutes: number;
}

export function LeafView({ trackId, nodeId, unit, budgetHours, initialSessions, initialContent, youtubeSources, isCompleted, readRows, budgetMinutes }: Props) {
  const [content, setContent] = useState(initialContent);
  const [sessions, setSessions] = useState(initialSessions);
  const [hoursInput, setHoursInput] = useState("1");
  const [isPending, setIsPending] = useState(false);
  const [completed, setCompleted] = useState(isCompleted);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);

  const isWeek = unit === "week";
  const loggedHours = sessions.reduce((a, s) => a + s.hours, 0);

  async function handleGenerate() {
    setIsPending(true);
    setError(null);
    try {
      const { costUsd: cost, ...result } = await generateLeafContentAction({ trackId, nodeId });
      setContent(result);
      setCostUsd(cost);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed. Try again.");
    } finally {
      setIsPending(false);
    }
  }

  async function handleMarkComplete() {
    setIsPending(true);
    setError(null);
    try {
      await markCompleteAction(nodeId);
      setCompleted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark this complete. Try again.");
    } finally {
      setIsPending(false);
    }
  }

  async function handleLogSession() {
    const hours = Number(hoursInput);
    if (!Number.isFinite(hours) || hours <= 0) return;
    setIsPending(true);
    setError(null);
    try {
      await logSessionAction(nodeId, hours);
      setSessions((s) => [...s, { hours }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not log the session. Try again.");
    } finally {
      setIsPending(false);
    }
  }

  const sessionCard = isWeek && (
    <div className="flex flex-wrap items-center justify-between gap-3.5 rounded-[28px] bg-secondary px-5 py-3.5 text-[13.5px]">
      <span>
        Time budget about {budgetHours} hours ·{" "}
        {sessions.length > 0
          ? `${sessions.length} session${sessions.length > 1 ? "s" : ""}, ${formatHours(loggedHours)} h logged`
          : "no sessions logged yet"}
      </span>
      <span className="inline-flex items-center gap-2">
        <Input
          type="number"
          min={0.25}
          max={24}
          step={0.25}
          value={hoursInput}
          onChange={(e) => setHoursInput(e.target.value)}
          className="w-[76px]"
          aria-label="Hours studied"
        />
        <span className="text-[13px] text-muted-foreground">h</span>
        <Button variant="secondary" size="sm" className="border border-border" onClick={handleLogSession} disabled={isPending}>
          Log a session
        </Button>
      </span>
    </div>
  );

  const readTable = readRows.length > 0 && <ReadTable rows={readRows} budgetMinutes={budgetMinutes} />;
  const provenance = readRows.length > 0 && <WhereTheseComeFrom rows={readRows} />;

  if (!content) {
    return (
      <div className="space-y-5">
        {readTable}
        {sessionCard}
        <div className="elev-sm flex flex-col items-center gap-3.5 rounded-[32px] bg-secondary px-6 py-12 text-center">
          <div className="size-11 rounded-full bg-accent-100" />
          <h3 className="m-0">{isWeek ? "This week's material isn't written yet" : "Today's lesson isn't written yet"}</h3>
          <p className="m-0 max-w-[38ch] text-muted-foreground">
            {readRows.length > 0
              ? `Written from the ${readRows.length === 1 ? "material" : `${readRows.length} materials`} above, and citing only ${readRows.length === 1 ? "it" : "them"}. Generate it when you start.`
              : "Generate it now — Pensieve will pull in your sources and cite what it uses."}
          </p>
          <Button onClick={handleGenerate} disabled={isPending}>
            {isWeek ? "Generate this week's material" : "Generate today's lesson"}
          </Button>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        {provenance}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {readTable}
      {sessionCard}
      <div className="elev-sm space-y-4 rounded-[32px] bg-card p-8">
        <div className="space-y-4">
          <ReactMarkdown
            components={{
              p: ({ children }) => <p className="text-[15px] leading-[1.7] last:mb-0">{children}</p>,
            }}
          >
            {content.contentMarkdown}
          </ReactMarkdown>
        </div>

        {content.citations.length > 0 && (
          <div>
            <p className="mb-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">Sources</p>
            <div className="flex flex-wrap gap-2">
              {content.citations.map((c) => (
                <a key={c.url} href={c.url} target="_blank" rel="noreferrer">
                  <Badge variant="tagOutline">{c.title}</Badge>
                </a>
              ))}
            </div>
          </div>
        )}

        {youtubeSources.length > 0 && (
          <div>
            <p className="mb-2.5 text-[11px] tracking-wide text-muted-foreground uppercase">Related video</p>
            <div className="flex flex-col gap-2">
              {youtubeSources.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-2xl p-2 hover:bg-secondary">
                  <span
                    className="h-10 w-16 shrink-0 rounded-[10px]"
                    style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--neutral-300) 0 6px, var(--neutral-200) 6px 12px)" }}
                  />
                  <span className="text-[13px]">{s.title ?? s.url}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={handleGenerate} disabled={isPending}>
          Try a different take
        </Button>
        <Button onClick={handleMarkComplete} disabled={isPending || completed}>
          {completed ? "Completed" : "Mark complete"}
        </Button>
      </div>
      {costUsd !== null && <p className="text-xs text-muted-foreground">Estimated cost: {formatCostUsd(costUsd)}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {provenance}
    </div>
  );
}

/** "Where these come from": when the pages were opened and checked, and how the textbook was chosen. */
function WhereTheseComeFrom({ rows }: { rows: ReadRow[] }) {
  const checked = rows.filter((r) => r.material.verifiedAt);
  const unchecked = rows.length - checked.length;
  const latest = checked.map((r) => r.material.verifiedAt!).sort().at(-1);
  const backbone = rows.find((r) => r.material.backbone)?.material;
  const parts: string[] = [];
  if (latest) {
    const date = new Date(latest).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    parts.push(
      `Pensieve opened ${checked.length === rows.length ? (rows.length === 1 ? "this page" : "each page") : `${checked.length} of these pages`} on ${date} and checked ${checked.length === 1 ? "it is" : "each is"} what it claims to be.`,
    );
  }
  if (unchecked > 0) parts.push(`${unchecked === 1 ? "One is" : `${unchecked} are`} your own, listed as you gave ${unchecked === 1 ? "it" : "them"}.`);
  if (backbone && backbone.recommendedBy.length > 0) {
    parts.push(`The textbook was recommended by ${backbone.recommendedBy.length} independent source${backbone.recommendedBy.length === 1 ? "" : "s"}.`);
  }
  if (parts.length === 0) return null;
  return (
    <section aria-labelledby="src-h" className="flex flex-col gap-2 rounded-[28px] bg-foreground/4 px-[22px] py-[18px]">
      <h2 id="src-h" className="m-0 flex items-center gap-2 font-sans text-[13px] font-semibold">
        <ShieldCheck className="size-[15px] text-accent-2-700" strokeWidth={2.5} />
        Where these come from
      </h2>
      <p className="m-0 text-[12.5px] leading-normal text-neutral-800">{parts.join(" ")}</p>
    </section>
  );
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}
