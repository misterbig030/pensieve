import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  EgressError,
  checkUrl,
  guardedFetch,
  isBlockedAddress,
  isIpLiteralHost,
  type ResolvedAddress,
  type Resolver,
  type Transport,
  type TransportRequest,
} from "./egress";

const PUBLIC: ResolvedAddress = { address: "93.184.216.34", family: 4 };

function resolverFor(map: Record<string, ResolvedAddress[]>): Resolver {
  return async (host) => {
    const answers = map[host];
    if (!answers) throw new Error(`ENOTFOUND ${host}`);
    return answers;
  };
}

function body(...chunks: (string | Uint8Array)[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const c of chunks) yield typeof c === "string" ? new TextEncoder().encode(c) : c;
  })();
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array>;
}

/** A transport that answers by URL and records every request it was asked to make. */
function transportFor(replies: Record<string, Reply>) {
  const requests: TransportRequest[] = [];
  const destroyed: string[] = [];
  const transport: Transport = async (req) => {
    requests.push(req);
    const reply = replies[req.url.href];
    if (!reply) throw new Error(`unexpected request ${req.url.href}`);
    return {
      status: reply.status ?? 200,
      headers: { "content-type": "text/html; charset=utf-8", ...reply.headers },
      body: reply.body ?? body("<title>ok</title>"),
      destroy: () => void destroyed.push(req.url.href),
    };
  };
  return { transport, requests, destroyed };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EgressError) return error.reason;
    throw error;
  }
  return "ok";
}

