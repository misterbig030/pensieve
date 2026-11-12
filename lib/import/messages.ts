import { nextMessageId, type ChatMessage } from "@/lib/planChat";

/** What the draft page knows of the learner's plan file: its name and text, and the sections the converter set aside. */
export interface ImportedFile {
  fileName: string;
  text: string;
  /** Sections kept as context, not as units. */
  kept: string[];
  /** Sections the converter could not place, each with the reason. */
  skipped: { heading: string; reason: string }[];
}

/** The conversation an imported plan opens with. No brief: nothing was asked for, the plan came from the file. */
export function importMessages(imported: ImportedFile): ChatMessage[] {
  const answer = (text: string): ChatMessage => ({ id: nextMessageId(), kind: "answer", text, streaming: false });
  const messages: ChatMessage[] = [
    { id: nextMessageId(), kind: "sys", text: `Imported from ${imported.fileName}. No research ran, and nothing was looked up.` },
    answer("Here's your plan as the file has it. What the file doesn't say, like how a week splits into days, I'll decide when you ask."),
  ];
  if (imported.kept.length > 0) messages.push(answer(`Kept as context, not as units: ${imported.kept.join(", ")}.`));
  const n = imported.skipped.length;
  if (n > 0) {
    const list = imported.skipped.map((s) => `${s.heading} (${s.reason})`).join("; ");
    messages.push(answer(`Couldn't place ${n} section${n > 1 ? "s" : ""}: ${list}. Tell me where it goes, or leave it as context.`));
  }
  return messages;
}
