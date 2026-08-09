import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

interface PhaseBlockProps {
  label: string;
  range: string;
  focus: string;
  doneLabel?: string;
  children: ReactNode;
}

export function PhaseBlock({ label, range, focus, doneLabel, children }: PhaseBlockProps) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-baseline gap-2.5">
        <h3 className="font-heading text-lg">{label}</h3>
        <Badge variant="accent2">{range}</Badge>
        {doneLabel && <span className="text-xs text-muted-foreground">{doneLabel}</span>}
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{focus}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2.5">{children}</div>
    </div>
  );
}