describe("egress guard: URL and address table", () => {
  const cases: [string, string][] = [
    ["https://127.0.0.1/", "ip-literal"],
    ["https://10.0.0.1/", "ip-literal"],
    ["https://169.254.169.254/latest/meta-data/", "ip-literal"],
    ["https://[::1]/", "ip-literal"],
    ["https://[fc00::1]/", "ip-literal"],
    ["https://2130706433/", "ip-literal"],
    ["https://0x7f.1/", "ip-literal"],
    ["https://0177.0.0.1/", "ip-literal"],
    ["http://example.com/", "scheme"],
    ["ftp://example.com/", "scheme"],
    ["https://example.com:8443/", "port"],
    ["https://user:secret@example.com/", "credentials"],
    ["https://localhost/", "invalid-url"],
    ["not a url", "invalid-url"],
  ];
  it.each(cases)("%s is refused (%s)", (url, expected) => {
    expect(() => checkUrl(url)).toThrowError(EgressError);
    try {
      checkUrl(url);
    } catch (error) {
      expect((error as EgressError).reason).toBe(expected);
    }
  });

  it("accepts a plain https URL on the default port", () => {
    expect(checkUrl("https://example.com:443/a?b=1").href).toBe("https://example.com/a?b=1");
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "100.64.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
  ])("%s is a blocked address", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("%s is public", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("treats numeric-looking hosts as IP literals even outside the URL parser", () => {
    expect(isIpLiteralHost("2130706433")).toBe(true);
    expect(isIpLiteralHost("0x7f")).toBe(true);
    expect(isIpLiteralHost("[::1]")).toBe(true);
    expect(isIpLiteralHost("example.com")).toBe(false);
    expect(isIpLiteralHost("3com.com")).toBe(false);
  });
});

describe("guardedFetch", () => {
  it("fetches a public page and connects to the checked address", async () => {
    const { transport, requests } = transportFor({ "https://example.com/": {} });
    const res = await guardedFetch("https://example.com/", { resolver: resolverFor({ "example.com": [PUBLIC] }), transport });
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/html");
    expect(new TextDecoder().decode(res.body)).toBe("<title>ok</title>");
    expect(requests[0].address).toEqual(PUBLIC);
    expect(requests[0].headers["user-agent"]).toMatch(/Pensieve/);
    expect(Object.keys(requests[0].headers).map((h) => h.toLowerCase())).not.toContain("cookie");
    expect(Object.keys(requests[0].headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });

  it("refuses a name that resolves to a private address", async () => {
    const { transport, requests } = transportFor({});
    const resolver = resolverFor({ "evil.example": [{ address: "10.0.0.5", family: 4 }] });
    expect(await reason(guardedFetch("https://evil.example/", { resolver, transport }))).toBe("private-address");
    expect(requests).toHaveLength(0);
  });

  it("refuses when any one of several answers is private", async () => {
    const { transport } = transportFor({});
    const resolver = resolverFor({ "mixed.example": [PUBLIC, { address: "::1", family: 6 }] });
    expect(await reason(guardedFetch("https://mixed.example/", { resolver, transport }))).toBe("private-address");
  });

  it("resolves once per hop, so a rebinding resolver (public, then private) never reaches the private address", async () => {
    const answers: ResolvedAddress[][] = [[PUBLIC], [{ address: "127.0.0.1", family: 4 }]];
    const resolver = vi.fn<Resolver>(async () => answers.shift()!);
    const { transport, requests } = transportFor({ "https://rebind.example/": {} });
    await guardedFetch("https://rebind.example/", { resolver, transport });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(requests.map((r) => r.address.address)).toEqual([PUBLIC.address]);
  });

  it("re-checks every redirect hop and refuses a redirect into a private range", async () => {
    const { transport, requests } = transportFor({
      "https://example.com/start": { status: 302, headers: { location: "https://internal.example/admin" } },
    });
    const resolver = resolverFor({ "example.com": [PUBLIC], "internal.example": [{ address: "192.168.0.10", family: 4 }] });
    expect(await reason(guardedFetch("https://example.com/start", { resolver, transport }))).toBe("private-address");
    expect(requests).toHaveLength(1);
  });

  it("refuses a redirect to an IP literal or to http", async () => {
    const resolver = resolverFor({ "example.com": [PUBLIC] });
    const toIp = transportFor({ "https://example.com/": { status: 301, headers: { location: "https://169.254.169.254/" } } });
    expect(await reason(guardedFetch("https://example.com/", { resolver, transport: toIp.transport }))).toBe("ip-literal");
    const toHttp = transportFor({ "https://example.com/": { status: 307, headers: { location: "http://example.com/" } } });
    expect(await reason(guardedFetch("https://example.com/", { resolver, transport: toHttp.transport }))).toBe("scheme");
  });

  it("follows at most three redirects", async () => {
    const hop = (n: number) => ({ status: 302, headers: { location: `https://example.com/${n + 1}` } });
    const { transport } = transportFor({
      "https://example.com/0": hop(0),
      "https://example.com/1": hop(1),
      "https://example.com/2": hop(2),
      "https://example.com/3": hop(3),
    });
    const resolver = resolverFor({ "example.com": [PUBLIC] });
    expect(await reason(guardedFetch("https://example.com/0", { resolver, transport }))).toBe("too-many-redirects");

    const ok = transportFor({
      "https://example.com/0": hop(0),
      "https://example.com/1": hop(1),
      "https://example.com/2": hop(2),
      "https://example.com/3": {},
    });
    const res = await guardedFetch("https://example.com/0", { resolver, transport: ok.transport });
    expect(res.finalUrl).toBe("https://example.com/3");
  });

  it("stops reading an oversized body at the cap", async () => {
    let pulled = 0;
    const big = (async function* () {
      for (let i = 0; i < 100; i++) {
        pulled += 1;
        yield new Uint8Array(1024).fill(97);
      }
    })();
    const { transport, destroyed } = transportFor({ "https://example.com/big": { body: big } });
    const res = await guardedFetch("https://example.com/big", {
      resolver: resolverFor({ "example.com": [PUBLIC] }),
      transport,
      maxBytes: 4 * 1024 + 10,
    });
    expect(res.body.byteLength).toBe(4 * 1024 + 10);
    expect(res.truncated).toBe(true);
    expect(pulled).toBe(5);
    expect(destroyed).toContain("https://example.com/big");
  });

  it("asks for gzip or brotli and decodes whichever comes back", async () => {
    const page = "<title>AI Engineering</title>";
    const { transport, requests } = transportFor({
      "https://example.com/gzip": { headers: { "content-encoding": "gzip" }, body: body(gzipSync(page)) },
      "https://example.com/x-gzip": { headers: { "content-encoding": "X-GZIP" }, body: body(gzipSync(page)) },
      "https://example.com/br": { headers: { "content-encoding": "br" }, body: body(brotliCompressSync(page)) },
      "https://example.com/deflate": { headers: { "content-encoding": "deflate" }, body: body(deflateSync(page)) },
      "https://example.com/identity": { headers: { "content-encoding": "identity" }, body: body(page) },
    });
    const resolver = resolverFor({ "example.com": [PUBLIC] });
    for (const path of ["gzip", "x-gzip", "br", "deflate", "identity"]) {
      const res = await guardedFetch(`https://example.com/${path}`, { resolver, transport });
      expect(new TextDecoder().decode(res.body), path).toBe(page);
      expect(res.truncated, path).toBe(false);
    }
    expect(requests[0].headers["accept-encoding"]).toBe("gzip, br");
  });

  it("decodes a compressed body that arrives in pieces", async () => {
    const page = `<title>ok</title>${"<p>text</p>".repeat(2000)}`;
    const packed = gzipSync(page);
    const pieces = [packed.subarray(0, 10), packed.subarray(10, 11), packed.subarray(11)];
    const { transport } = transportFor({ "https://example.com/": { headers: { "content-encoding": "gzip" }, body: body(...pieces) } });
    const res = await guardedFetch("https://example.com/", { resolver: resolverFor({ "example.com": [PUBLIC] }), transport });
    expect(new TextDecoder().decode(res.body)).toBe(page);
  });

  it("applies the cap to the decoded bytes, so a small compressed body cannot expand past it", async () => {
    const packed = gzipSync(new Uint8Array(8 * 1024 * 1024).fill(97));
    expect(packed.byteLength).toBeLessThan(16 * 1024);
    const { transport, destroyed } = transportFor({ "https://example.com/bomb": { headers: { "content-encoding": "gzip" }, body: body(packed) } });
    const res = await guardedFetch("https://example.com/bomb", {
      resolver: resolverFor({ "example.com": [PUBLIC] }),
      transport,
      maxBytes: 4 * 1024 + 10,
    });
    expect(res.body.byteLength).toBe(4 * 1024 + 10);
    expect(res.body.every((b) => b === 97)).toBe(true);
    expect(res.truncated).toBe(true);
    expect(destroyed).toContain("https://example.com/bomb");
  });

  it("reports a body that is not what its content encoding says", async () => {
    const { transport, destroyed } = transportFor({
      "https://example.com/": { headers: { "content-encoding": "gzip" }, body: body("<title>not gzip</title>") },
    });
    expect(await reason(guardedFetch("https://example.com/", { resolver: resolverFor({ "example.com": [PUBLIC] }), transport }))).toBe("network");
    expect(destroyed).toContain("https://example.com/");
  });

  it("refuses a content encoding it cannot decode without reading the body", async () => {
    const resolver = resolverFor({ "example.com": [PUBLIC] });
    for (const encoding of ["zstd", "gzip, br"]) {
      let read = false;
      const lazy = (async function* () {
        read = true;
        yield new Uint8Array(1);
      })();
      const { transport, destroyed } = transportFor({ "https://example.com/": { headers: { "content-encoding": encoding }, body: lazy } });
      expect(await reason(guardedFetch("https://example.com/", { resolver, transport })), encoding).toBe("content-encoding");
      expect(read, encoding).toBe(false);
      expect(destroyed, encoding).toContain("https://example.com/");
    }
  });

  it("refuses a content type other than HTML, PDF or plain text without reading the body", async () => {
    let read = false;
    const lazy = (async function* () {
      read = true;
      yield new Uint8Array(1);
    })();
    const { transport } = transportFor({ "https://example.com/x.zip": { headers: { "content-type": "application/zip" }, body: lazy } });
    const resolver = resolverFor({ "example.com": [PUBLIC] });
    expect(await reason(guardedFetch("https://example.com/x.zip", { resolver, transport }))).toBe("content-type");
    expect(read).toBe(false);
  });

  it("accepts PDF and plain text", async () => {
    const resolver = resolverFor({ "example.com": [PUBLIC] });
    const pdf = transportFor({ "https://example.com/a.pdf": { headers: { "content-type": "application/pdf" } } });
    expect((await guardedFetch("https://example.com/a.pdf", { resolver, transport: pdf.transport })).contentType).toBe("application/pdf");
    const txt = transportFor({ "https://example.com/a.txt": { headers: { "content-type": "text/plain" } } });
    expect((await guardedFetch("https://example.com/a.txt", { resolver, transport: txt.transport })).contentType).toBe("text/plain");
  });

  it("reports non-2xx statuses", async () => {
    const { transport } = transportFor({ "https://example.com/gone": { status: 404 } });
    expect(await reason(guardedFetch("https://example.com/gone", { resolver: resolverFor({ "example.com": [PUBLIC] }), transport }))).toBe("status");
  });

  it("times out a slow response", async () => {
    const slow: Transport = (req) =>
      new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(
      await reason(guardedFetch("https://example.com/", { resolver: resolverFor({ "example.com": [PUBLIC] }), transport: slow, timeoutMs: 20 })),
    ).toBe("timeout");
  });

  it("passes the caller's abort through", async () => {
    const controller = new AbortController();
    const hang: Transport = (req) =>
      new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const pending = guardedFetch("https://example.com/", {
      resolver: resolverFor({ "example.com": [PUBLIC] }),
      transport: hang,
      signal: controller.signal,
    });
    controller.abort();
    expect(await reason(pending)).toBe("aborted");
  });
});
