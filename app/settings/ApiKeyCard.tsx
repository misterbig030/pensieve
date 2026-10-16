"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { KeyErrorKind, ModelProvider } from "@/lib/ai/models";
import { removeApiKeyAction, saveApiKeyAction } from "./actions";

export interface StoredKey {
  provider: ModelProvider;
  providerName: string;
  last4: string;
  /** Formatted on the server. */
  addedAt: string;
  lastError: KeyErrorKind | null;
  /** "2 hours ago", formatted on the server. */
  lastErrorAgo: string | null;
}

const ERROR_LINES: Record<KeyErrorKind, string> = {
  credits: "credits exhausted. Anthropic stopped requests until your next monthly credits arrive. Add credits or turn on auto-reload in the Console, or remove the key to use Pensieve's.",
  invalid: "the key was rejected. Replace it, or remove it to use Pensieve's.",
  rate_limit: "rate-limited. Try again in a minute.",
  other: "an error from the provider. Try again; if it keeps happening, check the Console.",
};

export function ApiKeyCard({ stored }: { stored: StoredKey | null }) {
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const result = await saveApiKeyAction({ key });
      setMessage(result.ok ? null : result.message);
      if (result.ok) setKey("");
    });
  const remove = (provider: ModelProvider) =>
    start(async () => {
      await removeApiKeyAction({ provider });
      setMessage(null);
    });

  return (
    <div className="rounded-xl bg-card p-5 text-sm text-card-foreground ring-1 ring-foreground/10">
      <h3 className="font-heading text-[18px]">API key</h3>
      {stored ? (
        <>
          <p className="mt-1 text-muted-foreground">
            Your drafts, research, daily content and chat run on this key. Usage appears on your Console&apos;s cost page.
          </p>
          {stored.lastError && (
            <p className="mt-3 rounded-lg border-l-2 border-primary bg-primary/10 px-3 py-2">
              <b>Last request refused {stored.lastErrorAgo}:</b> {ERROR_LINES[stored.lastError]}{" "}
              <a className="underline" href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">
                Console billing
              </a>
            </p>
          )}
          <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2">
            <span>
              {stored.providerName} key ending in <code className="font-mono">…{stored.last4}</code>
            </span>
            <span className="text-xs text-muted-foreground">added {stored.addedAt}</span>
            <Button variant="secondary" disabled={pending} onClick={() => remove(stored.provider)}>
              Remove
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">To change keys, remove this one and save another. The key itself is never shown.</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-muted-foreground">
            Pensieve runs on Claude models, so the key has to be an Anthropic key for now. Claude Max and Team plans include monthly API credits; Pro and Free
            don&apos;t, but a key with a card behind it works the same way.
          </p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input type="password" autoComplete="off" placeholder="Paste your key" value={key} onChange={(e) => setKey(e.target.value)} />
            <Button type="submit" disabled={pending || key.trim().length === 0}>
              Save key
            </Button>
          </form>
          {message && <p className="mt-2 text-sm text-red-700">{message}</p>}
          <details className="mt-3 text-[13px]">
            <summary className="cursor-pointer text-primary">How to get a key that spends your plan&apos;s credits</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>
                On claude.ai, open <b>Settings → Billing → API credits</b> and link a Console organization (or create one). Credits arrive each billing cycle.
              </li>
              <li>
                In the{" "}
                <a className="underline" href="https://platform.claude.com/" target="_blank" rel="noreferrer">
                  Claude Console
                </a>
                , signed in with the same email, create a workspace for Pensieve and give it a <b>spend limit</b>. Any key in the organization can spend the
                whole balance; the limit caps what this one can.
              </li>
              <li>Create an API key in that workspace and paste it above. Pensieve stores it encrypted and never shows it again.</li>
            </ol>
            <p className="mt-2 text-xs text-muted-foreground">
              When your credits run out, generations stop with a message rather than falling back to Pensieve&apos;s key. Add credits or turn on auto-reload in
              the Console to continue.
            </p>
          </details>
        </>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Without a key, Pensieve pays.{" "}
        <Link className="underline" href="/dashboard">
          Back to the dashboard
        </Link>
      </p>
    </div>
  );
}
