import Link from "next/link";
import { Archive, ArchiveRestore, SlidersHorizontal } from "lucide-react";
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

/** The plan page's title row: pace, how far along the track is, and the ways to adjust it or archive it. */
export function TrackHeader(props: {
  title: string;
  pace: string;
  done: number;
  total: number;
  studied: number;
  planned: number;
  finish: Date | null;
  adjustHref: string;
  archived: boolean;
  /** Archives this track; a form action, so it works before the page's scripts load. */
  archiveAction: () => Promise<void>;
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
      {!props.archived && (
        <form action={props.archiveAction}>
          <Button type="submit" variant="ghost" title="Take this track off your home page. You can restore it.">
            <Archive />
            Archive
          </Button>
        </form>
      )}
    </div>
  );
}

/** Above an archived track's header: why it is not on the home page, and the way back. */
export function ArchivedNotice({ restoreAction }: { restoreAction: () => Promise<void> }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-2xl bg-secondary py-2.5 pr-2.5 pl-4 text-[13.5px]">
      <span className="mr-auto">This track is archived, so it isn&apos;t on your home page.</span>
      <form action={restoreAction}>
        <Button type="submit" variant="outline" size="sm">
          <ArchiveRestore />
          Restore
        </Button>
      </form>
    </div>
  );
}
