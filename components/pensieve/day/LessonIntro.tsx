import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionError } from "@/components/pensieve/leaf/ActionError";
import { lessonPreview, type DayTask } from "@/lib/dayTasks";

/** Before the lesson is written: what it will take the learner through, and the button that writes it. */
export function LessonIntro({
  unit,
  tasks,
  pending,
  error,
  errorLink,
  onWrite,
}: {
  unit: "day" | "week";
  tasks: DayTask[];
  pending: boolean;
  error: string | null;
  errorLink: boolean;
  onWrite(): void;
}) {
  const week = unit === "week";
  return (
    <section className="elev-sm flex flex-col gap-3 rounded-3xl bg-neutral-100 px-7 py-[26px]">
      <h2 className="m-0 font-heading text-[20px] font-normal">{week ? "Your material for this week" : "Your lesson for today"}</h2>
      {tasks.length > 0 ? (
        <>
          <p className="m-0 text-[14px] leading-[1.6] text-muted-foreground">
            Pensieve writes it from the {tasks.length === 1 ? "task" : `${tasks.length} tasks`} on the left and cites only {tasks.length === 1 ? "it" : "them"}. It takes
            you through them in order:
          </p>
          <ol className="m-0 list-decimal pl-[18px] text-[14px] leading-[1.7] text-foreground/80">
            {lessonPreview(tasks).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </>
      ) : (
        <p className="m-0 text-[14px] leading-[1.6] text-muted-foreground">Pensieve writes it from your track&apos;s sources and cites what it uses.</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <Button onClick={onWrite} disabled={pending}>
          <Sparkles />
          {pending ? "Writing…" : week ? "Write this week's material" : "Write today's lesson"}
        </Button>
        <span className="text-[12px] text-foreground/45">About a minute</span>
      </div>
      {error && <ActionError message={error} settingsLink={errorLink} />}
    </section>
  );
}
