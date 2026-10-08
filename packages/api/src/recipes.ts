import { z } from "zod";

const recipeDomain = "toshiba-lifestyle.com";

function isSafeRecipeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.port &&
      !url.username &&
      !url.password &&
      (url.hostname === `www.${recipeDomain}` || url.hostname.endsWith(`.${recipeDomain}`))
    );
  } catch {
    return false;
  }
}

const recipeIdSchema = z.string().regex(/^\d+$/);
const imageUrlSchema = z
  .url()
  .refine(isSafeRecipeUrl, "Expected a Toshiba HTTPS image URL")
  .nullable();
const recipeSummaryFields = {
  id: recipeIdSchema,
  title: z.string().min(1),
  description: z.string(),
  category: z.array(z.string()),
  cooking_minutes: z.number().int().nonnegative().nullable(),
  source_url: z.string(),
  image_url: imageUrlSchema,
};

function hasCanonicalRecipeUrl(value: { id: string; source_url: string }): boolean {
  return (
    value.source_url ===
    `https://www.toshiba-lifestyle.com/jp/microwaves/recipes/detail/er_wd7000/${value.id}`
  );
}

export const recipeSummarySchema = z.object(recipeSummaryFields).refine(hasCanonicalRecipeUrl, {
  message: "Expected the canonical Toshiba recipe URL for this recipe ID",
  path: ["source_url"],
});
export type RecipeSummary = z.infer<typeof recipeSummarySchema>;

export const recipeSchema = z
  .object({
    ...recipeSummaryFields,
    aliases: z.array(z.string()),
    ingredients: z.array(z.string()),
    procedure: z.array(z.string()),
  })
  .refine(hasCanonicalRecipeUrl, {
    message: "Expected the canonical Toshiba recipe URL for this recipe ID",
    path: ["source_url"],
  });
export type Recipe = z.infer<typeof recipeSchema>;

export function normalizeRecipeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

const normalizedQuerySchema = z
  .string()
  .transform(normalizeRecipeText)
  .pipe(z.string().min(1).max(500));

export const recipeSearchInputSchema = z.object({
  query: normalizedQuerySchema,
  limit: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(20))
    .default(12),
});
export type RecipeSearchInput = z.infer<typeof recipeSearchInputSchema>;

const recipeSearchResultSchema = z
  .object({
    ...recipeSummaryFields,
    score: z.number().finite().min(0).max(1),
    excerpt: z.string(),
  })
  .refine(hasCanonicalRecipeUrl, {
    message: "Expected the canonical Toshiba recipe URL for this recipe ID",
    path: ["source_url"],
  });

export const recipeSearchResponseSchema = z.object({
  query: z.string().min(1).max(500),
  results: z.array(recipeSearchResultSchema),
});
export type RecipeSearchResponse = z.infer<typeof recipeSearchResponseSchema>;
