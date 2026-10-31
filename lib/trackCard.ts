/** What a track's card on the home shows, worked out from its plan and check-ins. Days are UTC days. */

import { doneDays, fullLabelOf, labelOf, leavesOf, weeksOf, type Granularity, type PlanNode } from "@/lib/planTree";
import { dayKey } from "@/lib/streak";
import { dayMinutes, formatDayTime } from "@/lib/studyTime";
import { cardAction, doneToday, finishDate, weekActivity, type CardAction, type CheckIn, type WeekActivity } from "@/lib/trackProgress";

export interface TrackCardData {
  id: string;
  title: string;
  pace: string;
  action: CardAction;
  actionLabel: string;
  actionTitle: string;
  doneToday: boolean;
  week: WeekActivity;
  progress: { done: number; total: number; unit: "Day" | "Week" };
  finish: Date | null;
  createdAt: Date;
  lastStudied: Date | null;
}

export type CardCheckIn = CheckIn & { nodeTitle: string };

interface CardTrack {
  id: string;
  title: string;
  granularity: Granularity;
  hoursPerWeek: number;
  daysPerWeek: number;
  createdAt: Date;
}

function actionLabel(root: PlanNode, action: CardAction): string {
  switch (action.kind) {
    case "start":
      return `Today · ${fullLabelOf(root, action.node)}`;
    case "log":
      return `This week · ${labelOf(root, action.node)}`;
    case "plan":
      return `${labelOf(root, action.node)} isn't planned yet`;
    case "finished":
      return "All days done";
  }
}

function progress(root: PlanNode, track: CardTrack): TrackCardData["progress"] {
  if (track.granularity === "day") return { done: doneDays(root), total: root.len, unit: "Day" };
  const done = leavesOf(root)
    .filter((leaf) => leaf.status === "completed")
    .reduce((sum, leaf) => sum + weeksOf(root, leaf, track.daysPerWeek), 0);
  return { done: Math.round(done), total: Math.round(weeksOf(root, root, track.daysPerWeek)), unit: "Week" };
}

export function toTrackCard(track: CardTrack, root: PlanNode, checkIns: CardCheckIn[], today: Date): TrackCardData {
  const action = cardAction(root);
  const todayKey = dayKey(today);
  const latestToday = checkIns
    .filter((c) => dayKey(c.completedAt) === todayKey)
    .reduce<CardCheckIn | null>((latest, c) => (!latest || c.completedAt > latest.completedAt ? c : latest), null);
  const lastStudied = checkIns.reduce<Date | null>((last, c) => (!last || c.completedAt > last ? c.completedAt : last), null);

  return {
    id: track.id,
    title: track.title,
    pace:
      track.granularity === "day"
        ? `Daily · ${formatDayTime(dayMinutes(track.hoursPerWeek, track.daysPerWeek))}`
        : `Weekly · ${track.hoursPerWeek} h`,
    action,
    actionLabel: actionLabel(root, action),
    actionTitle: latestToday?.nodeTitle ?? (action.kind === "finished" ? "" : action.node.title),
    doneToday: doneToday(checkIns, today),
    week: weekActivity(root, track.granularity, checkIns, today, track.hoursPerWeek),
    progress: progress(root, track),
    finish: finishDate(root, track.daysPerWeek, today),
    createdAt: track.createdAt,
    lastStudied,
  };
}
