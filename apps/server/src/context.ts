import { ORPCError } from "@orpc/server";
import type { Context as ApiContext } from "@ishigama-search/api/context";
import type { ServerEnv } from "@ishigama-search/infra/alchemy.run";
import type { Context as HonoContext } from "hono";

import { normalizeRecipeSearchResponse } from "./search";

export type CreateContextOptions = {
  context: HonoContext<{ Bindings: ServerEnv }>;
};

export async function createContext({ context }: CreateContextOptions): Promise<ApiContext> {
  const { AI_SEARCH, AI_SEARCH_INSTANCE } = context.env;
  return {
    searchRecipes: async (input) => {
      let response: unknown;
      try {
        response = await AI_SEARCH.get(AI_SEARCH_INSTANCE).search({
          messages: [{ role: "user", content: input.query }],
          ai_search_options: {
            retrieval: {
              retrieval_type: "hybrid",
              fusion_method: "rrf",
              keyword_match_mode: "or",
              max_num_results: 50,
              match_threshold: 0,
              return_on_failure: false,
            },
            reranking: {
              enabled: true,
              model: "@cf/baai/bge-reranker-base",
              // Reranker scores are not calibrated relevance probabilities.
              match_threshold: 0,
            },
            query_rewrite: { enabled: false },
            cache: { enabled: false },
          },
        });
      } catch (error) {
        console.error("AI Search recipe search failed.", error);
        throw new ORPCError("BAD_GATEWAY", { message: "Recipe search service failed." });
      }

      return normalizeRecipeSearchResponse(response, input.query, input.limit);
    },
  };
}

export type Context = ApiContext;
