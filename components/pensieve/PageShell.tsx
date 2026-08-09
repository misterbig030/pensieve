import type { ReactNode } from "react";
import { TopNav } from "@/components/pensieve/TopNav";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[960px] px-6 pb-24">
      <TopNav />
      {children}
    </div>
  );
}
