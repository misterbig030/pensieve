"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConversationRail } from "@/components/pensieve/ConversationRail";
import { PlanTree, TreeLabel, type PendingSlots } from "@/components/pensieve/PlanTree";
import { PlanSummaryCard } from "@/components/pensieve/PlanSummaryCard";
import { formatCostUsd } from "@/lib/formatCost";
import { readNdjson } from "@/lib/ndjson";
import {
  nextMessageId,
  toTranscript,
  type ChatMessage,
  type PlanChatEvent,
  type PlanChatRequest,
  type PlanDraftEvent,
  type PlanDraftRequest,
  type PlanExpandEvent,
  type PlanExpandRequest,
} from "@/lib/planChat";
import { toTreeInput } from "@/lib/planInput";
import { latestChangeNote, summarizePlan } from "@/lib/planSummary";
import {
  childLevel,
  childSpans,
  cloneTree,
  currentLeaf,
  findNode,
  isLocked,
  labelOf,
  layout,
  lowerFirst,
  makeRoot,
  topLevelFor,
  topSpans,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { SourceInput } from "@/lib/schemas/source";
import { cn } from "@/lib/utils";

export interface PlanWorkspaceProps {
  mode: "create" | "adjust";
  topic: string;
  days: number;
  granularity: Granularity;
  instructions?: string;
  sources: SourceInput[];
  /** Adjust mode: the plan as it stands. Create mode: omit and the draft streams in. */
  initialTree?: PlanNode;
  lockBefore?: number;
  trackId?: string;
  backHref: string;
  backLabel: string;
  heading: string;
  subtext: string;
  onConfirm: (tree: PlanNode, summary: string) => Promise<void>;
}

function leafLevel(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
}

/** Skeleton slots for the children a heading will get, or `null` when its children are leaves at this level. */
function slotsFor(node: PlanNode, granularity: Granularity): PendingSlots | null {
  const below = childLevel(node.level);
  if (!below) return null;
  return { count: childSpans(node).length, groups: !leafLevel(below, granularity) };
}

export function PlanWorkspace(props: PlanWorkspaceProps) {
  const { mode, topic, days, granularity, instructions, sources, initialTree, lockBefore = 0, trackId } = props;
  const isAdjust = mode === "adjust";

  const [tree, setTree] = useState<PlanNode>(() => (initialTree ? layout(cloneTree(initialTree)) : makeRoot([])));
  const [pending, setPending] = useState<Record<string, PendingSlots>>({});
  const [drafting, setDrafting] = useState<boolean>(!initialTree);
  const [expanding, setExpanding] = useState(false);
  const [revising, setRevising] = useState(false);
  const [summaryNote, setSummaryNote] = useState("");
  const [costUsd, setCostUsd] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages(props));
  const [highlight, setHighlight] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [openChips, setOpenChips] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const isNarrow = useSyncExternalStore(subscribeNarrow, getNarrowSnapshot, getNarrowServerSnapshot);
  const [railToggled, setRailToggled] = useState<boolean | null>(null);
  const railOpen = railToggled ?? !isNarrow;
  const [unread, setUnread] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const railOpenRef = useRef(railOpen);
  const draftStarted = useRef(false);

  useEffect(() => {
    railOpenRef.current = railOpen;
  }, [railOpen]);

  const pushAssistant = useCallback((text: string) => {
    setMessages((ms) => [...ms, { id: nextMessageId(), kind: "answer", text, streaming: false }]);
    if (!railOpenRef.current) setUnread(true);
  }, []);

  const streamDraft = useCallback(async () => {
    setDrafting(true);
    setError(null);
    setTree(makeRoot([]));
    const topLevel = topLevelFor(days);
    const body: PlanDraftRequest = { topic, days, granularity, instructions, sources };
    // The stream is the source of truth while drafting; React state is a snapshot of these two.
    const draftRoot = makeRoot([]);
    draftRoot.len = days;
    const slots: Record<string, PendingSlots> = { root: { count: topSpans(days).length, groups: !leafLevel(topLevel, granularity) } };
    const publish = () => {
      setTree(cloneTree(layout(draftRoot, 1, new Set(Object.keys(slots)))));
      setPending({ ...slots });
    };
    try {
      const response = await fetch("/api/plan/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let finished = false;
      await readNdjson<PlanDraftEvent>(response, (event) => {
        if (event.type === "node") {
          const parent = findNode(draftRoot, event.parentId);
          if (!parent) return;
          const firstChild = !parent.children || parent.children.length === 0;
          parent.children = [...(parent.children ?? []), event.node];
          const slot = slots[event.parentId];
          if (slot) {
            if (slot.count <= 1) delete slots[event.parentId];
            else slots[event.parentId] = { ...slot, count: slot.count - 1 };
          }
          // Only the first branch is planned in detail at creation: the first unit, then its first child.
          if (firstChild && onFirstBranch(draftRoot, event.parentId)) {
            const kids = slotsFor(event.node, granularity);
            if (kids) slots[event.node.id] = kids;
          }
          publish();
        } else if (event.type === "finish") {
          finished = true;
          setTree(layout(event.root));
          setPending({});
          setCostUsd((c) => c + event.costUsd);
          setDrafting(false);
          pushAssistant(draftedText(layout(event.root)));
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      });
      if (!finished) throw new Error("The draft ended early. Try again.");
    } catch (err) {
      setDrafting(false);
      setPending({});
      setError(err instanceof Error ? err.message : "Drafting failed. Try again.");
    }
  }, [topic, days, granularity, instructions, sources, pushAssistant]);

  useEffect(() => {
    if (initialTree || draftStarted.current) return;
    draftStarted.current = true;
    void streamDraft();
  }, [initialTree, streamDraft]);

  const lockNote = isAdjust && lockBefore > 0 ? `${lockedRange(lockBefore)} locked.` : "";
  const note = [lockNote, summaryNote].filter(Boolean).join(" ");
  const summary = drafting ? "" : summarizePlan(tree, topic, note || undefined);

  async function expand(nodeId: string, reason: "expand" | "split") {
    const node = findNode(tree, nodeId);
    if (!node || busy || drafting || expanding) return;
    const slots = reason === "split" ? { count: node.len, groups: false } : slotsFor(node, granularity);
    if (!slots) return;
    setExpanding(true);
    setError(null);
    setPending((p) => ({ ...p, [nodeId]: slots }));
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(nodeId);
      return next;
    });
    const body: PlanExpandRequest = { topic, days: tree.len, granularity, instructions, sources, tree: toTreeInput(tree), nodeId, reason };
    const label = labelOf(tree, node);
    try {
      const response = await fetch("/api/plan/expand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let finished = false;
      await readNdjson<PlanExpandEvent>(response, (event) => {
        if (event.type === "child") {
          setTree((t) => {
            const next = cloneTree(t);
            const parent = findNode(next, nodeId);
            if (!parent) return t;
            parent.children = [...(parent.children ?? []), event.node];
            if (reason === "split") {
              parent.manualSplit = true;
              parent.budgetHours = null;
            }
            return layout(next, 1, new Set([nodeId]));
          });
          setPending((p) => {
            const slot = p[nodeId];
            if (!slot) return p;
            const next = { ...p };
            if (slot.count <= 1) delete next[nodeId];
            else next[nodeId] = { ...slot, count: slot.count - 1 };
            return next;
          });
        } else if (event.type === "finish") {
          finished = true;
          const planned = event.children.map((c) => c.title);
          setTree((t) => {
            const next = cloneTree(t);
            const parent = findNode(next, nodeId);
            if (!parent) return t;
            parent.children = event.children;
            if (reason === "split") {
              parent.manualSplit = true;
              parent.budgetHours = null;
            }
            return layout(next);
          });
          setPending((p) => {
            const next = { ...p };
            delete next[nodeId];
            return next;
          });
          setCostUsd((c) => c + event.costUsd);
          const shown = planned.slice(0, 3).map(lowerFirst).join(", ");
          const more = planned.length > 3 ? ` and ${planned.length - 3} more` : "";
          if (reason === "split") {
            setMessages((ms) => [...ms, { id: nextMessageId(), kind: "sys", text: `You split ${label} into days by hand. The rest of the plan stays in weeks.` }]);
          } else {
            pushAssistant(`Planned ${label}: ${shown}${more}. Say "collapse ${label.toLowerCase()} back" if you would rather leave it for later.`);
          }
        } else if (event.type === "error") {
          throw new Error(event.message);
        }
      });
      if (!finished) throw new Error("Planning ended early. Try again.");
    } catch (err) {
      setPending((p) => {
        const next = { ...p };
        delete next[nodeId];
        return next;
      });
      setError(err instanceof Error ? err.message : "Planning failed. Try again.");
    } finally {
      setExpanding(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || drafting || expanding) return;
    const userMessage: ChatMessage = { id: nextMessageId(), kind: "user", text };
    const history = [...messages, userMessage];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError(null);

    const body: PlanChatRequest = {
      mode,
      topic,
      days: tree.len,
      granularity,
      instructions,
      sources,
      tree: toTreeInput(tree),
      lockBefore: isAdjust ? lockBefore : undefined,
      trackId,
      transcript: toTranscript(history),
    };

    let activeId: string | null = null;
    let activeKind: "answer" | "change" | null = null;
    let treeBefore = tree;
    let noteBefore = summaryNote;
    let changeText = "";

    const appendText = (delta: string) => {
      if (!activeId) {
        activeId = nextMessageId();
        activeKind = "answer";
        const id = activeId;
        setMessages((ms) => [...ms, { id, kind: "answer", text: delta, streaming: true }]);
        return;
      }
      const id = activeId;
      if (activeKind === "change") changeText += delta;
      setMessages((ms) =>
        ms.map((m) => (m.id === id && (m.kind === "answer" || m.kind === "change") ? { ...m, text: m.text + delta } : m)),
      );
    };

    try {
      const response = await fetch("/api/plan/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await readNdjson<PlanChatEvent>(response, (event) => {
        switch (event.type) {
          case "text":
            appendText(event.text);
            break;
          case "revising":
            setRevising(true);
            break;
          case "revised": {
            setRevising(false);
            setCostUsd((c) => c + event.costUsd);
            const emptyAnswerId = activeKind === "answer" ? activeId : null;
            const changeId = nextMessageId();
            const prevTree = treeBefore;
            const prevNote = noteBefore;
            const next = layout(event.tree);
            setMessages((ms) => {
              const kept = ms.filter((m) => !(m.id === emptyAnswerId && m.kind === "answer" && m.text.trim() === ""));
              return [
                ...kept,
                {
                  id: changeId,
                  kind: "change",
                  text: "",
                  level: event.changed.level,
                  nodeIds: event.changed.ids,
                  tags: event.changed.tags,
                  prevTree,
                  prevNote,
                  undone: false,
                  streaming: true,
                },
              ];
            });
            activeId = changeId;
            activeKind = "change";
            changeText = "";
            treeBefore = next;
            setTree(next);
            setHighlight(event.changed.ids);
            setSummaryNote("");
            noteBefore = "";
            break;
          }
          case "finish":
            setCostUsd((c) => c + event.costUsd);
            break;
          case "error":
            throw new Error(event.message);
        }
      });
      if (activeKind === "change") setSummaryNote(latestChangeNote(changeText));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong. Try again.";
      setMessages((ms) => [...ms, { id: nextMessageId(), kind: "sys", text: message }]);
    } finally {
      setRevising(false);
      setBusy(false);
      const id = activeId;
      if (id) {
        setMessages((ms) =>
          ms.map((m) => (m.id === id && (m.kind === "answer" || m.kind === "change") ? { ...m, streaming: false } : m)),
        );
      }
      if (!railOpenRef.current) setUnread(true);
    }
  }

  function undo(messageId: string) {
    const target = messages.find((m) => m.id === messageId);
    if (!target || target.kind !== "change" || target.undone) return;
    setTree(layout(cloneTree(target.prevTree)));
    setSummaryNote(target.prevNote);
    setHighlight(target.nodeIds);
    setMessages((ms) => ms.map((m) => (m.id === messageId && m.kind === "change" ? { ...m, undone: true } : m)));
  }

  async function confirm() {
    setConfirming(true);
    setError(null);
    try {
      await props.onConfirm(tree, summary);
    } catch (err) {
      unstable_rethrow(err);
      setError(err instanceof Error ? err.message : "Could not save the plan. Try again.");
      setConfirming(false);
    }
  }

  const tops = tree.children ?? [];
  const topLevel = tops[0]?.level ?? topLevelFor(days);
  const suggestions = isAdjust
    ? ["Add two more days on caching", "Why is the next week next?", "Swap the last two weeks"]
    : topLevel === "day"
      ? ["Why is this first?", "Add a day on the hardest part", "Make it one day shorter"]
      : topLevel === "month"
        ? ["Why is month 2 before month 3?", "Last month should be 2 weeks", "Swap months 3 and 4"]
        : ["Why is week 2 before week 3?", "Expand week 2", "Swap weeks 3 and 4"];
  const streaming = drafting || expanding;
  const canConfirm = !streaming && !revising && !busy && !confirming && tops.length > 0;
  const current = isAdjust ? currentLeaf(tree) : null;
  const draftingText = drafting
    ? `Drafting ${countArrived(tree)} of ${countExpected(tree, pending)} units…`
    : expanding
      ? "Planning in detail…"
      : revising
        ? "Revising the plan…"
        : "";

  return (
    <div className="space-y-6">
      <div className="text-[13px] text-foreground/60">
        <Link href={props.backHref} className="hover:text-primary">
          ← {props.backLabel}
        </Link>
      </div>
      <div className="space-y-3 pb-1">
        <h1>{props.heading}</h1>
        <p className="text-muted-foreground">{props.subtext}</p>
      </div>

      <div
        className={cn(
          "grid items-start gap-7 transition-[grid-template-columns] duration-300",
          railOpen
            ? "min-[901px]:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]"
            : "min-[901px]:grid-cols-[minmax(0,1fr)_56px]",
        )}
      >
        <div className="flex min-w-0 flex-col gap-5 max-[900px]:pb-[72px]">
          <PlanSummaryCard summary={summary} loading={drafting} changed={highlight.length > 0} />
          <TreeLabel>{topLevel === "day" ? "Plan at a glance" : "Plan"}</TreeLabel>
          <PlanTree
            root={tree}
            mode={mode}
            highlight={new Set(highlight)}
            lockBefore={isAdjust ? lockBefore : 0}
            currentLeafId={current?.id ?? null}
            pending={pending}
            collapsed={collapsed}
            openChips={openChips}
            busy={streaming || busy}
            onToggle={(id) =>
              setCollapsed((c) => {
                const next = new Set(c);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggleChip={(id) =>
              setOpenChips((c) => {
                const next = new Set(c);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onExpand={(id) => void expand(id, "expand")}
            onSplit={(id) => void expand(id, "split")}
          />
          <div className="flex flex-wrap items-center gap-3.5 pt-2">
            <Button onClick={confirm} disabled={!canConfirm}>
              Confirm plan
            </Button>
            {draftingText && (
              <span className="inline-flex items-center gap-2 text-[13px] opacity-70">
                <span className="caret-blink size-2 rounded-full bg-primary" />
                {draftingText}
              </span>
            )}
            {error && !drafting && tops.length === 0 && (
              <Button variant="secondary" onClick={() => void streamDraft()}>
                Try again
              </Button>
            )}
            <p className="text-xs text-muted-foreground">Estimated cost: {formatCostUsd(costUsd)}</p>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <ConversationRail
          mode={mode}
          messages={messages}
          open={railOpen}
          unread={unread}
          busy={busy || streaming}
          input={input}
          suggestions={suggestions}
          onToggle={() => {
            setRailToggled(!railOpen);
            setUnread(false);
          }}
          onInputChange={setInput}
          onSend={() => void send()}
          onUndo={undo}
        />
      </div>
    </div>
  );
}

/** "Day 1 is" / "Days 1–5 are", for lock notices. */
function lockedRange(lockBefore: number): string {
  return lockBefore === 1 ? "Day 1 is" : `Days 1–${lockBefore} are`;
}

/** The root, the first top-level unit and its first child are the only parents planned in detail at creation. */
function onFirstBranch(root: PlanNode, parentId: string): boolean {
  if (parentId === root.id) return true;
  const first = root.children?.[0];
  if (!first) return false;
  return parentId === first.id || parentId === first.children?.[0]?.id;
}

function countArrived(root: PlanNode): number {
  let n = 0;
  const visit = (node: PlanNode) => {
    for (const c of node.children ?? []) {
      n += 1;
      visit(c);
    }
  };
  visit(root);
  return n;
}

function countExpected(root: PlanNode, pending: Record<string, PendingSlots>): number {
  return countArrived(root) + Object.values(pending).reduce((sum, s) => sum + s.count, 0);
}

function draftedText(root: PlanNode): string {
  const tops = root.children ?? [];
  if (tops.length === 0) return "Nothing was drafted. Try again.";
  const level = tops[0].level;
  if (level === "day") return `Drafted ${root.len} days, one topic each. Ask me why something sits where it does, or tell me what to change.`;
  const first = tops[0];
  const firstKid = first.children?.[0];
  const deeper = firstKid && firstKid.children ? ` and ${labelOf(root, firstKid)} of it into days` : firstKid && firstKid.level === "day" ? " day by day" : firstKid ? " into weeks" : "";
  return `Drafted ${root.len} days as ${tops.length} ${level}s and planned ${labelOf(root, first)}${deeper}. Later ${level}s stay as headings until you reach them — they get planned with what you actually learned. Ask why something sits where it does, or tell me what to change.`;
}

const NARROW_QUERY = "(max-width: 900px)";
function subscribeNarrow(onChange: () => void): () => void {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
function getNarrowSnapshot(): boolean {
  return window.matchMedia(NARROW_QUERY).matches;
}
function getNarrowServerSnapshot(): boolean {
  return false;
}

function initialMessages(props: PlanWorkspaceProps): ChatMessage[] {
  if (props.mode === "adjust" && props.initialTree) {
    const root = layout(cloneTree(props.initialTree));
    const lockBefore = props.lockBefore ?? 0;
    const lockedTops = (root.children ?? []).filter((c) => isLocked(c, lockBefore)).map((c) => labelOf(root, c));
    const names =
      lockedTops.length > 0
        ? `${lockedTops.join(" and ")} ${lockedTops.length > 1 ? "are" : "is"} already complete`
        : `you've already completed ${lockBefore === 1 ? "it" : "them"}`;
    return [
      {
        id: nextMessageId(),
        kind: "sys",
        text:
          lockBefore > 0
            ? `${lockedRange(lockBefore)} locked — ${names}. ${lockBefore + 1 === root.len ? `Day ${root.len} is` : `Days ${lockBefore + 1}–${root.len} are`} open to change.`
            : `Nothing is checked off yet, so all ${root.len} days are open to change.`,
      },
      {
        id: nextMessageId(),
        kind: "answer",
        text: "Here is the rest of your plan as it stands. Reorder or rework the open units, add or drop days inside the current one, or ask why something is where it is.",
        streaming: false,
      },
    ];
  }
  return [
    {
      id: nextMessageId(),
      kind: "brief",
      topic: props.topic,
      days: props.days,
      granularity: props.granularity,
      focus: props.instructions,
      materials: props.sources,
    },
  ];
}
