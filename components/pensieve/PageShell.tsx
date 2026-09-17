import type { ReactNode } from "react";
import { TopNav } from "@/components/pensieve/TopNav";

export function PageShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "mx-auto max-w-[1280px] px-6 pb-24" : "mx-auto max-w-[960px] px-6 pb-24"}>
      <TopNav />
      {children}
    </div>
  );
}
