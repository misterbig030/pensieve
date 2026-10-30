import {
  ALLOCATE_EFFORT,
  AVAILABLE_MODELS,
  DEFAULT_ALLOCATE_MODEL,
  DEFAULT_OUTLINE_MODEL,
  DEFAULT_RESEARCH_MODEL,
  OUTLINE_EFFORT,
  RESEARCH_LOOP_EFFORT,
  type AiModelId,
} from "@/lib/ai/models";
import type { Contestant, Role, RoleModel } from "./types";

/** What the app runs today: each role's default model at its default effort. */
export const BASELINE: Contestant = {
  name: "baseline",
  roles: {
    allocate: { model: DEFAULT_ALLOCATE_MODEL, effort: ALLOCATE_EFFORT },
    outline: { model: DEFAULT_OUTLINE_MODEL, effort: OUTLINE_EFFORT },
    research: { model: DEFAULT_RESEARCH_MODEL, effort: RESEARCH_LOOP_EFFORT },
  },
};

const ROLES: Role[] = ["allocate", "outline", "research"];

/**
 * One model in every role, each at the baseline's effort for that role, so the models are compared and not the effort.
 * Models come from `AVAILABLE_MODELS`, where each one supports tool calls and structured output: adding one to that list
 * is where that is checked.
 */
function allRoles(name: string, model: AiModelId): Contestant {
  const roles: Partial<Record<Role, RoleModel>> = {};
  for (const role of ROLES) roles[role] = { model, effort: BASELINE.roles[role]!.effort };
  return { name, roles };
}

export const CONTESTANTS: Record<string, Contestant> = {
  baseline: BASELINE,
  "sonnet-5.5": allRoles("sonnet-5.5", "anthropic/claude-sonnet-5.5"),
  "haiku-4.5": allRoles("haiku-4.5", "anthropic/claude-haiku-4.5"),
  "gemini-3-flash": allRoles("gemini-3-flash", "google/gemini-3-flash"),
  "gemini-3.1-pro": allRoles("gemini-3.1-pro", "google/gemini-3.1-pro-preview"),
  "gpt-5.4-mini": allRoles("gpt-5.4-mini", "openai/gpt-5.4-mini"),
  "gpt-5.4": allRoles("gpt-5.4", "openai/gpt-5.4"),
};

/** Throws when a contestant uses a model the price list lacks, since its cost could not be reported. */
export function assertPriced(contestant: Contestant): void {
  for (const role of Object.values(contestant.roles)) {
    if (role && !AVAILABLE_MODELS.some((m) => m.id === role.model)) {
      throw new Error(`Model "${role.model}" has no price in AVAILABLE_MODELS`);
    }
  }
}

/** The named contestants, with the baseline first whether or not it was named. */
export function contestantsFor(names: string[]): Contestant[] {
  const picked = [BASELINE];
  for (const name of names) {
    const contestant = CONTESTANTS[name];
    if (!contestant) throw new Error(`Unknown contestant "${name}"; known: ${Object.keys(CONTESTANTS).join(", ")}`);
    if (!picked.includes(contestant)) picked.push(contestant);
  }
  for (const contestant of picked) assertPriced(contestant);
  return picked;
}
