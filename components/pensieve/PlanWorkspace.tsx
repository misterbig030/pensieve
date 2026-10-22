"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConversationRail } from "@/components/pensieve/ConversationRail";
import { MaterialsList } from "@/components/pensieve/MaterialsList";
import { ResearchProgress } from "@/components/pensieve/ResearchProgress";
import { TimeSplitCard } from "@/components/pensieve/TimeSplitCard";
import { KEY_ERRORS } from "@/lib/ai/models";
import type { Coverage, DroppedMaterial, ResearchNotice } from "@/lib/ai/research/events";
import { assignmentsOf, removeMaterialRefs } from "@/lib/materials";
import { initialResearch, reduceResearch, type ResearchProgressState } from "@/lib/researchProgress";
import { PlanTree, TreeLabel, type PendingSlots } from "@/components/pensieve/PlanTree";
import { PlanSummaryCard } from "@/components/pensieve/PlanSummaryCard";
import { formatCostUsd } from "@/lib/formatCost";
import { pushModelCalls } from "@/lib/modelCalls";
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
  capitalize,
  childSpans,
  cloneTree,
  currentLeaf,
  findNode,
  isLocked,
  fullLabelOf,
  labelOf,
  layout,
  lowerFirst,
  makeRoot,
  relength,
  replaceNode,
  settledWeeks,
  topLevelFor,
  topSpans,
  type Granularity,
  type PlanLevel,
  type PlanNode,
} from "@/lib/planTree";
import type { Material } from "@/lib/schemas/material";
import type { SourceInput } from "@/lib/schemas/source";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK, isAllReading, practiceLabelOf, rebudget, totalHours, weeksLabel, type PlanSplit } from "@/lib/studyTime";
import { cn } from "@/lib/utils";

export interface PlanWorkspaceProps {
  mode: "create" | "adjust";
  topic: string;
  /** The plan's length in weeks, as the learner set it. Adjust mode reads it off the tree. */
  weeks: number;
  /** The learner's usual study days a week: weeks not split yet have this many days. */
  daysPerWeek?: number;
  granularity: Granularity;
  /** Hours a week the learner can give; six on plans that never asked. */
  hoursPerWeek?: number;
  /** Adjust mode: the plan's saved time split. Create mode: omit and the drafter decides it. */
  initialSplit?: PlanSplit | null;
  instructions?: string;
  /** Create mode: the learner's own sources, as typed. Research adds to them. */
  sources: SourceInput[];
  /** Adjust mode: the saved materials list. */
  initialMaterials?: Material[];
  /** Adjust mode: the plan as it stands. Create mode: omit and the draft streams in. */
  initialTree?: PlanNode;
  lockBefore?: number;
  trackId?: string;
  backHref: string;
  backLabel: string;
  heading: string;
  subtext: string;
  onConfirm: (tree: PlanNode, summary: string, materials: Material[], time: { hoursPerWeek: number; daysPerWeek: number; split: PlanSplit | null }) => Promise<void>;
}

function leafLevel(level: PlanLevel, granularity: Granularity): boolean {
  return level === "day" || (level === "week" && granularity === "week");
}

/** Skeleton slots for the children a heading will get, or `null` when its children are leaves at this level. */
function slotsFor(node: PlanNode, granularity: Granularity, daysPerWeek: number): PendingSlots | null {
  const below = childLevel(node.level);
  if (!below) return null;
  return { count: childSpans(node, daysPerWeek).length, groups: !leafLevel(below, granularity) };
}

/** The code a refused user key travels with (see lib/ai/userKeyError); null for every other failure. */
const codeOf = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && (KEY_ERRORS as readonly string[]).includes(code) ? code : null;
};

