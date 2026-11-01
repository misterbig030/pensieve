import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** A round tick: the control on a task or step card. Its parts link elsewhere, so it sits beside them, not around them. */
export function Tick({ on, label, onToggle, className }: { on: boolean; label: string; onToggle(): void; className?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} onClick={onToggle} className={cn("shrink-0 rounded-full", className)}>
      <span
        className={cn(
          "flex size-5 items-center justify-center rounded-full border-[1.5px]",
          on ? "border-accent-2-500 bg-accent-2-500 text-background" : "border-neutral-400 bg-background hover:border-accent-2-500",
        )}
      >
        {on && <Check className="size-[11px]" strokeWidth={3} />}
      </span>
    </button>
  );
}
