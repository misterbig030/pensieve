"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, Copy, Download, Maximize2, Minimize2, Trash2, X } from "lucide-react";
import { formatCostUsd } from "@/lib/formatCost";
import type { ModelCall } from "@/lib/planChat";
import { cn } from "@/lib/utils";

/** Width of the docked panel; the page pads its right edge by this much (see `--admin-dock` in globals.css). */
export const ADMIN_DOCK_WIDTH = 400;

interface ModelCallsPanelProps {
  calls: ModelCall[];
  onClear: () => void;
  onClose: () => void;
}

const NARROW_QUERY = "(max-width: 1199px)";
function subscribeNarrow(onChange: () => void): () => void {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const getNarrow = () => window.matchMedia(NARROW_QUERY).matches;
const getNarrowServer = () => false;

/**
 * The admin's view of the model calls behind the current page: a dark column on the right, or the whole window
 * when expanded (and always on narrow screens). Everything here lives in React state; nothing is stored.
 */
export function ModelCallsPanel({ calls, onClear, onClose }: ModelCallsPanelProps) {
  const narrow = useSyncExternalStore(subscribeNarrow, getNarrow, getNarrowServer);
  const [expandedByUser, setExpandedByUser] = useState(false);
  const expanded = expandedByUser || narrow;
  // null follows the newest call; a number pins one the admin clicked.
  const [pinned, setPinned] = useState<number | null>(null);
  const selectedIndex = pinned !== null && pinned < calls.length ? pinned : calls.length - 1;
  const selected = calls[selectedIndex] ?? null;

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--admin-dock", expanded ? "0px" : `${ADMIN_DOCK_WIDTH}px`);
    return () => {
      root.style.removeProperty("--admin-dock");
    };
  }, [expanded]);

  const totals = calls.reduce(
    (t, c) => ({
      inputTokens: t.inputTokens + (c.inputTokens ?? 0),
      outputTokens: t.outputTokens + (c.outputTokens ?? 0),
      cacheReadTokens: t.cacheReadTokens + (c.cacheReadTokens ?? 0),
      costUsd: t.costUsd + c.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
  );

  const list = (
    <div className="flex min-h-0 flex-col">
      {calls.length === 0 && (
        <p className="m-0 px-5 py-4 text-[12.5px] leading-relaxed opacity-60">
          No model calls yet in this tab. Draft, expand or ask something and each call shows up here.
        </p>
      )}
      {calls.map((call, i) => (
        <CallRow key={i} index={i} call={call} selected={i === selectedIndex} onSelect={() => setPinned(i)} />
      ))}
    </div>
  );

  return (
    <aside
      aria-label="Model calls"
      className={cn(
        "fixed z-40 flex flex-col bg-neutral-900 text-background",
        expanded ? "inset-0" : "top-0 right-0 h-screen w-[400px] shadow-lg",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 flex-col gap-2.5 border-b border-background/10",
          expanded ? "px-7 py-4" : "py-4 pr-4 pl-5",
        )}
      >
        <div className="flex items-center gap-2.5">
          <h3 className="m-0 font-heading text-[15px] font-normal">Model calls</h3>
          <span className="text-xs opacity-60">this session</span>
          <span className="ml-auto inline-flex gap-1">
            {expanded && calls.length > 0 && (
              <IconButton label="Download all calls as JSON" onClick={() => downloadJson(calls)}>
                <Download className="size-3.5" strokeWidth={2.5} />
              </IconButton>
            )}
            {!narrow && (
              <IconButton label={expanded ? "Dock to the side" : "Expand"} onClick={() => setExpandedByUser((v) => !v)}>
                {expanded ? <Minimize2 className="size-3.5" strokeWidth={2.5} /> : <Maximize2 className="size-3.5" strokeWidth={2.5} />}
              </IconButton>
            )}
            <IconButton label="Clear model calls" onClick={onClear} disabled={calls.length === 0}>
              <Trash2 className="size-3.5" strokeWidth={2.5} />
            </IconButton>
            <IconButton label="Close model calls" onClick={onClose} plain>
              <X className="size-4" strokeWidth={2.5} />
            </IconButton>
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
          <Chip>{calls.length} call{calls.length === 1 ? "" : "s"}</Chip>
          <Chip>
            {fmt(totals.inputTokens)} in · {fmt(totals.outputTokens)} out
          </Chip>
          <Chip>{fmt(totals.cacheReadTokens)} cached</Chip>
          <Chip>{formatCostUsd(totals.costUsd)}</Chip>
        </div>
      </div>

      {expanded ? (
        <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
          <div className="flex min-h-0 flex-col overflow-y-auto border-r border-background/10">
            <span className="px-5 pt-3.5 pb-1 text-[11px] tracking-wide uppercase opacity-50">Calls, oldest first</span>
            {list}
            <p className="mt-auto m-0 border-t border-background/10 px-5 py-3.5 text-xs leading-relaxed opacity-60">
              Kept in this tab only. Reload and the list starts again. Nothing here is written to the database.
            </p>
          </div>
          <div className="flex min-h-0 flex-col">
            {selected && <MetaStrip call={selected} />}
            <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[minmax(0,1fr)]">
              <Pane title="Prompt" meta={selected ? `${fmt(selected.inputTokens)} tokens` : ""} sections={promptSections(selected)} className="border-r border-background/10" wide />
              <Pane
                title="Raw response"
                meta={selected ? `${fmt(selected.outputTokens)} tokens` : ""}
                facts={selected?.facts ?? []}
                text={selected?.response ?? ""}
                wide
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-background/10">{list}</div>
          <Pane title="Prompt" meta={selected ? `${fmt(selected.inputTokens)} tokens` : ""} sections={promptSections(selected)} className="min-h-0 flex-1 basis-0 border-b border-background/10" />
          <Pane
            title="Raw response"
            meta={selected ? `${fmt(selected.outputTokens)} tokens` : ""}
            facts={selected?.facts ?? []}
            text={selected?.response ?? ""}
            className="min-h-0 flex-[1.3] basis-0"
          />
        </div>
      )}
    </aside>
  );
}

function CallRow({ index, call, selected, onSelect }: { index: number; call: ModelCall; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-1 border-l-[3px] px-4 py-2.5 text-left transition-colors hover:bg-background/5",
        selected ? "border-accent-400 bg-background/8" : "border-transparent",
      )}
    >
      <span className="flex items-center gap-2 text-[12.5px]">
        <span className="font-mono opacity-50">#{index + 1}</span>
        <CallerBadge caller={call.caller} />
        <span className="min-w-0 truncate">{call.label}</span>
      </span>
      <span className="font-mono text-[11px] opacity-60">
        {shortModel(call.model)} · {fmt(call.inputTokens)} → {fmt(call.outputTokens)} · {formatCostUsd(call.costUsd)} ·{" "}
        {seconds(call.latencyMs)}
      </span>
    </button>
  );
}

