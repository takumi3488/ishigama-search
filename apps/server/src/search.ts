import { ORPCError } from "@orpc/server";

import { recipeSummarySchema, type RecipeSearchResponse } from "@ishigama-search/api/recipes";
import { z } from "zod";

const upstreamSearchResponseSchema = z.object({
  chunks: z.array(
    z.object({
      text: z.string(),
      score: z.number().finite().min(0).max(1),
      scoring_details: z
        .object({ reranking_score: z.number().finite().min(0).max(1).optional() })
        .optional(),
      item: z.object({ metadata: z.object({ recipe: z.string() }) }),
    }),
  ),
});

export function normalizeRecipeSearchResponse(
  response: unknown,
  query: string,
  limit: number,
): RecipeSearchResponse {
  const upstream = upstreamSearchResponseSchema.safeParse(response);

  if (!upstream.success) {
    throw new ORPCError("BAD_GATEWAY", { message: "AI Search returned an invalid response." });
  }

  const results: RecipeSearchResponse["results"] = [];
  const seenRecipeIds = new Set<string>();

  for (const chunk of upstream.data.chunks) {
    let parsedMetadata: unknown;
    try {
      parsedMetadata = JSON.parse(chunk.item.metadata.recipe);
    } catch {
      throw new ORPCError("BAD_GATEWAY", {
        message: "AI Search returned malformed recipe metadata.",
      });
    }

    const recipe = recipeSummarySchema.safeParse(parsedMetadata);
    if (!recipe.success) {
      throw new ORPCError("BAD_GATEWAY", {
        message: "AI Search returned invalid or unsafe recipe metadata.",
      });
    }

    if (seenRecipeIds.has(recipe.data.id)) {
      continue;
    }

    const score = chunk.scoring_details?.reranking_score ?? chunk.score;
    results.push({ ...recipe.data, score, excerpt: chunk.text });
    seenRecipeIds.add(recipe.data.id);
    if (results.length === limit) {
      break;
    }
  }

  return { query, results };
}
