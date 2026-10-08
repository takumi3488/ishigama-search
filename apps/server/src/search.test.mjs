import { expect, test } from "bun:test";

import { recipeSearchInputSchema } from "@ishigama-search/api/recipes";
import { normalizeRecipeSearchResponse } from "./search.ts";

function chunk(id, text, score, rerankingScore = score, sourceUrl) {
  const recipe = {
    id: String(id),
    title: `Recipe ${id}`,
    description: "Test description",
    category: ["主菜"],
    cooking_minutes: 10,
    source_url:
      sourceUrl ?? `https://www.toshiba-lifestyle.com/jp/microwaves/recipes/detail/er_wd7000/${id}`,
    image_url: null,
  };

  return {
    text,
    score,
    scoring_details: { reranking_score: rerankingScore },
    item: { metadata: { recipe: JSON.stringify(recipe) } },
  };
}

test("keeps the first reranked recipe chunk and rejects unsafe metadata URLs", () => {
  const result = normalizeRecipeSearchResponse(
    {
      chunks: [
        chunk(1522, "best excerpt", 0.8, 0.91),
        chunk(1522, "duplicate excerpt", 0.99, 0.99),
        chunk(1515, "next recipe", 0.7, 0.75),
      ],
    },
    "鶏肉",
    2,
  );

  expect(result.results.map(({ id, score, excerpt }) => ({ id, score, excerpt }))).toEqual([
    { id: "1522", score: 0.91, excerpt: "best excerpt" },
    { id: "1515", score: 0.75, excerpt: "next recipe" },
  ]);
  let metadataError;
  try {
    normalizeRecipeSearchResponse(
      { chunks: [chunk(1522, "unsafe", 0.5, 0.5, "https://attacker.example/recipe/1522")] },
      "鶏肉",
      12,
    );
  } catch (error) {
    metadataError = error;
  }
  expect(metadataError).toMatchObject({ code: "BAD_GATEWAY" });
});

test("accepts valid HTTP limit strings and rejects invalid limits", () => {
  expect(recipeSearchInputSchema.parse({ query: "鶏肉", limit: "1" }).limit).toBe(1);

  for (const limit of ["", "1.5", "0", "21", true, 1.5]) {
    expect(() => recipeSearchInputSchema.parse({ query: "鶏肉", limit })).toThrow();
  }
});
