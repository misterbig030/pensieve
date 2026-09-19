"use client";

import { useAdminMode, writeAdminMode } from "@/lib/adminMode";
import { cn } from "@/lib/utils";

/** The staff-only switch in the top nav. Rendered only for admins; the server never trusts its state on its own. */
export function AdminToggle() {
  const on = useAdminMode();
  return (
    <label
      className={cn(
        "relative inline-flex cursor-pointer items-center gap-2 rounded-full py-1.5 pr-1.5 pl-3 text-[12.5px] font-semibold select-none",
        on ? "border border-primary bg-accent-100 text-accent-700" : "border border-dashed border-neutral-400 text-neutral-700",
      )}
    >
      Admin
      <span className={cn("relative block h-5 w-9 rounded-full transition-colors", on ? "bg-primary" : "bg-neutral-400")}>
        <span
          className={cn(
            "absolute top-0.5 left-0.5 block size-4 rounded-full bg-background transition-transform",
            on && "translate-x-4",
          )}
        />
      </span>
      <input
        type="checkbox"
        className="sr-only"
        checked={on}
        onChange={(e) => writeAdminMode(e.target.checked)}
        aria-label="Admin mode"
      />
    </label>
  );
}
