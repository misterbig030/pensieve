import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/**
 * The only way research code reaches an arbitrary URL. Every hop is checked before a socket opens: https on the
 * default port, no credentials, no IP-literal host, and every address the name resolves to must be public. The
 * connection then goes to the address that was checked, never to a second lookup, so a rebinding resolver cannot
 * swap in a private address between the check and the connect.
 */

export const EGRESS_USER_AGENT = "PensieveResearch/1.0 (study-plan source checker)";
export const MAX_REDIRECTS = 3;
export const FETCH_TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const ACCEPTED_CONTENT_TYPES = ["text/html", "application/pdf", "text/plain"] as const;
export type AcceptedContentType = (typeof ACCEPTED_CONTENT_TYPES)[number];

export type EgressReason =
  | "invalid-url"
  | "scheme"
  | "port"
  | "credentials"
  | "ip-literal"
  | "private-address"
  | "dns"
  | "too-many-redirects"
  | "timeout"
  | "aborted"
  | "status"
  | "content-type"
  | "network";

export class EgressError extends Error {
  constructor(
    readonly reason: EgressReason,
    message: string,
  ) {
    super(message);
    this.name = "EgressError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname to every address it has. Tests pass a fake; the default asks the OS resolver. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface TransportRequest {
  url: URL;
  /** The checked address to connect to. The transport must not resolve `url.hostname` again. */
  address: ResolvedAddress;
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Stops reading and releases the socket. */
  destroy: () => void;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface GuardedFetchOptions {
  signal?: AbortSignal;
  resolver?: Resolver;
  transport?: Transport;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface GuardedResponse {
  /** The URL that finally answered, after redirects. */
  finalUrl: string;
  status: number;
  contentType: AcceptedContentType;
  charset: string | null;
  body: Uint8Array;
  /** True when the body was cut at the byte cap. */
  truncated: boolean;
}

/** Throws unless the URL is https on the default port with a hostname (not an IP) and no credentials. */
export function checkUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = typeof raw === "string" ? new URL(raw) : new URL(raw.href);
  } catch {
    throw new EgressError("invalid-url", "Not a valid URL");
  }
  if (url.protocol !== "https:") throw new EgressError("scheme", `Only https is allowed, not ${url.protocol.replace(":", "")}`);
  if (url.port !== "") throw new EgressError("port", "Only the default https port is allowed");
  if (url.username || url.password) throw new EgressError("credentials", "Credentials in the URL are not allowed");
  if (isIpLiteralHost(url.hostname)) throw new EgressError("ip-literal", "IP-address hosts are not allowed");
  if (!url.hostname.includes(".")) throw new EgressError("invalid-url", "Host must be a public domain name");
  return url;
}

/**
 * True for any host that is an address rather than a name. The URL parser already folds decimal, octal and hex
 * IPv4 forms (`2130706433`, `0x7f.1`, `0177.0.0.1`) into dotted quads, so a bracketed IPv6 host or a dotted quad
 * is what remains; the digit-and-hex check catches anything a caller passes without going through the parser.
 */
export function isIpLiteralHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return true;
  if (host.includes(":")) return true;
  const labels = host.split(".").filter(Boolean);
  const last = labels[labels.length - 1] ?? "";
  return /^(0x[0-9a-f]*|[0-9]+)$/i.test(last);
}

/** True when an address must never be contacted: loopback, private, link-local, CGNAT, metadata, multicast, … */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedV4(parseV4(address));
  if (family === 6) return isBlockedV6(address);
  return true;
}

function parseV4(address: string): number[] {
  return address.split(".").map((p) => Number(p));
}

