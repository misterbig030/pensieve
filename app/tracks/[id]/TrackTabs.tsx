import Link from "next/link";
import { cn } from "@/lib/utils";

export type TrackTab = "plan" | "materials" | "activity" | "about";

export const TRACK_TABS: readonly TrackTab[] = ["plan", "materials", "activity", "about"];

const LABEL: Record<TrackTab, string> = { plan: "Plan", materials: "Materials", activity: "Activity", about: "About" };

/** The plan page's sections, kept in `?tab=` (Plan has no param). */
export function TrackTabs({ trackId, active, materialsCount }: { trackId: string; active: TrackTab; materialsCount: number }) {
  return (
    <nav className="flex items-center gap-1 border-b border-border">
      {TRACK_TABS.map((tab) => (
        <Link
          key={tab}
          href={tab === "plan" ? `/tracks/${trackId}` : `/tracks/${trackId}?tab=${tab}`}
          aria-current={tab === active ? "page" : undefined}
          className={cn(
            "-mb-px flex items-center gap-1.5 border-b-[2.5px] px-3 py-2.5 text-[14px]",
            tab === active ? "border-primary font-semibold text-foreground" : "border-transparent font-medium text-muted-foreground hover:text-foreground",
          )}
        >
          {LABEL[tab]}
          {tab === "materials" && materialsCount > 0 && (
            <em className="rounded-full bg-neutral-200 px-1.5 py-px text-[11px] text-neutral-800 not-italic">{materialsCount}</em>
          )}
        </Link>
      ))}
    </nav>
  );
}
