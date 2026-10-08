import type { RecipeSearchInput, RecipeSearchResponse } from "./recipes";

export type Context = {
  searchRecipes(input: RecipeSearchInput): Promise<RecipeSearchResponse>;
};
