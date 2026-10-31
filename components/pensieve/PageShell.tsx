import type { ReactNode } from "react";
import { AdminDock } from "@/components/pensieve/AdminDock";
import { TopBar } from "@/components/pensieve/TopBar";
import { cn } from "@/lib/utils";

/** Every signed-in page: the top bar, then the page's own content. Pages set their own width with `className`. */
export function PageShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <>
      <TopBar />
      <main className={cn("px-8 pt-6 pb-24 max-[640px]:px-4", className)}>{children}</main>
      <AdminDock />
    </>
  );
}
