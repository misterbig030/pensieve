import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { shortDate } from "@/lib/activity";
import { Button } from "@/components/ui/button";

function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span>
      <b className="block font-heading text-[18px] font-normal text-foreground">{value}</b>
      {label}
    </span>
  );
}

/** The plan page's title row: pace, how far along the track is, and the way to adjust it. */
export function TrackHeader(props: {
  title: string;
  pace: string;
  done: number;
  total: number;
  studied: number;
  planned: number;
  finish: Date | null;
  adjustHref: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="mr-auto min-w-0">
        <h1 className="font-heading text-[28px] leading-[1.1]">{props.title}</h1>
        <p className="mt-1.5 text-[13px] text-muted-foreground">{props.pace}</p>
      </div>
      <div className="mr-2 flex gap-[18px] text-[12px] text-muted-foreground">
        <Stat value={`${props.done} / ${props.total}`} label="days done" />
        <Stat value={`${hoursText(props.studied)} h`} label={`of ${hoursText(props.planned)} h`} />
        {props.finish && <Stat value={shortDate(props.finish)} label="finish" />}
      </div>
      <Button
        variant="secondary"
        nativeButton={false}
        render={
          <Link href={props.adjustHref}>
            <SlidersHorizontal />
            Adjust plan
          </Link>
        }
      />
    </div>
  );
}
