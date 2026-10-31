import { auth } from "@clerk/nextjs/server";
import { isAdminUserId } from "@/lib/admin";
import { withCallEvents } from "@/lib/ai/callEvents";
import { creditRefusal } from "@/lib/ai/creditGate";
import { draftRequestBodySchema, researchedDraftInput } from "@/lib/ai/draftRequest";
import { DRAFT_BUDGET_MS, streamResearchedPlanDraft } from "@/lib/ai/planDraft";
import { insertGenerationLog } from "@/lib/db/generationLog";
import { resolveModels } from "@/lib/ai/resolve";
import { guardUserKey } from "@/lib/ai/userKeyError";
import { ndjsonResponse } from "@/lib/ndjson";

// One request runs it all in series: research (the workers, then the candidates step), the gate's page and catalogue
// checks, the structure finders, the allocation (Opus at high effort), then the outline. Several minutes in all; the
// draft keeps inside `DRAFT_BUDGET_MS`, dropping what does not fit rather than running past this limit.
export const maxDuration = 300;

export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return new Response("Not authenticated", { status: 401 });

  const parsed = draftRequestBodySchema.safeParse(await request.json());
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const body = parsed.data;
  const debug = body.debug === true && isAdminUserId(userId);
  const models = await resolveModels(userId);
  // A new draft is checked against the month's free credits; the draft gets the whole set, so every role counts.
  const refused = await creditRefusal(userId, [models.outline, models.content, models.chat, models.research, models.allocate]);
  if (refused) return refused;
  const deadline = Date.now() + DRAFT_BUDGET_MS;

  return ndjsonResponse(
    withCallEvents(debug, { userId, onLog: insertGenerationLog, keyOwner: models.research.keyOwner }, (log) =>
      guardUserKey(
        streamResearchedPlanDraft(
          // A client that disconnects stops research: the signal reaches search and fetch.
          researchedDraftInput({ request: body, models, deadline, signal: request.signal, log }),
        ),
        { userId, models },
      ),
    ),
  );
}
