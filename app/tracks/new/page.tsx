import { PageShell } from "@/components/pensieve/PageShell";
import { NewTrackForm } from "./NewTrackForm";

export default function NewTrackPage() {
  return (
    <PageShell className="mx-auto max-w-[1280px]">
      <NewTrackForm />
    </PageShell>
  );
}
