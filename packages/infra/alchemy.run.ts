import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import "varlock/auto-load";

const recipeSearchNamespace = Cloudflare.AI.SearchNamespace("recipes", {
  name: Config.String("AI_SEARCH_NAMESPACE"),
}).pipe(RemovalPolicy.retain());

export const server = Cloudflare.Worker("server", {
  main: "../../apps/server/src/index.ts",
  compatibility: {
    flags: ["nodejs_compat"],
    date: "2026-09-25",
  },
  env: {
    AI_SEARCH: recipeSearchNamespace,
    AI_SEARCH_INSTANCE: Config.String("AI_SEARCH_INSTANCE"),
    CORS_ORIGIN: Config.String("CORS_ORIGIN"),
  },
  dev: {
    port: 3000,
  },
});

export type ServerEnv = Cloudflare.InferEnv<typeof server>;

export default Alchemy.Stack(
  "ishigama-search",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const recipeNamespace = yield* recipeSearchNamespace;
    const recipeInstance = yield* Config.String("AI_SEARCH_INSTANCE");
    const serverWorker = yield* server;
    const webWorker = yield* Cloudflare.Website.Vite("web", {
      rootDir: "../../apps/web",
      compatibility: {
        flags: ["nodejs_compat"],
      },
      env: {
        VITE_SERVER_URL: serverWorker.url.as<string>(),
      },
      dev: {
        port: 3001,
      },
    });

    return {
      aiSearchNamespace: recipeNamespace.name,
      aiSearchInstance: recipeInstance,
      web: webWorker.url,
      server: serverWorker.url,
    };
  }),
);
