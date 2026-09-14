import { db } from "./client";
import { generationLog, type NewGenerationLog } from "./schema";

/** The only code that writes to `generation_log`. Server actions pass this as `onLog` to the generators. */
export async function insertGenerationLog(row: NewGenerationLog): Promise<void> {
  await db.insert(generationLog).values(row);
}
