import { PageShell } from "@/components/pensieve/PageShell";
import { NewTrackForm } from "./NewTrackForm";

/** The import action runs one long model call; a server action takes its page's limit, as the plan routes set theirs. */
export const maxDuration = 300;

export default function NewTrackPage() {
  return (
    <PageShell className="mx-auto max-w-[1280px]">
      <NewTrackForm />
    </PageShell>
  );
}
