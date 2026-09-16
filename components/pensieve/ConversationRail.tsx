"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronRight, Lock, MessageCircle, PencilLine, Send, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { hasUserTurn, undoableChangeId, type ChatMessage } from "@/lib/planChat";
import type { SourceInput, SourceType } from "@/lib/schemas/source";
import { cn } from "@/lib/utils";

const SOURCE_CHIP: Record<SourceType, { kicker: string; variant: "accent2" | "tagOutline" | "accent" | "neutral" }> = {
  youtube: { kicker: "YouTube · ", variant: "accent2" },
  link: { kicker: "Link · ", variant: "tagOutline" },
  file: { kicker: "File · ", variant: "accent" },
  note: { kicker: "Topic · ", variant: "neutral" },
};

function sourceLabel(source: SourceInput): string {
  if (source.type === "note") return source.url;
  return source.url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

interface ConversationRailProps {
  mode: "create" | "adjust";
  messages: ChatMessage[];
  open: boolean;
  unread: boolean;
  busy: boolean;
  input: string;
  suggestions: string[];
  onToggle: () => void;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onUndo: (messageId: string) => void;
}

export function ConversationRail({
  mode,
  messages,
  open,
  unread,
  busy,
  input,
  suggestions,
  onToggle,
  onInputChange,
  onSend,
  onUndo,
}: ConversationRailProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const undoId = undoableChangeId(messages);
  const showSuggestions = !busy && !hasUserTurn(messages);
  const canSend = !busy && input.trim().length > 0;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  const placeholder = busy
    ? "Pensieve is thinking…"
    : mode === "adjust"
      ? "e.g. add two more days on caching"
      : "e.g. why is week 2 before week 3? · swap weeks 3 and 4";

  return (
    <>
      {/* Desktop collapsed tab */}
      <div className={cn("sticky top-5 flex-col items-center gap-2", open ? "hidden" : "hidden min-[901px]:flex")}>
        <button
          type="button"
          onClick={onToggle}
          title="Open conversation"
          aria-label="Open conversation"
          className="relative inline-flex size-11 items-center justify-center rounded-full bg-secondary shadow-sm hover:bg-accent-100"
        >
          <MessageCircle className="size-[18px]" strokeWidth={2.75} />
          {unread && <span className="absolute top-2 right-2 size-[9px] rounded-full border-2 border-secondary bg-primary" />}
        </button>
        <span className="text-[11px] tracking-wide uppercase opacity-55 [writing-mode:vertical-rl]">Conversation</span>
      </div>

      {/* Rail: sticky column on desktop, bottom sheet on mobile */}
      <aside
        aria-label="Conversation"
        className={cn(
          "flex min-w-0 flex-col overflow-hidden rounded-[28px] bg-secondary shadow-sm",
          "min-[901px]:sticky min-[901px]:top-5 min-[901px]:h-[calc(100vh-40px)] min-[901px]:max-h-[860px]",
          !open && "min-[901px]:hidden",
          "max-[900px]:fixed max-[900px]:inset-x-0 max-[900px]:bottom-0 max-[900px]:z-30 max-[900px]:rounded-b-none max-[900px]:shadow-lg max-[900px]:transition-transform max-[900px]:duration-300",
          open ? "max-[900px]:h-[78vh] max-[900px]:translate-y-0" : "max-[900px]:translate-y-[calc(100%-64px)]",
        )}
      >
        <div className="mx-auto mt-2.5 hidden h-1 w-10 rounded-full bg-neutral-400 max-[900px]:block" />
        <div
          className="flex shrink-0 items-center gap-2.5 py-3 pr-3.5 pl-5 max-[900px]:cursor-pointer max-[900px]:pt-2"
          onClick={() => {
            if (window.innerWidth <= 900) onToggle();
          }}
        >
          <h3 className="mr-auto font-heading text-base">Conversation</h3>
          {!open && unread && (
            <Badge variant="accent" className="max-[900px]:inline-flex min-[901px]:hidden">
              New
            </Badge>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            title={open ? "Collapse" : "Open conversation"}
            aria-label={open ? "Collapse conversation" : "Open conversation"}
            className="inline-flex size-[34px] items-center justify-center rounded-full hover:bg-foreground/7 active:bg-accent-200"
          >
            <ChevronRight
              className={cn("size-[18px] transition-transform", open ? "max-[900px]:rotate-90" : "max-[900px]:-rotate-90")}
              strokeWidth={2.75}
            />
          </button>
        </div>

        <div ref={listRef} className="flex flex-1 flex-col gap-3.5 overflow-y-auto scroll-smooth px-5 pt-1 pb-3">
          {messages.map((m) => (
            <MessageView key={m.id} message={m} canUndo={m.id === undoId} onUndo={onUndo} />
          ))}
        </div>

        {showSuggestions && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-5 pb-2.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onInputChange(s)}
                className="rounded-full border border-border px-3 py-[5px] text-xs hover:border-accent-300 hover:bg-accent-100"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        <div className="flex shrink-0 flex-col gap-2 border-t border-foreground/8 px-3.5 pt-3 pb-3.5">
          <div className="flex items-end gap-2 rounded-[22px] bg-background py-1.5 pr-1.5 pl-4">
            <textarea
              rows={1}
              value={input}
              placeholder={placeholder}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy}
              className="max-h-[120px] min-w-0 flex-1 resize-none bg-transparent py-[7px] text-[13.5px] leading-normal outline-none placeholder:text-foreground/45"
            />
            <button
              type="button"
              aria-label="Send"
              disabled={!canSend}
              onClick={onSend}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-accent-600 active:bg-accent-700 disabled:cursor-default disabled:opacity-45"
            >
              <Send className="size-4" strokeWidth={2.75} />
            </button>
          </div>
          <span className="pl-4 text-[11px] opacity-50">
            Ask a question or describe a change — answers leave the plan alone.
          </span>
        </div>
      </aside>
    </>
  );
}

function MessageView({
  message: m,
  canUndo,
  onUndo,
}: {
  message: ChatMessage;
  canUndo: boolean;
  onUndo: (id: string) => void;
}) {
  switch (m.kind) {
    case "sys":
      return (
        <div className="flex items-start gap-2 rounded-2xl bg-background px-3 py-2.5 text-[12.5px] leading-normal opacity-80">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-accent-2-700" strokeWidth={2.75} />
          <span>{m.text}</span>
        </div>
      );
    case "brief":
      return (
        <div className="max-w-[88%] self-end">
          <div className="flex flex-col gap-2 rounded-[28px] rounded-br-md bg-accent-100 px-3.5 py-2.5 text-[13.5px] leading-normal">
            <span className="font-heading text-sm leading-tight">{m.topic}</span>
            <BriefRow label="Length">
              {m.days} days · {m.granularity} units
            </BriefRow>
            {m.focus?.trim() && <BriefRow label="Focus">{m.focus}</BriefRow>}
            {m.materials.length > 0 && (
              <BriefRow label="Materials">
                <span className="flex flex-wrap gap-1.5">
                  {m.materials.map((s) => (
                    <Badge key={s.url} variant={SOURCE_CHIP[s.type].variant} className="max-w-full truncate text-[11px] whitespace-nowrap">
                      {SOURCE_CHIP[s.type].kicker}
                      {sourceLabel(s)}
                    </Badge>
                  ))}
                </span>
              </BriefRow>
            )}
          </div>
        </div>
      );
    case "user":
      return (
        <div className="max-w-[88%] self-end">
          <div className="rounded-[28px] rounded-br-md bg-accent-100 px-3.5 py-2.5 text-[13.5px] leading-normal">{m.text}</div>
        </div>
      );
    case "answer":
      return (
        <div className="flex max-w-[96%] flex-col gap-1.5 self-start">
          <Who />
          <div className="py-0.5 text-[13.5px] leading-relaxed whitespace-pre-wrap">
            {m.text}
            {m.streaming && <Caret />}
          </div>
        </div>
      );
    case "change":
      return (
        <div className="flex max-w-[96%] flex-col gap-1.5 self-start">
          <Who />
          <div
            className={cn(
              "flex flex-col gap-2 rounded-2xl bg-accent-2-100 px-3.5 py-3 text-[13px] leading-normal",
              m.undone && "bg-neutral-200 opacity-75",
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 font-heading text-[11px] text-accent-2-800">
                <PencilLine className="size-[13px]" strokeWidth={2.75} />
                {m.undone ? "Change undone" : `Plan changed · ${m.level} level`}
              </span>
              {!m.undone && (
                <span className="flex flex-wrap gap-1.5">
                  {m.tags.map((t) => (
                    <Badge key={t} variant="accent2" className="text-[11px]">
                      {t}
                    </Badge>
                  ))}
                </span>
              )}
            </div>
            <p className="m-0 whitespace-pre-wrap">
              {m.text}
              {m.streaming && <Caret />}
            </p>
            {canUndo && !m.undone && !m.streaming && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => onUndo(m.id)}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-accent-2-800 hover:bg-accent-2-200 active:bg-accent-2-300"
                >
                  <Undo2 className="size-3.5" strokeWidth={2.75} />
                  Undo
                </button>
              </div>
            )}
          </div>
        </div>
      );
  }
}

function BriefRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px] leading-snug">
      <span className="min-w-[58px] shrink-0 opacity-55">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function Who() {
  return (
    <span className="inline-flex items-center gap-1.5 font-heading text-[11px] text-accent-700">
      <span className="size-2 rounded-full bg-primary" />
      Pensieve
    </span>
  );
}

function Caret() {
  return <span className="caret-blink ml-0.5 inline-block h-[13px] w-[2px] bg-primary align-[-2px]" />;
}
