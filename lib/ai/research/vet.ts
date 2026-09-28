import type { Material } from "@/lib/schemas/material";
import { signingSecret, verifyMaterialSig } from "./signature";
import { SourceFetcher } from "./tools";
import { createOpenLibraryLookup, reverifyMaterial, titleMatches, type BookLookup } from "./verify";

export interface VetResult {
  materials: Material[];
  /** Researched materials whose signature failed and that no longer pass the gate. */
  dropped: Material[];
  /** Materials whose signature failed and that were checked again. */
  reverified: number;
}

export interface VetOptions {
  fetcher?: SourceFetcher;
  books?: BookLookup;
  secret?: string;
  signal?: AbortSignal;
}

/**
 * Runs on confirm, before a plan is saved. A researched material with a bad or missing signature, or a title that
 * no longer matches the page title it was signed with, goes back through the gate and is dropped if it fails. A
 * learner's own material is always kept, but a "verified" claim it cannot back with a signature is cleared. At most
 * one backbone, and only a book, survives.
 */
export async function vetMaterials(materials: Material[], options: VetOptions = {}): Promise<VetResult> {
  const secret = options.secret ?? signingSecret();
  const fetcher = options.fetcher ?? new SourceFetcher();
  const books = options.books ?? createOpenLibraryLookup();
  const dropped: Material[] = [];
  let reverified = 0;

  const checked = await Promise.all(
    materials.map(async (m): Promise<Material | null> => {
      if (m.origin === "learner") {
        if (m.verifiedAt && !verifyMaterialSig(m, m.sig, secret)) return { ...m, verifiedAt: null, fetchedTitle: null, sig: null };
        return m;
      }
      // The signature covers the page's title, not the one shown: that must still be the page's.
      if (verifyMaterialSig(m, m.sig, secret) && titleMatches(m.title, [m.fetchedTitle]).ok) return m;
      reverified += 1;
      const again = await reverifyMaterial(m, fetcher, books, secret, options.signal);
      if (!again) dropped.push(m);
      return again;
    }),
  );

  let backboneTaken = false;
  const kept = checked
    .filter((m): m is Material => m !== null)
    .map((m) => {
      const backbone = m.backbone && m.kind === "book" && !backboneTaken;
      if (backbone) backboneTaken = true;
      return backbone === m.backbone ? m : { ...m, backbone };
    });
  return { materials: kept, dropped, reverified };
}
