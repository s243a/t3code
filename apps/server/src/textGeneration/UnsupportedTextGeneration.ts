/**
 * Text generation for providers that do not offer one.
 *
 * `ProviderInstance` requires a `TextGeneration` service, but commit messages,
 * branch names and thread titles are produced by asking a provider's own
 * one-shot text API — something the Agent Client Protocol does not define. A
 * generic ACP agent therefore has nothing to answer with.
 *
 * Failing explicitly is the honest response. Returning invented text would put
 * a fabricated commit message in front of a user as though the agent wrote it,
 * and callers already treat this error as "fall back to the non-generated
 * default".
 *
 * @module textGeneration/UnsupportedTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "./TextGeneration.ts";

/**
 * @param providerLabel Named in the error so a user can tell which provider
 * declined rather than seeing an anonymous failure.
 */
export function makeUnsupportedTextGeneration(providerLabel: string): TextGeneration["Service"] {
  const decline = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${providerLabel} does not provide a text generation API.`,
      }),
    );

  return {
    generateCommitMessage: () => decline("generateCommitMessage"),
    generatePrContent: () => decline("generatePrContent"),
    generateBranchName: () => decline("generateBranchName"),
    generateThreadTitle: () => decline("generateThreadTitle"),
  };
}