export function PlanWorkspace(props: PlanWorkspaceProps) {
  const { mode, topic, weeks, granularity, instructions, sources, initialTree, lockBefore = 0, trackId } = props;
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
  /** Set when the failure is a refused user key: the message then links to Settings. */
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Admin dock: it lives in PageShell. This page only pushes the `call` events the server sends (admins only) into the shared store.
  // Research runs first in create mode; its list is what every unit references.
  const [materials, setMaterials] = useState<Material[]>(() => props.initialMaterials ?? []);
  const [dropped, setDropped] = useState<DroppedMaterial[]>([]);
  const [notice, setNotice] = useState<ResearchNotice | undefined>(undefined);
  const [research, setResearch] = useState<ResearchProgressState | null>(null);
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  // The learner's hours and the plan's split: both can be changed here, and both are sent with every later request.
  const [hoursPerWeek, setHoursPerWeek] = useState<number>(props.hoursPerWeek ?? DEFAULT_HOURS_PER_WEEK);
  const [daysPerWeek, setDaysPerWeek] = useState<number>(props.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK);
  const [split, setSplit] = useState<PlanSplit | null>(props.initialSplit ?? null);
  const hoursRef = useRef(hoursPerWeek);
  const daysRef = useRef(daysPerWeek);

  const railOpenRef = useRef(railOpen);
  const draftStarted = useRef(false);

  useEffect(() => {
    railOpenRef.current = railOpen;
  }, [railOpen]);
  useEffect(() => {
    hoursRef.current = hoursPerWeek;
  }, [hoursPerWeek]);
  useEffect(() => {
    daysRef.current = daysPerWeek;
  }, [daysPerWeek]);

  const pushAssistant = useCallback((text: string) => {
    setMessages((ms) => [...ms, { id: nextMessageId(), kind: "answer", text, streaming: false }]);
    if (!railOpenRef.current) setUnread(true);
  }, []);

  const streamDraft = useCallback(async () => {
    setDrafting(true);
    setError(null);
    setErrorCode(null);
    setTree(makeRoot([]));
    setMaterials([]);
    setDropped([]);
    setNotice(undefined);
    setCoverage(null);
    setSplit(null);
    setResearch(initialResearch());
    const topLevel = topLevelFor(weeks);
    const spans = topSpans(weeks, daysRef.current);
    // `debug` is always requested; the server only honours it for admins, so the switch is purely a view toggle.
    const body: PlanDraftRequest = { topic, weeks, daysPerWeek: daysRef.current, granularity, instructions, materials: sources, hoursPerWeek: hoursRef.current, debug: true };
    const learnerUrls = new Set(sources.map((s) => s.url));
    // The stream is the source of truth while drafting; React state is a snapshot of these two.
    const draftRoot = makeRoot([]);
    draftRoot.len = spans.reduce((a, b) => a + b, 0);
    const slots: Record<string, PendingSlots> = { root: { count: spans.length, groups: !leafLevel(topLevel, granularity) } };
    let researched: Material[] = [];
    let decided: PlanSplit | null = null;
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
        if (event.type === "call") {
          pushModelCalls([event.call]);
        } else if (event.type.startsWith("research.")) {
          const researchEvent = event as Extract<PlanDraftEvent, { type: `research.${string}` }>;
          setResearch((r) => reduceResearch(r ?? initialResearch(), researchEvent, learnerUrls));
          if (researchEvent.type === "research.done") {
            researched = researchEvent.materials;
            setMaterials(researchEvent.materials);
            setDropped(researchEvent.dropped);
            setNotice(researchEvent.notice);
            setCoverage(researchEvent.coverage ?? null);
            publish();
          }
        } else if (event.type === "split") {
          decided = event.split;
          setSplit(event.split);
        } else if (event.type === "node") {
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
            const kids = slotsFor(event.node, granularity, daysRef.current);
            if (kids) slots[event.node.id] = kids;
          }
          publish();
        } else if (event.type === "finish") {
          finished = true;
          setTree(layout(event.root));
          setPending({});
          setCostUsd((c) => c + event.costUsd);
          setDrafting(false);
          pushAssistant(draftedText(layout(event.root), weeks, researched, decided));
        } else if (event.type === "error") {
          throw Object.assign(new Error(event.message), { code: event.code });
        }
      });
      if (!finished) throw new Error("The draft ended early. Try again.");
    } catch (err) {
      setDrafting(false);
      setPending({});
      setResearch((r) => (r ? { ...r, running: false, reading: null } : r));
      setError(err instanceof Error ? err.message : "Drafting failed. Try again.");
      setErrorCode(codeOf(err));
    }
  }, [topic, weeks, granularity, instructions, sources, pushAssistant]);

  useEffect(() => {
    if (initialTree || draftStarted.current) return;
    draftStarted.current = true;
    void streamDraft();
  }, [initialTree, streamDraft]);

  const lockNote = isAdjust && lockBefore > 0 ? `${lockedRange(lockBefore)} locked.` : "";
  // While the draft streams in, the plan is the length the learner set; units still planning count as they were.
  const planWeeks = drafting || !tree.children || tree.children.length === 0 ? weeks : settledWeeks(tree, Object.keys(pending), daysPerWeek);
  const note = [lockNote, summaryNote].filter(Boolean).join(" ");
  const summary = drafting ? "" : summarizePlan(tree, topic, daysPerWeek, note || undefined);

  async function expand(nodeId: string, reason: "expand" | "split", splitDays?: number) {
    const node = findNode(tree, nodeId);
    if (!node || busy || drafting || expanding) return;
    const days = reason === "split" ? (splitDays ?? node.len) : undefined;
    const slots = days !== undefined ? { count: days, groups: false } : slotsFor(node, granularity, daysPerWeek);
    if (!slots) return;
    // A split that fails puts the week back as it was: its length, its Read table, no partial days.
    const before = cloneTree(node);
    // A week split into another number of days takes that length now, so the days stream into the right span.
    if (days !== undefined && days !== node.len) {
      setTree((t) => {
        const next = cloneTree(t);
        const week = findNode(next, nodeId);
        if (week) week.len = days;
        return layout(next);
      });
    }
    setExpanding(true);
    setError(null);
    setErrorCode(null);
    setPending((p) => ({ ...p, [nodeId]: slots }));
    setCollapsed((c) => {
      const next = new Set(c);
      next.delete(nodeId);
      return next;
    });
    const body: PlanExpandRequest = {
      topic,
      weeks: planWeeks,
      daysPerWeek,
      granularity,
      instructions,
      materials,
      hoursPerWeek,
      split,
      tree: toTreeInput(tree),
      nodeId,
      reason,
      splitDays: days,
      debug: true,
    };
    const label = fullLabelOf(tree, node);
    try {
      const response = await fetch("/api/plan/expand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      let finished = false;
      await readNdjson<PlanExpandEvent>(response, (event) => {
        if (event.type === "call") {
          pushModelCalls([event.call]);
        } else if (event.type === "child") {
          setTree((t) => {
            const next = cloneTree(t);
            const parent = findNode(next, nodeId);
            if (!parent) return t;
            parent.children = [...(parent.children ?? []), event.node];
            if (reason === "split") splitWeek(parent);
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
            if (reason === "split") splitWeek(parent);
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
            setMessages((ms) => [...ms, { id: nextMessageId(), kind: "sys", text: `You split ${label} into ${planned.length} day${planned.length === 1 ? "" : "s"} by hand. The rest of the plan stays in weeks.` }]);
          } else {
            pushAssistant(`Planned ${label}: ${shown}${more}. Say "collapse ${label.toLowerCase()} back" if you would rather leave it for later.`);
          }
        } else if (event.type === "error") {
          throw Object.assign(new Error(event.message), { code: event.code });
        }
      });
      if (!finished) throw new Error("Planning ended early. Try again.");
    } catch (err) {
      setPending((p) => {
        const next = { ...p };
        delete next[nodeId];
        return next;
      });
      if (reason === "split") setTree((t) => layout(replaceNode(t, before)));
      setError(err instanceof Error ? err.message : "Planning failed. Try again.");
      setErrorCode(codeOf(err));
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
    setErrorCode(null);

    const body: PlanChatRequest = {
      mode,
      topic,
      weeks: planWeeks,
      daysPerWeek,
      granularity,
      instructions,
      materials,
      hoursPerWeek,
      split,
      tree: toTreeInput(tree),
      lockBefore: isAdjust ? lockBefore : undefined,
      trackId,
      transcript: toTranscript(history),
      debug: true,
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
          case "call":
            pushModelCalls([event.call]);
            break;
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
            throw Object.assign(new Error(event.message), { code: event.code });
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

  function removeMaterial(id: string) {
    const removed = materials.find((m) => m.id === id);
    setMaterials((ms) => ms.filter((m) => m.id !== id));
    setTree((t) => layout(removeMaterialRefs(t, id)));
    if (removed) setMessages((ms) => [...ms, { id: nextMessageId(), kind: "sys", text: `Removed ${removed.title} from the materials and from the units that used it.` }]);
  }

  function changeHours(hours: number) {
    if (hours === hoursPerWeek) return;
    setHoursPerWeek(hours);
    // Open weeks take the new budget at once; reading lists already planned are left as they are.
    setTree((t) => layout(rebudget(t, hours, isAdjust ? lockBefore : 0)));
    setTimeNote(`Time set to ${hours} h a week, about ${totalHours(planWeeks, hours)} hours in all. Open weeks are budgeted from it now; units planned from here on use it.`);
  }

  function changeDays(days: number) {
    if (days === daysPerWeek) return;
    setDaysPerWeek(days);
    // Weeks not split yet take the new number of days; weeks already split keep theirs.
    setTree((t) => relength(t, daysPerWeek, days, isAdjust ? lockBefore : 0));
    setTimeNote(`Set to ${days} study day${days === 1 ? "" : "s"} a week. Weeks you split from here on have ${days} day${days === 1 ? "" : "s"}; weeks already split keep theirs.`);
  }

  function changeSplit(next: PlanSplit) {
    setSplit(next);
    setTimeNote(`The plan now spends about ${next.readingShare}% of your time reading${isAllReading(next) ? "" : ` and the rest on ${practiceLabelOf(next)}`}. Units planned from here on follow it.`);
  }

  /** One sys line for time changes, replaced as the learner keeps adjusting, so the rail is not flooded. */
  function setTimeNote(text: string) {
    setMessages((ms) => {
      const last = ms[ms.length - 1];
      if (last && last.kind === "sys" && last.id.startsWith("time-")) return [...ms.slice(0, -1), { ...last, text }];
      return [...ms, { id: `time-${nextMessageId()}`, kind: "sys", text }];
    });
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
    setErrorCode(null);
    try {
      await props.onConfirm(tree, summary, materials, { hoursPerWeek, daysPerWeek, split });
    } catch (err) {
      unstable_rethrow(err);
      setError(err instanceof Error ? err.message : "Could not save the plan. Try again.");
      setConfirming(false);
    }
  }

  const tops = tree.children ?? [];
  const topLevel = tops[0]?.level ?? topLevelFor(weeks);
  const suggestions = isAdjust
    ? ["Add two more days on caching", "Why is the next week next?", "Swap the last two weeks"]
    : topLevel === "day"
      ? ["Why is this first?", "Add a day on the hardest part", "Make it one day shorter"]
      : topLevel === "month"
        ? ["Why is month 2 before month 3?", "Last month should be 2 weeks", "Swap months 3 and 4"]
        : ["Why is week 2 before week 3?", "Expand week 2", "Swap weeks 3 and 4"];
  const streaming = drafting || expanding;
  const researching = drafting && !!research?.running;
  const canConfirm = !streaming && !revising && !busy && !confirming && tops.length > 0;
  const current = isAdjust ? currentLeaf(tree) : null;
  const draftingText = researching
    ? "Finding materials…"
    : drafting
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
          {researching && research ? (
            <>
              <ResearchProgress state={research} totalHours={totalHours(weeks, hoursPerWeek)} />
              <div className="flex flex-col gap-2.5">
                <TreeLabel>Plan</TreeLabel>
                <div className="flex h-16 items-center rounded-[28px] bg-foreground/5 px-[22px] text-[13px] text-muted-foreground">
                  {capitalize(topLevel)}s start drafting as soon as the materials list is set.
                </div>
                <div className="h-16 rounded-[28px] bg-foreground/4" />
                <div className="h-16 rounded-[28px] bg-foreground/3" />
              </div>
            </>
          ) : (
            <>
          <PlanSummaryCard summary={summary} loading={drafting} changed={highlight.length > 0} />
          <TimeSplitCard
            weeks={planWeeks}
            hoursPerWeek={hoursPerWeek}
            daysPerWeek={daysPerWeek}
            split={split}
            materials={materials}
            deciding={drafting && !split}
            onChangeHours={changeHours}
            // A one-week plan is its days: a different number is a change to ask for in the conversation.
            onChangeDays={topLevel === "day" ? undefined : changeDays}
            onChangeSplit={changeSplit}
            disabled={streaming || busy || confirming}
          />
          <MaterialsList
            topic={topic}
            materials={materials}
            dropped={dropped}
            notice={notice}
            coverage={coverage}
            totalHours={totalHours(planWeeks, hoursPerWeek)}
            usesOf={(id) => assignmentsOf(tree, id).map(({ label, role }) => ({ label, role }))}
            onRemove={streaming || busy || confirming ? undefined : removeMaterial}
            onResearchAgain={isAdjust || streaming || busy || confirming ? undefined : () => void streamDraft()}
          />
          <TreeLabel>{topLevel === "day" ? "Plan at a glance" : "Plan"}</TreeLabel>
          <PlanTree
            materials={materials}
            hoursPerWeek={hoursPerWeek}
            daysPerWeek={daysPerWeek}
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
            onSplit={(id, days) => void expand(id, "split", days)}
          />
            </>
          )}
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
          {error && (
            <p className="text-sm text-red-600">
              {error}
              {errorCode && (
                <>
                  {" "}
                  <Link href="/settings" className="underline">
                    Open Settings
                  </Link>
                </>
              )}
            </p>
          )}
        </div>

        <ConversationRail
          mode={mode}
          messages={messages}
          open={railOpen}
          unread={unread}
          busy={busy || streaming}
          disabledHint={drafting ? "Available once the plan is drafted" : undefined}
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

/** "1 completed day is" / "5 completed days are", for lock notices. Days are numbered by week, so they are counted. */
function lockedRange(lockBefore: number): string {
  return lockBefore === 1 ? "1 completed day is" : `${lockBefore} completed days are`;
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

/** A week split into days by hand: its Read table and practice rows become the reservation its days were planned from. */
function splitWeek(week: PlanNode): void {
  week.manualSplit = true;
  week.budgetHours = null;
  if (week.materials) {
    week.covers = week.materials.map((r) => ({ id: r.id, note: r.note, chapter: r.chapter, activity: r.activity, tier: r.tier, minutes: r.minutes }));
    delete week.materials;
  }
  if (week.practice) {
    week.practiceCovers = week.practice.map((r) => ({ format: r.format, id: r.id, note: null, task: r.task, minutes: r.minutes }));
    delete week.practice;
  }
}

function materialsText(materials: Material[]): string {
  const backbone = materials.find((m) => m.backbone);
  const researched = materials.filter((m) => m.origin === "research").length;
  if (backbone) {
    const by = [backbone.author, backbone.year].filter(Boolean).join(", ");
    const others = materials.length - 1;
    return `Built the plan around ${backbone.title}${by ? ` (${by})` : ""}, with ${others} more material${others === 1 ? "" : "s"} listed above. `;
  }
  if (researched > 0) return `No textbook stood out, so units draw on the ${materials.length} materials above directly. `;
  return "";
}

function draftedText(root: PlanNode, weeks: number, materials: Material[] = [], split: PlanSplit | null = null): string {
  const tops = root.children ?? [];
  if (tops.length === 0) return "Nothing was drafted. Try again.";
  // An all-reading plan says only that: there is no rest to name.
  const share = (s: PlanSplit) => (s.readingShare >= 100 ? "all of your time" : `about ${s.readingShare}% of your time`);
  const time = split ? `I planned ${share(split)} for reading${isAllReading(split) ? "" : ` and the rest for ${practiceLabelOf(split)}`}; change that above if it is off. ` : "";
  const lead = `${materialsText(materials)}${time}`;
  const level = tops[0].level;
  if (level === "day") return `${lead}Drafted ${tops.length} days, one topic each. Ask me why something sits where it does, or tell me what to change.`;
  const first = tops[0];
  const firstKid = first.children?.[0];
  const deeper = firstKid && firstKid.children ? ` and ${labelOf(root, firstKid)} of it into days` : firstKid && firstKid.level === "day" ? " day by day" : firstKid ? " into weeks" : "";
  return `${lead}Drafted ${weeksLabel(weeks)} as ${tops.length} ${level}s and planned ${labelOf(root, first)}${deeper}. Later ${level}s stay as headings until you reach them — they get planned with what you actually learned. Ask why something sits where it does, or tell me what to change.`;
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
            ? `${lockedRange(lockBefore)} locked — ${names}. The other ${root.len - lockBefore} ${root.len - lockBefore === 1 ? "day is" : "days are"} open to change.`
            : `Nothing is checked off yet, so the whole plan is open to change.`,
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
      weeks: props.weeks,
      daysPerWeek: props.daysPerWeek ?? DEFAULT_DAYS_PER_WEEK,
      granularity: props.granularity,
      hoursPerWeek: props.hoursPerWeek,
      focus: props.instructions,
      materials: props.sources,
    },
  ];
}
