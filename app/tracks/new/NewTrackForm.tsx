"use client";

import { useRef, useState, type DragEvent } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { OutOfCreditsAlert } from "@/components/pensieve/OutOfCreditsAlert";
import { PlanWorkspace } from "@/components/pensieve/PlanWorkspace";
import { TrackFormFields, type TrackFormValue } from "@/components/pensieve/TrackFormFields";
import type { ImportedPlan } from "@/lib/import/convert";
import { pushModelCalls } from "@/lib/modelCalls";
import { fromTreeInput, toTreeInput } from "@/lib/planInput";
import { resolveGranularity, weeksOf } from "@/lib/planTree";
import { DEFAULT_DAYS_PER_WEEK, DEFAULT_HOURS_PER_WEEK } from "@/lib/studyTime";
import { cn } from "@/lib/utils";
import { confirmTrackAction, importPlanAction } from "./actions";

/** Mirrors the server's limit (app/tracks/new/actions.ts): the file is checked here first so a wrong file never leaves the page. */
const MAX_IMPORT_BYTES = 65536;
const BAD_FILE_MESSAGE = "Pensieve imports .md or .txt files up to 64 KB.";
const NO_PLAN_NOTE = "Import only copies plans that already exist. To have Pensieve build one, use the form above and add the file as a source.";
const FAILED_MESSAGE = "Couldn't read that file. Try again.";

type ImportFailure = { fileName: string; reason: "no_plan" | "too_long" | "bad_file" | "out_of_credits" | "key" | "failed"; message: string; resetsAt?: string };
type Imported = { fileName: string; text: string; plan: ImportedPlan };

const EMPTY_FORM: TrackFormValue = {
  topic: "",
  weeks: 4,
  granularity: "auto",
  hoursPerWeek: DEFAULT_HOURS_PER_WEEK,
  daysPerWeek: DEFAULT_DAYS_PER_WEEK,
  instructions: "",
  sources: [],
};