function isBlockedV4([a, b, c]: number[]): boolean {
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, including 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Expands an IPv6 address into eight 16-bit groups. Accepts an embedded dotted IPv4 tail. */
function parseV6(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const v4Tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const [a, b, c, d] = parseV4(v4Tail[1]);
    text = text.slice(0, -v4Tail[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const groups = [...head, ...Array.from({ length: fill }, () => "0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isBlockedV6(address: string): boolean {
  const g = parseV6(address);
  if (!g) return true;
  const allZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroPrefix(8)) return true; // ::
  if (allZeroPrefix(7) && g[7] === 1) return true; // ::1
  if (allZeroPrefix(5) && g[5] === 0xffff) return isBlockedV4(embeddedV4(g[6], g[7])); // IPv4-mapped
  if (allZeroPrefix(6)) return true; // deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return isBlockedV4(embeddedV4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isBlockedV4(embeddedV4(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: tunnels to an address we cannot check
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return true; // deprecated site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export const systemResolver: Resolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** Resolves once and returns the address to connect to, or throws when any answer is not public. */
export async function resolvePublic(hostname: string, resolver: Resolver): Promise<ResolvedAddress> {
  let answers: ResolvedAddress[];
  try {
    answers = await resolver(hostname);
  } catch {
    throw new EgressError("dns", `Could not resolve ${hostname}`);
  }
  if (answers.length === 0) throw new EgressError("dns", `${hostname} has no addresses`);
  // One private answer is enough to refuse: a mixed answer set is how rebinding attacks hedge.
  if (answers.some((a) => isBlockedAddress(a.address))) {
    throw new EgressError("private-address", `${hostname} resolves to a non-public address`);
  }
  return answers[0];
}

/** Connects to the checked address with Node's https client; SNI and the Host header still carry the hostname. */
export const pinnedHttpsTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const { url, address, headers, signal } = req;
    const r = httpsRequest(
      {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers,
        signal,
        agent: false,
        // Pin the socket to the address that passed the check; Node never performs its own lookup.
        lookup: (_host, options, callback) => {
          const cb = callback as unknown as (...args: unknown[]) => void;
          if ((options as { all?: boolean }).all) cb(null, [{ address: address.address, family: address.family }]);
          else cb(null, address.address, address.family);
        },
      },
      (res) => {
        const flat: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) flat[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers: flat, body: res, destroy: () => res.destroy() });
      },
    );
    r.on("error", reject);
    r.end();
  });

function parseContentType(header: string | undefined): { type: string; charset: string | null } {
  const [type, ...params] = (header ?? "").split(";").map((s) => s.trim());
  const charset = params.find((p) => p.toLowerCase().startsWith("charset="))?.slice(8).replace(/"/g, "") ?? null;
  return { type: type.toLowerCase(), charset };
}

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number, destroy: () => void): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    const room = maxBytes - size;
    if (chunk.byteLength > room) {
      chunks.push(chunk.subarray(0, room));
      size += room;
      truncated = true;
      break;
    }
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  // Stop reading at the cap; the rest of the body is never pulled off the socket.
  if (truncated) destroy();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * GETs a URL under the egress rules. Redirects are followed by hand (at most three) and every hop is re-checked.
 * Five seconds for the whole chain, a 2 MB body cap, and only HTML, PDF and plain text are read.
 */
export async function guardedFetch(raw: string, options: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const resolver = options.resolver ?? systemResolver;
  const transport = options.transport ?? pinnedHttpsTransport;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  const abortReason = (): EgressError =>
    timeout.aborted ? new EgressError("timeout", "Timed out") : new EgressError("aborted", "Cancelled");

  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    if (signal.aborted) throw abortReason();
    const address = await resolvePublic(url.hostname, resolver);
    if (signal.aborted) throw abortReason();
    let res: TransportResponse;
    try {
      res = await transport({
        url,
        address,
        signal,
        headers: {
          "user-agent": EGRESS_USER_AGENT,
          accept: "text/html,application/pdf,text/plain;q=0.9",
          "accept-language": "en;q=0.9,*;q=0.5",
        },
      });
    } catch (error) {
      if (signal.aborted) throw abortReason();
      throw new EgressError("network", error instanceof Error ? error.message : "Network error");
    }

    if (isRedirect(res.status)) {
      res.destroy();
      const location = res.headers["location"];
      if (!location) throw new EgressError("status", `Redirect ${res.status} without a location`);
      if (hop >= MAX_REDIRECTS) throw new EgressError("too-many-redirects", `More than ${MAX_REDIRECTS} redirects`);
      url = checkUrl(new URL(location, url));
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.destroy();
      throw new EgressError("status", `HTTP ${res.status}`);
    }
    const { type, charset } = parseContentType(res.headers["content-type"]);
    if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(type)) {
      res.destroy();
      throw new EgressError("content-type", `Unsupported content type ${type || "(none)"}`);
    }
    try {
      const { bytes, truncated } = await readCapped(res.body, maxBytes, res.destroy);
      return { finalUrl: url.href, status: res.status, contentType: type as AcceptedContentType, charset, body: bytes, truncated };
    } catch (error) {
      res.destroy();
      if (signal.aborted) throw abortReason();
      throw new EgressError("network", error instanceof Error ? error.message : "Read failed");
    }
  }
}

/** One short line a learner can read: why a page could not be opened. */
export function describeEgressError(error: unknown): string {
  if (!(error instanceof EgressError)) return "could not be opened";
  switch (error.reason) {
    case "timeout":
      return "timed out";
    case "status":
      return `returned ${error.message.replace(/^HTTP /, "")}`;
    case "content-type":
      return "not a web page or PDF";
    case "private-address":
    case "ip-literal":
    case "scheme":
    case "port":
    case "credentials":
    case "invalid-url":
      return "blocked address";
    case "too-many-redirects":
      return "too many redirects";
    case "dns":
      return "site not found";
    case "aborted":
      return "cancelled";
    default:
      return "could not be opened";
  }
}