function MetaStrip({ call }: { call: ModelCall }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-background/10 px-6 py-3.5 font-mono text-[11.5px]">
      <CallerBadge caller={call.caller} large />
      <Chip>{call.model}</Chip>
      <Chip>effort {call.effort ?? "—"}</Chip>
      <Chip>in {fmt(call.inputTokens)}</Chip>
      <Chip>out {fmt(call.outputTokens)}</Chip>
      <Chip>cache read {fmt(call.cacheReadTokens)}</Chip>
      <Chip>reasoning {call.reasoningTokens === null ? "—" : fmt(call.reasoningTokens)}</Chip>
      <Chip>{formatCostUsd(call.costUsd)}</Chip>
      <Chip>{fmt(call.latencyMs)} ms</Chip>
      <Chip>finish: {call.finishReason ?? "—"}</Chip>
    </div>
  );
}

interface PaneSection {
  title: string;
  text: string;
}

/** A chat call shows its system prompt apart from the transcript; single-prompt calls have one unlabelled section. */
function promptSections(call: ModelCall | null): PaneSection[] {
  if (!call) return [];
  if (call.system === null) return [{ title: "", text: call.prompt }];
  return [
    { title: "System prompt", text: call.system },
    { title: "Transcript", text: call.prompt },
  ];
}

function Pane({
  title,
  meta,
  facts = [],
  text,
  sections,
  className,
  wide = false,
}: {
  title: string;
  meta: string;
  facts?: string[];
  /** Plain content, or `sections` for content with labelled parts. */
  text?: string;
  sections?: PaneSection[];
  className?: string;
  wide?: boolean;
}) {
  const parts: PaneSection[] = sections ?? [{ title: "", text: text ?? "" }];
  const whole = parts.map((p) => (p.title ? `[${p.title}]\n${p.text}` : p.text)).join("\n\n");
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(whole);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the text is still selectable below.
    }
  }
  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className={cn("flex items-center gap-2 pt-2.5 pb-1.5 text-xs", wide ? "px-6" : "pr-3 pl-5")}>
        <span className="font-semibold">{title}</span>
        <span className="font-mono text-[11px] opacity-50">{meta}</span>
        <button
          type="button"
          onClick={copy}
          disabled={!whole}
          className="ml-auto inline-flex h-6 items-center gap-1.5 rounded-full bg-background/10 px-2.5 text-[11.5px] hover:bg-background/15 disabled:opacity-40"
        >
          {copied ? <Check className="size-3" strokeWidth={2.5} /> : <Copy className="size-3" strokeWidth={2.5} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {facts.length > 0 && (
        <div className={cn("flex flex-wrap gap-1.5 pb-2 text-[11px]", wide ? "px-6" : "px-5")}>
          {facts.map((f) => (
            <span key={f} className="rounded-full bg-accent-2-500/25 px-2 py-0.5 text-accent-2-300">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className={cn("min-h-0 flex-1 overflow-auto pb-4", wide ? "px-6" : "px-5")}>
        {parts.map((p, i) => (
          <div key={i} className={cn(i > 0 && "mt-4 border-t border-background/10 pt-3")}>
            {p.title && (
              <span className="mb-1.5 block text-[11px] tracking-wide uppercase opacity-50">{p.title}</span>
            )}
            <pre className="m-0 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap text-neutral-200">{p.text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function CallerBadge({ caller, large = false }: { caller: ModelCall["caller"]; large?: boolean }) {
  const tone =
    caller === "chat"
      ? "bg-accent-700 text-accent-100"
      : caller === "outline" || caller === "outline_revision"
        ? "bg-accent-2-700 text-accent-2-100"
        : "bg-neutral-700 text-neutral-100";
  return (
    <span className={cn("shrink-0 rounded-full font-sans font-semibold", tone, large ? "px-2.5 py-1 text-[11.5px]" : "px-2 py-px text-[11px]")}>
      {caller}
    </span>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="rounded-full bg-background/10 px-2.5 py-1">{children}</span>;
}

function IconButton({
  label,
  onClick,
  children,
  disabled = false,
  plain = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  plain?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex size-8 items-center justify-center rounded-full text-background hover:bg-background/10 disabled:opacity-40",
        !plain && "border border-background/20",
      )}
    >
      {children}
    </button>
  );
}

function downloadJson(calls: ModelCall[]) {
  const blob = new Blob([JSON.stringify(calls, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `model-calls-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function shortModel(model: string): string {
  return model.split("/")[1] ?? model;
}
