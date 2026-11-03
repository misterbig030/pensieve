"use client";

import Link from "next/link";
import { Coins, ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatReset } from "@/lib/credits";
import { cn } from "@/lib/utils";

/**
 * A draft or chat turn refused at zero free credits (docs/mockups/free-credits.html, sections 3 and 4). Settings opens
 * in a new tab, so the leave guard stays quiet and an unsaved draft survives. Pass `onClose` in the conversation, or
 * `onRetry` where a draft would be.
 */
export function OutOfCreditsAlert({ resetsAt, onClose, onRetry }: { resetsAt: string; onClose?: () => void; onRetry?: () => void }) {
  const draft = !!onRetry;
  return (
    <div
      role="alert"
      className={cn(
        "rounded-2xl bg-neutral-100 text-card-foreground shadow-md ring-1 ring-primary/35",
        draft ? "p-6" : "p-3.5",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-accent-200 text-accent-800">
          <Coins className="size-3.5" />
        </span>
        <h3 className={cn("font-heading leading-tight", draft ? "text-[20px]" : "text-[17px]")}>You&apos;ve used this month&apos;s free credits</h3>
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto inline-flex size-[26px] shrink-0 items-center justify-center self-start rounded-lg text-muted-foreground hover:bg-foreground/7"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <p className={cn("mt-2 leading-relaxed text-foreground/75", draft ? "max-w-[560px] text-[14.5px]" : "text-[13.5px]")}>
        Your credits reset on {formatReset(new Date(resetsAt))}. Upgrade for more, or add your own API key to keep going now.
        {draft && " Your answers above are kept, so you can draft this plan as soon as you're ready."}
      </p>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button
          nativeButton={false}
          render={
            <Link href="/settings#credits" target="_blank" rel="noopener">
              Upgrade <ExternalLink className="size-3" />
            </Link>
          }
        />
        <Button
          variant="secondary"
          nativeButton={false}
          render={
            <Link href="/settings#api-key" target="_blank" rel="noopener">
              Add API key <ExternalLink className="size-3" />
            </Link>
          }
        />
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
      <p className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <ExternalLink className="size-3" />
        Opens in a new tab, so this {draft ? "page" : "draft"} stays here.
      </p>
    </div>
  );
}
