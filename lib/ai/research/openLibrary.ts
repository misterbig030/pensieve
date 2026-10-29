/**
 * Open Library's terms (openlibrary.org/developers/api): an app that does not say who it is gets 1 request a second, one
 * whose User-Agent names it and a contact gets 3. Going over them gets the address blocked, so every request this
 * process makes to Open Library, a catalogue lookup or a page read, waits on one pace and names the contact.
 * Dependency-free so the egress guard and the gate can share it.
 */

export const OPEN_LIBRARY_PER_SECOND = { anonymous: 1, identified: 3 } as const;

/** The email or phone Open Library may write to, from `OPEN_LIBRARY_CONTACT`; null when unset or unfit for a header. */
export function openLibraryContact(raw: string | undefined = process.env.OPEN_LIBRARY_CONTACT): string | null {
  const value = raw?.trim();
  return value && value.length <= 200 && /^[\x20-\x7e]+$/.test(value) && !/[()]/.test(value) ? value : null;
}

export function openLibraryUserAgent(contact: string | null): string {
  return `PensieveResearch/1.0 (study-plan source checker${contact ? `; ${contact}` : ""})`;
}

/** The rate Open Library allows this process now: identified while a contact is set. */
export function openLibraryRate(contact: string | null = openLibraryContact()): number {
  return contact ? OPEN_LIBRARY_PER_SECOND.identified : OPEN_LIBRARY_PER_SECOND.anonymous;
}

/** openlibrary.org and every host under it: one site, one limit. */
export function isOpenLibraryHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "openlibrary.org" || host.endsWith(".openlibrary.org");
}

/** Waits for a request's turn. */
export type Pacer = () => Promise<void>;

/**
 * A pacer that starts requests at most `perSecond` a second, evenly spaced, however many callers share it. A rate
 * given as a function is read at each request.
 */
export function createPacer(
  perSecond: number | (() => number),
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Pacer {
  let next = 0;
  return async () => {
    const rate = typeof perSecond === "function" ? perSecond() : perSecond;
    const start = Math.max(now(), next);
    next = start + 1000 / rate;
    const wait = start - now();
    if (wait > 0) await sleep(wait);
  };
}

const PACER_KEY = Symbol.for("pensieve.openLibraryPacer");

/**
 * The one pace for the whole process: every draft on this server shares its address, and so Open Library's limit. Kept
 * on the global object so a module loaded twice (another bundle, a dev reload) still shares it.
 */
export function openLibraryPacer(): Pacer {
  const store = globalThis as typeof globalThis & { [PACER_KEY]?: Pacer };
  return (store[PACER_KEY] ??= createPacer(() => openLibraryRate()));
}
