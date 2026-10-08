import type { RouterClient } from "@orpc/server";

import { publicProcedure } from "../index";
import { recipeSearchInputSchema, recipeSearchResponseSchema } from "../recipes";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
  recipes: {
    search: publicProcedure
      .route({ method: "GET", path: "/recipes/search" })
      .input(recipeSearchInputSchema)
      .output(recipeSearchResponseSchema)
      .handler(({ input, context }) => context.searchRecipes(input)),
  },
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
