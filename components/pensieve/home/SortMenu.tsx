"use client";

import { usePathname, useRouter } from "next/navigation";
import { ArrowUpDown, Check, ChevronDown } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import type { SortKey } from "@/lib/trackProgress";

const OPTIONS: { key: SortKey; label: string }[] = [
  { key: "next", label: "Up next first" },
  { key: "recent", label: "Last studied" },
  { key: "newest", label: "Newest" },
];

/** How the home orders the cards, kept in `?sort=` so a reload or a shared link keeps it. */
export function SortMenu({ value }: { value: SortKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const current = OPTIONS.find((o) => o.key === value) ?? OPTIONS[0];
  return (
    <Menu.Root>
      <Menu.Trigger className="ml-auto flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary">
        <ArrowUpDown className="size-3.5" />
        {current.label}
        <ChevronDown className="size-3.5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="isolate z-50">
          <Menu.Popup className="min-w-44 origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95">
            {OPTIONS.map((o) => (
              <Menu.Item
                key={o.key}
                onClick={() => router.replace(o.key === "next" ? pathname : `${pathname}?sort=${o.key}`, { scroll: false })}
                className="flex cursor-default items-center justify-between gap-4 rounded-lg px-2.5 py-1.5 text-[13px] outline-none select-none data-highlighted:bg-accent-100"
              >
                {o.label}
                {o.key === current.key && <Check className="size-3.5" />}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