export function NewTrackForm() {
  const [form, setForm] = useState<TrackFormValue>(EMPTY_FORM);
  const [brief, setBrief] = useState<TrackFormValue | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [imported, setImported] = useState<Imported | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function importFile(file: File) {
    if (reading) return;
    setFailure(null);
    if (!/\.(md|txt)$/i.test(file.name) || file.size > MAX_IMPORT_BYTES) {
      setFailure({ fileName: file.name, reason: "bad_file", message: BAD_FILE_MESSAGE });
      return;
    }
    setReading(file.name);
    try {
      const text = await file.text();
      const result = await importPlanAction({ fileName: file.name, text });
      if (result.calls?.length) pushModelCalls(result.calls);
      if (result.ok) setImported({ fileName: file.name, text, plan: result.plan });
      else setFailure({ fileName: file.name, reason: result.reason, message: result.message, resetsAt: result.resetsAt });
    } catch {
      // Any other failure (a model or schema error) throws: keep the learner here with a short message.
      setFailure({ fileName: file.name, reason: "failed", message: FAILED_MESSAGE });
    } finally {
      setReading(null);
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void importFile(file);
  }

  if (imported) {
    const { plan, fileName, text } = imported;
    const root = fromTreeInput(plan.tree);
    return (
      <PlanWorkspace
        mode="create"
        topic={plan.title}
        weeks={weeksOf(root, root, plan.daysPerWeek)}
        daysPerWeek={plan.daysPerWeek}
        granularity={plan.granularity}
        hoursPerWeek={plan.hoursPerWeek}
        initialSplit={plan.split}
        sources={[]}
        initialMaterials={plan.materials}
        initialTree={root}
        imported={{ fileName, text, kept: plan.kept, skipped: plan.skipped }}
        backHref="/"
        backLabel="Tracks"
        heading={`Here's the plan for "${plan.title}"`}
        subtext="Imported from your file as written. Nothing was researched. Skim the plan, split a week into days, then confirm, or talk it over on the right."
        onConfirm={(tree, summary, materials, time) =>
          confirmTrackAction({
            topic: plan.title,
            granularity: plan.granularity,
            hoursPerWeek: time.hoursPerWeek,
            daysPerWeek: time.daysPerWeek,
            split: time.split,
            materials,
            tree: toTreeInput(tree),
            summary,
            problems: time.problems,
            importText: text,
          })
        }
      />
    );
  }

  if (brief && brief.weeks) {
    const topic = brief.topic.trim();
    const weeks = brief.weeks;
    const granularity = resolveGranularity(brief.granularity, weeks);
    const instructions = brief.instructions.trim() || undefined;
    return (
      <PlanWorkspace
        mode="create"
        topic={topic}
        weeks={weeks}
        daysPerWeek={brief.daysPerWeek}
        granularity={granularity}
        hoursPerWeek={brief.hoursPerWeek || DEFAULT_HOURS_PER_WEEK}
        instructions={instructions}
        sources={brief.sources}
        backHref="/"
        backLabel="Tracks"
        heading={`Here's the plan for "${topic}"`}
        subtext="Skim the plan, expand what you want to see, then confirm — or talk it over on the right."
        onConfirm={(tree, summary, materials, time) =>
          confirmTrackAction({
            topic,
            instructions,
            granularity,
            hoursPerWeek: time.hoursPerWeek,
            daysPerWeek: time.daysPerWeek,
            split: time.split,
            materials,
            tree: toTreeInput(tree),
            summary,
            problems: time.problems,
          })
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-[640px] space-y-4">
      <div className="space-y-3 pb-2">
        <h1>What do you want to learn?</h1>
        <p className="text-muted-foreground">
          Give it a topic and any reference material — it drafts a plan you can shape before committing.
        </p>
      </div>
      <TrackFormFields value={form} onChange={setForm} />
      <Button className="mt-2 w-full" onClick={() => setBrief(form)} disabled={!form.topic.trim() || !form.weeks || !form.hoursPerWeek}>
        Generate outline
      </Button>
      <div className="flex items-center gap-3 pt-1 text-[13px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      {failure && <ImportFailureNotice failure={failure} onClose={() => setFailure(null)} />}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex items-center gap-4 rounded-[20px] border-[1.5px] border-dashed px-[22px] py-5",
          reading || dragging ? "border-solid border-primary/50 bg-accent-100" : "border-border bg-muted/60",
        )}
      >
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".md,.txt,text/markdown,text/plain"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
        {reading ? (
          <div role="status">
            <b className="block text-sm">{reading}</b>
            <span className="mt-0.5 block text-[12.5px] text-muted-foreground">Reading your plan…</span>
          </div>
        ) : (
          <>
            <div>
              <b className="block text-sm">{failure ? "Try another file" : "Already have a plan? Import it."}</b>
              <small className="mt-0.5 block text-[12.5px] leading-snug text-muted-foreground">
                {failure
                  ? ".md or .txt with weeks, days or months in it."
                  : "Drop a .md or .txt file. Pensieve copies your plan as written, with no research and no links looked up, then you review it before saving."}
              </small>
            </div>
            <Button variant="outline" className="ml-auto" onClick={() => fileInput.current?.click()}>
              Choose file
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ImportFailureNotice({ failure, onClose }: { failure: ImportFailure; onClose: () => void }) {
  if (failure.reason === "out_of_credits" && failure.resetsAt) return <OutOfCreditsAlert resetsAt={failure.resetsAt} onClose={onClose} />;
  if (failure.reason === "no_plan") {
    return (
      <div role="alert" className="rounded-2xl bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-200">
        <b className="block">Couldn&apos;t find a plan in {failure.fileName}</b>
        <p className="mt-1">
          {failure.message} {NO_PLAN_NOTE}
        </p>
      </div>
    );
  }
  return (
    <p role="alert" className="text-sm text-red-600">
      {failure.message}
      {failure.reason === "key" && (
        <>
          {" "}
          <Link href="/settings" className="underline">
            Open Settings
          </Link>
        </>
      )}
    </p>
  );
}
