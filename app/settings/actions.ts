"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MODEL_PROVIDERS, type ModelProvider } from "@/lib/ai/models";
import { PROVIDER_NAMES, verifyProviderKey } from "@/lib/ai/providerKeys";
import { deleteUserApiKey, upsertUserApiKey } from "@/lib/db/userApiKeys";
import { sealSecret } from "@/lib/secrets";
import { prepareKey } from "./prepareKey";

const keySchema = z.string().min(1).max(500);

export type SaveApiKeyResult = { ok: true; provider: ModelProvider; last4: string } | { ok: false; message: string };

/** Detects, verifies, encrypts and stores a key. Never returns it. */
export async function saveApiKeyAction(input: { key: string }): Promise<SaveApiKeyResult> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const parsed = keySchema.safeParse(input.key);
  if (!parsed.success) return { ok: false, message: "That key isn't one Pensieve recognises. Nothing was saved." };

  const prepared = prepareKey(parsed.data);
  if (!prepared.ok) return prepared;

  const check = await verifyProviderKey(prepared.provider, prepared.key);
  if (!check.ok) {
    return check.reason === "invalid"
      ? { ok: false, message: `That key was not accepted by ${PROVIDER_NAMES[prepared.provider]}. Nothing was saved.` }
      : { ok: false, message: `${PROVIDER_NAMES[prepared.provider]} could not be reached to check the key. Try again in a moment.` };
  }

  const sealed = sealSecret(prepared.key);
  const last4 = prepared.key.slice(-4);
  await upsertUserApiKey({ userId, provider: prepared.provider, ciphertext: sealed.ciphertext, last4, secretVersion: sealed.version });
  revalidatePath("/settings");
  return { ok: true, provider: prepared.provider, last4 };
}

export async function removeApiKeyAction(input: { provider: ModelProvider }): Promise<void> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated");
  const provider = z.enum(MODEL_PROVIDERS).parse(input.provider);
  await deleteUserApiKey(userId, provider);
  revalidatePath("/settings");
}
