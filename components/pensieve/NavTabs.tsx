"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, History, Route, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const tabClass = "flex h-full items-center gap-2 border-b-[2.5px] px-1 text-[14px]";

function Soon({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span aria-disabled="true" className={cn(tabClass, "cursor-default border-transparent text-muted-foreground")}>
      <Icon className="size-4" />
      {label}
      <span className="rounded-full bg-neutral-200 px-1.5 py-px text-[10.5px] font-semibold text-neutral-700">soon</span>
    </span>
  );
}

/** The app's sections. Only Tracks exists for now; Explore and Journey show what's coming. */
export function NavTabs() {
  const pathname = usePathname();
  const tracksActive = pathname === "/" || pathname.startsWith("/tracks");
  return (
    <nav className="flex h-full items-stretch gap-6">
      <Link
        href="/"
        aria-current={tracksActive ? "page" : undefined}
        className={cn(tabClass, tracksActive ? "border-primary font-semibold text-foreground" : "border-transparent text-foreground/75 hover:text-foreground")}
      >
        <Route className="size-4" />
        Tracks
      </Link>
      <Soon icon={Compass} label="Explore" />
      <Soon icon={History} label="Journey" />
    </nav>
  );
}
