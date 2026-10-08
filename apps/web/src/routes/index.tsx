import type { RecipeSearchResponse } from "@ishigama-search/api/recipes";
import { For, Show, createSignal } from "solid-js";

import { client } from "~/utils/orpc";

const QUERY_EXAMPLES = ["鶏肉", "じゃがいも", "グラタン", "鶏肉と野菜で作れるおかず"];

export default function Home() {
  const [draft, setDraft] = createSignal("");
  const [submitted, setSubmitted] = createSignal<string | null>(null);
  const [results, setResults] = createSignal<RecipeSearchResponse | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let requestId = 0;

  async function searchRecipes(rawQuery: string) {
    const query = rawQuery.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!query) return;

    const currentRequestId = ++requestId;
    setDraft(query);
    setSubmitted(query);
    setResults(null);
    setFailed(false);
    setLoading(true);

    try {
      const response = await client.recipes.search({ query });
      if (currentRequestId === requestId) setResults(response);
    } catch {
      if (currentRequestId === requestId) setFailed(true);
    } finally {
      if (currentRequestId === requestId) setLoading(false);
    }
  }

  return (
    <main class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <section class="rounded-2xl border border-amber-200 bg-white p-6 sm:p-8">
        <p class="mb-2 text-sm font-medium tracking-wide text-orange-800">東芝 石窯ドーム</p>
        <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">レシピを検索</h1>
        <p class="mt-3 max-w-2xl text-sm leading-6 text-stone-700 sm:text-base">
          食材や料理名から、東芝のオーブンレンジ「石窯ドーム」のレシピを探せます。
        </p>

        <form
          class="mt-6"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            void searchRecipes(draft());
          }}
        >
          <label for="recipe-query" class="mb-2 block text-sm font-medium">
            食材・料理名
          </label>
          <div class="flex flex-col gap-3 sm:flex-row">
            <input
              id="recipe-query"
              name="query"
              type="search"
              value={draft()}
              onInput={(event) => setDraft(event.currentTarget.value)}
              maxlength={500}
              autocomplete="off"
              aria-describedby="recipe-query-help"
              aria-controls="recipe-results"
              placeholder="例：鶏肉、グラタン"
              class="min-w-0 flex-1 rounded-lg border border-stone-300 bg-white px-4 py-3 text-base text-stone-900 outline-none placeholder:text-stone-500 focus:border-orange-700 focus:ring-2 focus:ring-orange-700/30"
            />
            <button
              type="submit"
              class="rounded-lg bg-orange-700 px-6 py-3 font-semibold text-white transition hover:bg-orange-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-800"
            >
              レシピを検索
            </button>
          </div>
          <p id="recipe-query-help" class="mt-2 text-xs text-stone-600">
            食材や料理名だけでなく、作りたい料理や条件を文章で入力して検索できます。
          </p>
        </form>

        <div class="mt-4 flex flex-wrap items-center gap-2" aria-label="検索例">
          <span class="mr-1 text-sm text-stone-600">検索例:</span>
          <For each={QUERY_EXAMPLES}>
            {(example) => (
              <button
                type="button"
                class="rounded-full border border-stone-300 px-3 py-1.5 text-sm text-stone-700 transition hover:border-orange-700 hover:text-orange-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-800"
                onClick={() => void searchRecipes(example)}
              >
                {example}
              </button>
            )}
          </For>
        </div>
      </section>

      <Show when={submitted()}>
        {(request) => (
          <section
            id="recipe-results"
            class="mt-8"
            aria-labelledby="recipe-results-heading"
            aria-busy={loading() ? "true" : "false"}
          >
            <h2 id="recipe-results-heading" class="mb-4 text-xl font-semibold">
              「{request()}」の検索結果
            </h2>

            <Show when={loading()}>
              <p
                class="rounded-lg border border-stone-200 bg-white p-4 text-stone-700"
                role="status"
              >
                レシピを検索しています…
              </p>
            </Show>

            <Show when={failed()}>
              <div class="rounded-lg border border-red-300 bg-red-50 p-5 text-red-900" role="alert">
                <p class="font-medium">検索に失敗しました。</p>
                <p class="mt-1 text-sm text-red-800">接続を確認して、もう一度お試しください。</p>
                <button
                  type="button"
                  class="mt-4 rounded-md border border-red-400 px-4 py-2 text-sm font-medium hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700"
                  onClick={() => void searchRecipes(request())}
                >
                  再試行
                </button>
              </div>
            </Show>

            <Show when={results()} keyed>
              {(response) => (
                <>
                  <p class="mb-4 text-sm text-stone-600" role="status">
                    {response.results.length}件のレシピが見つかりました
                  </p>
                  <Show
                    when={response.results.length > 0}
                    fallback={
                      <p class="rounded-lg border border-stone-200 bg-white p-5 text-stone-700">
                        該当するレシピが見つかりませんでした。食材や料理名を変えてお試しください。
                      </p>
                    }
                  >
                    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <For each={response.results}>
                        {(recipe) => {
                          const description = recipe.description || recipe.excerpt;
                          return (
                            <article class="flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white">
                              <Show when={recipe.image_url} keyed>
                                {(imageUrl) => (
                                  <img
                                    src={imageUrl}
                                    alt={`${recipe.title}の料理写真`}
                                    loading="lazy"
                                    class="aspect-[4/3] w-full object-cover"
                                  />
                                )}
                              </Show>
                              <div class="flex flex-1 flex-col p-5">
                                <h3 class="text-lg font-semibold leading-snug">{recipe.title}</h3>
                                <Show when={recipe.category.length > 0}>
                                  <ul class="mt-3 flex flex-wrap gap-2" aria-label="カテゴリ">
                                    <For each={recipe.category}>
                                      {(category) => (
                                        <li class="rounded-full bg-amber-100 px-2.5 py-1 text-xs text-amber-900">
                                          {category}
                                        </li>
                                      )}
                                    </For>
                                  </ul>
                                </Show>
                                <p class="mt-3 text-sm leading-6 text-stone-700">{description}</p>
                                <div class="mt-auto pt-4">
                                  <Show when={recipe.cooking_minutes !== null}>
                                    <p class="mb-3 text-sm text-orange-800">
                                      加熱目安 約{recipe.cooking_minutes}分
                                    </p>
                                  </Show>
                                  <a
                                    href={recipe.source_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    class="inline-flex rounded-md text-sm font-medium text-orange-800 underline decoration-orange-600/50 underline-offset-4 hover:text-orange-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-800"
                                  >
                                    東芝公式サイトで見る
                                    <span class="sr-only">（新しいタブで開きます）</span>
                                  </a>
                                </div>
                              </div>
                            </article>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </>
              )}
            </Show>
          </section>
        )}
      </Show>
    </main>
  );
}
