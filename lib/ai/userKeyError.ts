/**
 * A refusal on a user's own key, told to the user in their words and recorded on the key's row. Gateway calls are not
 * touched: the guard only acts when a model in the request runs on the user's key.
 */
import { clearUserApiKeyError, recordUserApiKeyError } from "@/lib/db/userApiKeys";
import { providerOf, type KeyErrorKind, type ModelProvider } from "./models";
import { providerError } from "./providerError";
import type { APICallError } from "ai";
import { PROVIDER_NAMES } from "./providerKeys";
import type { ResolvedModels } from "./resolve";

export class UserKeyError extends Error {
  constructor(
    readonly provider: ModelProvider,
    readonly code: KeyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "UserKeyError";
  }
}

/** The kind of refusal, read from the APICallError inside whatever was thrown (a RetryError, a wrapped loop error). */
export function classifyProviderError(error: unknown): KeyErrorKind {
  const api = providerError(error);
  if (!api) return "other";
  const status = api.statusCode;
  if (status === 401 || status === 403) return "invalid";
  if (status === 429) return "rate_limit";
  if (status === 400 && (api.responseBody ?? "").toLowerCase().includes("credit balance")) return "credits";
  return "other";
}

export function userKeyMessage(provider: ModelProvider, kind: KeyErrorKind, status?: number): string {
  const name = PROVIDER_NAMES[provider];
  switch (kind) {
    case "credits":
      return `Your ${name} credits are exhausted, so this stopped. Add credits in the Console or remove your key in Settings to use Pensieve's.`;
    case "invalid":
      return `${name} rejected your key. Replace it in Settings, or remove it to use Pensieve's.`;
    case "rate_limit":
      return `${name} is rate-limiting your key. Try again in a minute.`;
    case "other":
      return `${name} returned an error for your key${status ? ` (status ${status})` : ""}. Try again; if it keeps happening, check the Console.`;
  }
}

/** The most of a provider's response body kept in the server log. */
const LOG_BODY_CHARS = 2000;

/**
 * The server-log line for a refusal: the user is told only the status, so what the provider said (a malformed-request
 * message names the field) is kept here. The body is the provider's error, never the request or the key.
 */
export function refusalLogLine(provider: ModelProvider, kind: KeyErrorKind, api: APICallError): string {
  const body = (api.responseBody ?? "").replace(/\s+/g, " ").trim();
  const said = !body ? "no body" : body.length > LOG_BODY_CHARS ? `${body.slice(0, LOG_BODY_CHARS)}…` : body;
  return `[user key] ${PROVIDER_NAMES[provider]} refused a request (${kind}, status ${api.statusCode ?? "unknown"}): ${said}`;
}

export interface UserKeyGuard {
  userId: string;
  models: ResolvedModels;
  record?: typeof recordUserApiKeyError;
  clear?: typeof clearUserApiKeyError;
  report?: (line: string) => void;
}

/** The providers whose key the request runs on; empty when everything is on the app's gateway key. */
function userProviders(models: ResolvedModels): ModelProvider[] {
  const roles = [models.outline, models.content, models.chat, models.research, models.allocate];
  return [...new Set(roles.filter((m) => m.keyOwner === "user").map((m) => providerOf(m.id)))];
}

/**
 * A provider refusal on a user-key request becomes a UserKeyError, recorded on the key before it is thrown so the
 * settings page learns of it even when the response ends right after. Anything else passes through untouched.
 */
async function translate(error: unknown, guard: UserKeyGuard): Promise<unknown> {
  const providers = userProviders(guard.models);
  const api = providerError(error);
  if (providers.length === 0 || !api) return error;
  const provider = providers[0];
  const kind = classifyProviderError(api);
  (guard.report ?? console.error)(refusalLogLine(provider, kind, api));
  await (guard.record ?? recordUserApiKeyError)(guard.userId, provider, kind).catch(() => undefined);
  return new UserKeyError(provider, kind, userKeyMessage(provider, kind, api.statusCode));
}

async function clearIfRecorded(guard: UserKeyGuard): Promise<void> {
  for (const provider of userProviders(guard.models)) {
    if (guard.models.keyErrors[provider]) await (guard.clear ?? clearUserApiKeyError)(guard.userId, provider).catch(() => undefined);
  }
}

/** Wraps a request's event stream: a refusal on the user's key becomes a UserKeyError; a completed stream clears a recorded one. */
export async function* guardUserKey<T>(events: AsyncIterable<T>, guard: UserKeyGuard): AsyncGenerator<T> {
  try {
    for await (const event of events) yield event;
  } catch (error) {
    throw await translate(error, guard);
  }
  await clearIfRecorded(guard);
}

/** The same for a server action's single promise. */
export async function guardUserKeyCall<T>(run: () => Promise<T>, guard: UserKeyGuard): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    throw await translate(error, guard);
  }
  await clearIfRecorded(guard);
  return result;
}
