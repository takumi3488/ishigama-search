import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "parse5";
import {
  normalizeRecipeText,
  recipeSchema,
  recipeSummarySchema,
  type Recipe,
} from "../packages/api/src/recipes";

const TOSHIBA_ORIGIN = "https://www.toshiba-lifestyle.com";
const LISTING_URL = `${TOSHIBA_ORIGIN}/jp/microwaves/recipes/er_wd7000`;
const RECIPE_PATH = "/jp/microwaves/recipes/detail/er_wd7000/";
const DEFAULT_OUTPUT = "data/recipes.jsonl";
const USER_AGENT = "IshigamaRecipeSearch/1.0 (Toshiba ER-WD7000 recipe indexer)";
const API_ROOT = "https://api.cloudflare.com/client/v4";
const MAX_RECIPE_METADATA_BYTES = 8 * 1024;
const SCRAPE_DELAY_MS = 1_000;

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  parentNode?: HtmlNode | null;
}

interface CliOptions {
  command: "setup" | "scrape" | "index";
  output: string;
  limit?: number;
  wait: boolean;
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
  result_info?: { page: number; total_count: number; per_page?: number };
}

interface CloudflareRequestOptions {
  method?: string;
  body?: BodyInit;
  contentType?: string;
  allowNotFound?: boolean;
}

interface CloudflareConfig {
  accountId: string;
  token: string;
  namespace: string;
  instance: string;
}

interface CloudflareInstance {
  id: string;
  source?: string | null;
  type?: "r2" | "web-crawler" | null;
}

interface SearchItem {
  id: string;
  key: string;
  source_id?: string | null;
  metadata?: Record<string, string | number | boolean> | null;
  status?: string;
  error?: string;
}

interface RecipeVersion extends SearchItem {
  recipeId: string;
  version: string;
}

function elementChildren(node: HtmlNode): HtmlNode[] {
  return (node.childNodes ?? []).filter((child) => child.tagName !== undefined);
}

function descendants(node: HtmlNode, predicate: (candidate: HtmlNode) => boolean): HtmlNode[] {
  const found: HtmlNode[] = [];
  const visit = (current: HtmlNode): void => {
    if (current.tagName && predicate(current)) found.push(current);
    for (const child of current.childNodes ?? []) visit(child);
  };
  visit(node);
  return found;
}

function firstDescendant(
  node: HtmlNode,
  predicate: (candidate: HtmlNode) => boolean,
): HtmlNode | undefined {
  if (node.tagName && predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = firstDescendant(child, predicate);
    if (found) return found;
  }
  return undefined;
}

function attr(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((attribute) => attribute.name === name)?.value;
}

function hasClass(node: HtmlNode, name: string): boolean {
  return (attr(node, "class") ?? "").split(/\s+/u).includes(name);
}

const BLOCK_ELEMENT =
  /^(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|tbody|td|tfoot|th|thead|tr|ul)$/u;

function normalizedVisibleText(node: HtmlNode): string {
  let text = "";
  const visit = (current: HtmlNode): void => {
    if (current.nodeName === "#text") {
      text += current.value ?? "";
      return;
    }
    if (current.tagName === "br") {
      text += "\n";
      return;
    }
    const block = current.tagName !== undefined && BLOCK_ELEMENT.test(current.tagName);
    const separated = hasClass(current, "label") || hasClass(current, "quantity");
    if (block) text += "\n";
    if (separated) text += " ";
    for (const child of current.childNodes ?? []) visit(child);
    if (separated) text += " ";
    if (block) text += "\n";
  };
  visit(node);
  return text
    .replace(/\u00a0/gu, " ")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function getDirectChild(node: HtmlNode, tagName: string): HtmlNode | undefined {
  return elementChildren(node).find((child) => child.tagName === tagName);
}

function failParse(id: string, detail: string): never {
  throw new Error(`Toshiba recipe ${id}: ${detail}`);
}

export function parseHeatingMinutes(value: string): number | null {
  let minutes: number | null = null;
  for (const clause of value.split(/[+＋]/u)) {
    const heating = clause.normalize("NFKC").replace(/[\s\u00a0]/gu, "");
    const hourMinute = /^加熱約?(\d+)時間(?:([0-9]+)分)?$/u.exec(heating);
    const duration = hourMinute
      ? Number(hourMinute[1]) * 60 + Number(hourMinute[2] ?? 0)
      : Number(/^加熱約?(\d+)分$/u.exec(heating)?.[1]);
    if (Number.isNaN(duration)) continue;
    if (minutes !== null) return null;
    minutes = duration;
  }
  return minutes !== null && Number.isSafeInteger(minutes) && minutes >= 0 ? minutes : null;
}

export function extractRecipeLinks(html: string): Array<{ id: string; url: string }> {
  const document = parse(html) as unknown as HtmlNode;
  const seen = new Set<string>();
  const links: Array<{ id: string; url: string }> = [];
  for (const anchor of descendants(document, (node) => node.tagName === "a")) {
    const href = attr(anchor, "href");
    if (!href) continue;
    const url = new URL(href, LISTING_URL);
    if (url.origin !== TOSHIBA_ORIGIN) continue;
    const match = /^\/jp\/microwaves\/recipes\/detail\/er_wd7000\/(\d+)\/?$/u.exec(url.pathname);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    links.push({ id: match[1], url: `${TOSHIBA_ORIGIN}${RECIPE_PATH}${match[1]}` });
  }
  return links;
}

function categoryValues(detail: HtmlNode, titleHeading: HtmlNode): string[] {
  const categories = new Set<string>();
  for (const image of descendants(titleHeading, (node) => node.tagName === "img")) {
    const category = (attr(image, "alt") ?? "").trim();
    if (category) categories.add(category);
  }
  const recipeLayout = firstDescendant(detail, (node) => hasClass(node, "lytRecipe5"));
  if (recipeLayout) {
    const recipeMeta = firstDescendant(recipeLayout, (node) => hasClass(node, "listRecipe4"));
    if (recipeMeta) {
      for (const row of descendants(recipeMeta, (node) => node.tagName === "dl")) {
        const label = getDirectChild(row, "dt");
        const value = getDirectChild(row, "dd");
        if (label && value && normalizedVisibleText(label) === "メニュー") {
          const menu = normalizedVisibleText(value);
          if (menu) categories.add(menu);
        }
      }
    }
  }
  return [...categories];
}

function sourceImageUrl(image: HtmlNode | undefined, id: string): string | null {
  if (!image) return null;
  const src = attr(image, "src")?.trim();
  if (!src || src.startsWith("data:")) return null;
  const url = new URL(src, TOSHIBA_ORIGIN);
  if (url.origin !== TOSHIBA_ORIGIN) failParse(id, `recipe image is not hosted on Toshiba: ${src}`);
  if (url.pathname.endsWith("/227x227.png")) return null;
  return url.href;
}

function procedureEntries(document: HtmlNode, id: string): string[] {
  const entries: Array<{ node: HtmlNode; text: string }> = [];
  const steps = descendants(
    document,
    (node) => node.tagName === "ol" && hasClass(node, "lytRecipe3"),
  );
  if (steps.length !== 1)
    failParse(id, `expected one ordered procedure list, found ${steps.length}`);
  for (const step of elementChildren(steps[0]).filter((node) => node.tagName === "li")) {
    const content = firstDescendant(step, (node) => hasClass(node, "content"));
    if (!content) failParse(id, "procedure step is missing its content element");
    const text = normalizedVisibleText(content);
    if (!text) failParse(id, "procedure step has no source text");
    const marker = firstDescendant(step, (node) => hasClass(node, "mark"));
    const markerText = marker ? normalizedVisibleText(marker) : "";
    entries.push({ node: step, text: markerText ? `${markerText}. ${text}` : text });
  }

  for (const heading of descendants(document, (node) => node.tagName === "h2")) {
    const sectionName = normalizedVisibleText(heading);
    if (sectionName !== "下準備" && sectionName !== "ポイント") continue;
    const siblings = heading.parentNode ? elementChildren(heading.parentNode) : [];
    const section = siblings[siblings.indexOf(heading) + 1];
    if (!section || !hasClass(section, "lytRecipe2")) {
      failParse(id, `procedure section ${sectionName} is missing its source content`);
    }
    const contentItems = descendants(section, (node) => hasClass(node, "content"));
    if (contentItems.length === 0) failParse(id, `procedure section ${sectionName} has no content`);
    for (const content of contentItems) {
      const text = normalizedVisibleText(content);
      if (text) entries.push({ node: content, text: `${sectionName}: ${text}` });
    }
  }

  const documentOrder = new Map<HtmlNode, number>();
  let order = 0;
  const visit = (node: HtmlNode): void => {
    if (node.tagName) documentOrder.set(node, order++);
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(document);
  entries.sort((a, b) => (documentOrder.get(a.node) ?? 0) - (documentOrder.get(b.node) ?? 0));
  const result = entries.map((entry) => entry.text);
  if (result.length === 0) failParse(id, "recipe has no procedure or preparation text");
  return result;
}

export function parseRecipeDetail(html: string, id: string): Recipe {
  if (!/^\d+$/u.test(id)) throw new Error(`Invalid Toshiba recipe ID: ${id}`);
  const document = parse(html) as unknown as HtmlNode;
  const heading = descendants(
    document,
    (node) => node.tagName === "h1" && hasClass(node, "headH2"),
  )[0];
  if (!heading) failParse(id, "could not find h1.headH2 recipe title");
  const titleText = firstDescendant(heading, (node) => hasClass(node, "text"));
  const title = titleText ? normalizedVisibleText(titleText) : normalizedVisibleText(heading);
  if (!title) failParse(id, "recipe title is empty");

  const recipeLayout = firstDescendant(document, (node) => hasClass(node, "lytRecipe5"));
  if (!recipeLayout) failParse(id, "could not find .lytRecipe5 recipe summary");
  const layoutItems = elementChildren(recipeLayout).filter((node) => hasClass(node, "item"));
  if (layoutItems.length === 0) failParse(id, "recipe summary has no content item");
  const description = elementChildren(layoutItems[0])
    .filter((node) => node.tagName === "p")
    .map(normalizedVisibleText)
    .filter(Boolean)
    .join("\n\n");
  const mainImageItem = layoutItems.find(
    (item) =>
      descendants(item, (node) => node.tagName === "div" && hasClass(node, "image")).length > 0,
  );
  const mainImage = mainImageItem
    ? descendants(
        mainImageItem,
        (node) => node.tagName === "div" && hasClass(node, "image"),
      ).flatMap((wrapper) => descendants(wrapper, (node) => node.tagName === "img"))[0]
    : undefined;
  const image_url = sourceImageUrl(mainImage, id);

  const categories = categoryValues(document, heading);
  const metadata = firstDescendant(recipeLayout, (node) => hasClass(node, "listRecipe4"));
  let cooking_minutes: number | null = null;
  if (metadata) {
    for (const row of descendants(metadata, (node) => node.tagName === "dl")) {
      const label = getDirectChild(row, "dt");
      const value = getDirectChild(row, "dd");
      if (label && value && normalizedVisibleText(label) === "調理時間の目安") {
        cooking_minutes = parseHeatingMinutes(normalizedVisibleText(value));
        break;
      }
    }
  }

  const ingredientAnchor = descendants(document, (node) => attr(node, "id") === "anchor-1")[0];
  if (!ingredientAnchor) failParse(id, "could not find #anchor-1 ingredient tabs");
  const panels = descendants(ingredientAnchor, (node) => hasClass(node, "js-panel-item"));
  if (panels.length === 0) failParse(id, "ingredient tabs have no panels");
  const tabLabels = descendants(
    ingredientAnchor,
    (node) => node.tagName === "button" && hasClass(node, "js-tab-button"),
  ).map(normalizedVisibleText);
  if (tabLabels.length !== panels.length) {
    failParse(
      id,
      `ingredient tab/panel count differs (${tabLabels.length} tabs, ${panels.length} panels)`,
    );
  }
  const ingredients: string[] = [];
  panels.forEach((panel, panelIndex) => {
    const lists = descendants(panel, (node) => hasClass(node, "lytRecipe4"));
    if (lists.length === 0)
      failParse(id, `ingredient tab ${panelIndex + 1} is missing its ingredient list`);
    for (const list of lists) {
      const siblings = list.parentNode ? elementChildren(list.parentNode) : [];
      const previous = siblings[siblings.indexOf(list) - 1];
      const group =
        previous?.tagName === "h3" && hasClass(previous, "headH4")
          ? normalizedVisibleText(previous)
          : "";
      for (const row of descendants(list, (node) => node.tagName === "li")) {
        let rowText = normalizedVisibleText(row).replace(/\n/gu, " ");
        if (!rowText) continue;
        ingredients.push([tabLabels[panelIndex], group, rowText].filter(Boolean).join(": "));
      }
    }
  });
  if (ingredients.length === 0) failParse(id, "recipe has no ingredient rows");

  const aliases = normalizeRecipeText(title) === title ? [] : [normalizeRecipeText(title)];
  const recipe = recipeSchema.parse({
    id,
    title,
    aliases,
    ingredients,
    description,
    procedure: procedureEntries(document, id),
    category: categories,
    cooking_minutes,
    source_url: `${TOSHIBA_ORIGIN}${RECIPE_PATH}${id}`,
    image_url,
  });
  return recipe;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}

function searchConfig(): CloudflareConfig {
  const accountId = requiredEnvironment("CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-f0-9]{32}$/iu.test(accountId))
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  const namespace = process.env.AI_SEARCH_NAMESPACE?.trim() || "ishigama-recipes";
  const instance = process.env.AI_SEARCH_INSTANCE?.trim() || "er_wd7000";
  if (!/^[a-z0-9_-]{1,64}$/u.test(namespace))
    throw new Error(
      "AI_SEARCH_NAMESPACE must use lowercase letters, digits, hyphens, or underscores",
    );
  if (!/^[a-z0-9_-]{1,64}$/u.test(instance))
    throw new Error(
      "AI_SEARCH_INSTANCE must use lowercase letters, digits, hyphens, or underscores",
    );
  return { accountId, token: requiredEnvironment("CLOUDFLARE_API_TOKEN"), namespace, instance };
}

function cloudflareRequest<T>(
  config: CloudflareConfig,
  path: string,
  init: CloudflareRequestOptions & { allowNotFound: true },
): Promise<CloudflareEnvelope<T> | null>;
function cloudflareRequest<T>(
  config: CloudflareConfig,
  path: string,
  init?: CloudflareRequestOptions & { allowNotFound?: false },
): Promise<CloudflareEnvelope<T>>;
async function cloudflareRequest<T>(
  config: CloudflareConfig,
  path: string,
  init: CloudflareRequestOptions = {},
): Promise<CloudflareEnvelope<T> | null> {
  const response = await fetch(`${API_ROOT}/accounts/${config.accountId}/ai-search/${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(init.contentType ? { "Content-Type": init.contentType } : {}),
    },
    body: init.body,
  });
  if (response.status === 404 && init.allowNotFound) return null;
  let envelope: CloudflareEnvelope<T>;
  try {
    envelope = (await response.json()) as CloudflareEnvelope<T>;
  } catch {
    throw new Error(
      `Cloudflare API ${init.method ?? "GET"} ${path} returned invalid JSON (HTTP ${response.status})`,
    );
  }
  if (!response.ok || !envelope.success) {
    const detail = (envelope.errors ?? [])
      .map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(
      `Cloudflare API ${init.method ?? "GET"} ${path} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return envelope;
}

async function setupSearch(): Promise<void> {
  const config = searchConfig();
  const namespacePath = `namespaces/${encodeURIComponent(config.namespace)}`;
  const namespaceResponse = await cloudflareRequest<{ name: string }>(config, namespacePath, {
    allowNotFound: true,
  });
  if (!namespaceResponse) {
    await cloudflareRequest(config, "namespaces", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name: config.namespace, description: "Toshiba ER-WD7000 recipes" }),
    });
    console.log(`Created AI Search namespace ${config.namespace}`);
  } else {
    console.log(`Reusing AI Search namespace ${config.namespace}`);
  }

  const instancePath = `${namespacePath}/instances/${encodeURIComponent(config.instance)}`;
  const instanceResponse = await cloudflareRequest<CloudflareInstance>(config, instancePath, {
    allowNotFound: true,
  });
  const existingInstance = instanceResponse?.result;
  if (existingInstance && (existingInstance.source?.trim() || existingInstance.type)) {
    throw new Error(
      `AI Search instance ${config.instance} already uses an external source; refusing to repurpose it`,
    );
  }
  const exists = existingInstance !== undefined;
  const instanceConfig = {
    ...(exists ? {} : { id: config.instance }),
    cache: false,
    custom_metadata: [{ field_name: "recipe", data_type: "text" }],
    embedding_model: "@cf/qwen/qwen3-embedding-0.6b",
    fusion_method: "rrf",
    index_method: { vector: true, keyword: true },
    indexing_options: { keyword_tokenizer: "trigram" },
    max_num_results: 50,
    reranking: true,
    reranking_model: "@cf/baai/bge-reranker-base",
    retrieval_options: { keyword_match_mode: "or" },
    rewrite_query: false,
  };
  const instanceWritePath = exists ? instancePath : `${namespacePath}/instances`;
  // Omit source and type so Cloudflare creates its managed built-in upload storage.
  await cloudflareRequest(config, instanceWritePath, {
    method: exists ? "PUT" : "POST",
    contentType: "application/json",
    body: JSON.stringify(instanceConfig),
  });
  console.log(
    `${exists ? "Updated" : "Created"} built-in AI Search instance ${config.instance} in namespace ${config.namespace}`,
  );
}

async function fetchToshibaHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Toshiba request failed for ${url} (HTTP ${response.status})`);
  const responseUrl = new URL(response.url);
  if (responseUrl.origin !== TOSHIBA_ORIGIN)
    throw new Error(`Toshiba request redirected outside the source origin: ${url}`);
  return response.text();
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error("--limit must be a positive integer");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error("--limit must be a positive integer");
  return limit;
}

async function scrapeRecipes(output: string, limit?: number): Promise<void> {
  const listing = await fetchToshibaHtml(LISTING_URL);
  const discovered = extractRecipeLinks(listing);
  if (discovered.length === 0)
    throw new Error("The Toshiba ER-WD7000 listing contained no recipe detail links");
  const selected = limit === undefined ? discovered : discovered.slice(0, limit);
  if (limit !== undefined) {
    console.log(
      `SMOKE SCOPE ONLY: crawling ${selected.length} of ${discovered.length} discovered recipe details`,
    );
  } else {
    console.log(`Crawling all ${discovered.length} recipe details discovered in the full listing`);
  }
  const recipes: Recipe[] = [];
  for (let index = 0; index < selected.length; index++) {
    if (index > 0)
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, SCRAPE_DELAY_MS));
    const entry = selected[index];
    const html = await fetchToshibaHtml(entry.url);
    const recipe = parseRecipeDetail(html, entry.id);
    if (recipe.source_url !== entry.url)
      throw new Error(`Toshiba recipe ${entry.id}: canonical URL mismatch`);
    recipes.push(recipe);
    console.log(`[${index + 1}/${selected.length}] ${recipe.id} ${recipe.title}`);
  }
  const ids = new Set<string>();
  for (const recipe of recipes) {
    if (ids.has(recipe.id)) throw new Error(`Duplicate recipe ID in crawl output: ${recipe.id}`);
    ids.add(recipe.id);
  }
  await mkdir(dirname(output), { recursive: true });
  const jsonl = recipes.map((recipe) => JSON.stringify(recipe)).join("\n") + "\n";
  await writeFile(output, jsonl, "utf8");
  console.log(`Wrote ${recipes.length} normalized Toshiba recipes to ${output}`);
}

async function readRecipes(input: string): Promise<Recipe[]> {
  const source = await readFile(input, "utf8");
  const lines = source.split(/\r?\n/u).filter((line) => line.trim());
  const recipes = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${input}:${index + 1}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const parsed = recipeSchema.safeParse(value);
    if (!parsed.success)
      throw new Error(`${input}:${index + 1}: invalid recipe: ${parsed.error.message}`);
    return parsed.data;
  });
  const ids = new Set<string>();
  for (const recipe of recipes) {
    if (ids.has(recipe.id)) throw new Error(`${input}: duplicate recipe ID ${recipe.id}`);
    ids.add(recipe.id);
  }
  if (recipes.length === 0) throw new Error(`${input} contains no recipes`);
  return recipes;
}

function recipeMarkdown(recipe: Recipe): { markdown: string; metadata: string } {
  const summary = recipeSummarySchema.parse({
    id: recipe.id,
    title: recipe.title,
    description: recipe.description,
    category: recipe.category,
    cooking_minutes: recipe.cooking_minutes,
    source_url: recipe.source_url,
    image_url: recipe.image_url,
  });
  const metadata = JSON.stringify(summary);
  const metadataBytes = new TextEncoder().encode(metadata).byteLength;
  if (metadataBytes > MAX_RECIPE_METADATA_BYTES) {
    throw new Error(
      `Recipe ${recipe.id} metadata is ${metadataBytes} UTF-8 bytes; maximum is ${MAX_RECIPE_METADATA_BYTES}`,
    );
  }
  const lines = [
    `# ${recipe.title}`,
    "",
    `Recipe ID: ${recipe.id}`,
    "",
    "## Description",
    recipe.description,
    "",
    "## Aliases",
  ];
  lines.push(
    ...(recipe.aliases.length > 0 ? recipe.aliases.map((alias) => `- ${alias}`) : ["[]"]),
    "",
  );
  lines.push(
    "## Categories",
    ...(recipe.category.length > 0 ? recipe.category.map((category) => `- ${category}`) : ["[]"]),
    "",
  );
  lines.push(
    "## Heating time",
    recipe.cooking_minutes === null ? "null" : `${recipe.cooking_minutes}分`,
    "",
  );
  lines.push("## Image", recipe.image_url ?? "null", "");
  lines.push(
    "## Ingredients",
    ...(recipe.ingredients.length > 0
      ? recipe.ingredients.map((ingredient) => `- ${ingredient}`)
      : ["[]"]),
    "",
  );
  lines.push(
    "## Procedure",
    ...(recipe.procedure.length > 0
      ? recipe.procedure.map((step, index) => `${index + 1}. ${step}`)
      : ["[]"]),
    "",
  );
  lines.push("## Source", recipe.source_url, "");
  return { markdown: lines.join("\n"), metadata };
}

function recipeVersion(
  recipe: Recipe,
  markdown: string,
  metadata: string,
): { key: string; version: string } {
  const version = createHash("sha256").update(markdown).update("\0").update(metadata).digest("hex");
  return { key: `er-wd7000-${recipe.id}-${version}.md`, version };
}

async function findBuiltinRecipeVersion(
  config: CloudflareConfig,
  key: string,
): Promise<RecipeVersion | null> {
  const query = new URLSearchParams({ key, source: "builtin" });
  const response = await cloudflareRequest<SearchItem[]>(
    config,
    `namespaces/${encodeURIComponent(config.namespace)}/instances/${encodeURIComponent(config.instance)}/items?${query}`,
  );
  if (!Array.isArray(response.result)) {
    throw new Error(`Cloudflare exact item lookup returned no results array for ${key}`);
  }
  if (response.result.length > 1) {
    throw new Error(`Cloudflare exact item lookup returned multiple builtin items for ${key}`);
  }
  const item = response.result[0];
  if (!item) return null;
  return requireMatchingRecipeVersion(
    item,
    key,
    item.status === "queued" || item.status === "running",
  );
}

async function listRecipeVersions(
  config: CloudflareConfig,
  recipeId: string,
): Promise<RecipeVersion[]> {
  const items: SearchItem[] = [];
  let page = 1;
  let totalCount = Infinity;
  while (items.length < totalCount) {
    const query = new URLSearchParams({
      source: "builtin",
      search: `er-wd7000-${recipeId}-`,
      per_page: "50",
      page: String(page),
    });
    const response = await cloudflareRequest<SearchItem[]>(
      config,
      `namespaces/${encodeURIComponent(config.namespace)}/instances/${encodeURIComponent(config.instance)}/items?${query}`,
    );
    if (!Array.isArray(response.result) || !response.result_info) {
      throw new Error(
        `Cloudflare version listing returned no pagination information for recipe ${recipeId}`,
      );
    }
    const previousLength = items.length;
    items.push(...response.result);
    totalCount = response.result_info.total_count;
    if (
      !Number.isSafeInteger(totalCount) ||
      totalCount < 0 ||
      (items.length === previousLength && items.length < totalCount)
    ) {
      throw new Error(`Cloudflare version listing did not advance for recipe ${recipeId}`);
    }
    page++;
  }
  return items
    .map(parseOwnedRecipeVersion)
    .filter((item): item is RecipeVersion => item !== null && item.recipeId === recipeId);
}

async function syncRecipe(
  config: CloudflareConfig,
  key: string,
  itemId: string,
  waitForCompletion: boolean,
): Promise<SearchItem> {
  const itemPath = `namespaces/${encodeURIComponent(config.namespace)}/instances/${encodeURIComponent(config.instance)}/items/${encodeURIComponent(itemId)}`;
  const response = await cloudflareRequest<SearchItem | null>(
    config,
    `namespaces/${encodeURIComponent(config.namespace)}/instances/${encodeURIComponent(config.instance)}/items`,
    {
      method: "PUT",
      contentType: "application/json",
      body: JSON.stringify({
        key,
        next_action: "INDEX",
        wait_for_completion: waitForCompletion,
      }),
    },
  );
  if (response.result !== null) return response.result;
  const item = await cloudflareRequest<SearchItem>(config, itemPath);
  return item.result;
}

function requireMatchingRecipeVersion(
  item: SearchItem,
  key: string,
  allowMissingMetadata = false,
): RecipeVersion {
  if (
    item.key !== key ||
    item.source_id !== "builtin" ||
    typeof item.id !== "string" ||
    item.id.length === 0
  ) {
    throw new Error(
      `Cannot safely use builtin item ${key}: key, ID, or recipe metadata is invalid`,
    );
  }
  const version = parseOwnedRecipeVersion(item);
  if (version) return version;
  if (allowMissingMetadata && (item.metadata === null || item.metadata === undefined)) {
    const match = /^er-wd7000-(\d+)-([a-f0-9]{64})\.md$/u.exec(item.key);
    if (match) return { ...item, recipeId: match[1], version: match[2] };
  }
  throw new Error(`Cannot safely use builtin item ${key}: key, ID, or recipe metadata is invalid`);
}

function parseOwnedRecipeVersion(item: SearchItem): RecipeVersion | null {
  const match = /^er-wd7000-(\d+)-([a-f0-9]{64})\.md$/u.exec(item.key);
  if (!match || item.source_id !== "builtin" || typeof item.metadata?.recipe !== "string")
    return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(item.metadata.recipe);
  } catch {
    return null;
  }
  const summary = recipeSummarySchema.safeParse(metadata);
  if (!summary.success || summary.data.id !== match[1]) return null;
  return { ...item, recipeId: match[1], version: match[2] };
}

async function deletePreviousVersions(
  config: CloudflareConfig,
  recipeId: string,
  currentKey: string,
  versions: RecipeVersion[],
): Promise<void> {
  for (const item of versions) {
    if (item.recipeId !== recipeId || item.key === currentKey) continue;
    if (!item.id)
      throw new Error(
        `Cannot safely remove prior recipe item ${item.key}: missing Cloudflare item ID`,
      );
    await cloudflareRequest(
      config,
      `namespaces/${encodeURIComponent(config.namespace)}/instances/${encodeURIComponent(config.instance)}/items/${encodeURIComponent(item.id)}`,
      { method: "DELETE" },
    );
    console.log(`Removed superseded recipe version ${item.key}`);
  }
}

async function uploadRecipe(
  config: CloudflareConfig,
  key: string,
  markdown: string,
  metadata: string,
  waitForCompletion: boolean,
): Promise<SearchItem> {
  const form = new FormData();
  form.append("file", new Blob([markdown], { type: "text/markdown; charset=utf-8" }), key);
  form.append("metadata", JSON.stringify({ recipe: metadata }));
  form.append("wait_for_completion", String(waitForCompletion));
  const uploaded = await cloudflareRequest<SearchItem>(
    config,
    `namespaces/${encodeURIComponent(config.namespace)}/instances/${encodeURIComponent(config.instance)}/items`,
    { method: "POST", body: form },
  );
  return uploaded.result;
}

function logIndexStatus(key: string, item: SearchItem, warnings?: unknown[]): void {
  const status = item.status ?? "unknown";
  const detail = item.error ? `: ${item.error}` : "";
  console.log(`${key}: ${status}${detail}`);
  if (warnings && warnings.length > 0) console.warn(`${key}: warnings ${JSON.stringify(warnings)}`);
}

async function indexRecipes(
  input: string,
  limit?: number,
  waitForCompletion = false,
): Promise<void> {
  const config = searchConfig();
  const allRecipes = await readRecipes(input);
  const recipes = limit === undefined ? allRecipes : allRecipes.slice(0, limit);
  if (limit !== undefined)
    console.log(
      `SMOKE SCOPE ONLY: indexing ${recipes.length} of ${allRecipes.length} saved recipes`,
    );
  else console.log(`Indexing all ${recipes.length} saved Toshiba recipes`);

  for (let index = 0; index < recipes.length; index++) {
    const recipe = recipes[index];
    const { markdown, metadata } = recipeMarkdown(recipe);
    const { key, version } = recipeVersion(recipe, markdown, metadata);
    const current = await findBuiltinRecipeVersion(config, key);
    if (current) {
      logIndexStatus(key, current);
      if (current.status === "error" || (current.status === "queued" && waitForCompletion)) {
        const priorVersions = await listRecipeVersions(config, recipe.id);
        const replacement = priorVersions.some((item) => item.key !== key);
        const synced = await syncRecipe(
          config,
          current.key,
          current.id,
          waitForCompletion || replacement,
        );
        logIndexStatus(key, synced, (synced as SearchItem & { warnings?: unknown[] }).warnings);
        const resumed = requireMatchingRecipeVersion(synced, key, true);
        if (resumed.id !== current.id) {
          throw new Error(
            `Cloudflare returned a different item ID while resyncing recipe ${recipe.id}`,
          );
        }
        if (
          synced.status === "error" ||
          synced.status === "skipped" ||
          synced.status === "outdated"
        ) {
          throw new Error(
            `Recipe ${recipe.id} resync returned status ${synced.status}; prior indexed versions were retained`,
          );
        }
        if (synced.status === "completed") {
          await deletePreviousVersions(config, recipe.id, key, priorVersions);
        } else if (replacement) {
          console.warn(
            `Recipe ${recipe.id} resync is ${synced.status ?? "unknown"}; prior indexed versions remain until the current version completes`,
          );
        }
        console.log(`[${index + 1}/${recipes.length}] ${recipe.id} resynced`);
        continue;
      }
      if (current.status === "skipped" || current.status === "outdated") {
        throw new Error(
          `Recipe ${recipe.id} already has a ${current.status} item; prior indexed versions were retained`,
        );
      }
      if (current.status !== "completed") {
        console.warn(
          `Recipe ${recipe.id} is not ready yet (status=${current.status ?? "unknown"})`,
        );
      } else {
        const priorVersions = await listRecipeVersions(config, recipe.id);
        await deletePreviousVersions(config, recipe.id, key, priorVersions);
      }
      console.log(
        `[${index + 1}/${recipes.length}] ${recipe.id} unchanged (version ${version.slice(0, 12)})`,
      );
      continue;
    }

    const priorVersions = await listRecipeVersions(config, recipe.id);
    const replacement = priorVersions.some((item) => item.key !== key);
    const shouldWait = waitForCompletion || replacement;
    const uploaded = await uploadRecipe(config, key, markdown, metadata, shouldWait);
    logIndexStatus(key, uploaded, (uploaded as SearchItem & { warnings?: unknown[] }).warnings);
    if (
      uploaded.status === "error" ||
      uploaded.status === "skipped" ||
      uploaded.status === "outdated"
    ) {
      throw new Error(
        `Recipe ${recipe.id} indexing failed with status ${uploaded.status}; previous versions were retained`,
      );
    }
    if (replacement && uploaded.status === "completed") {
      await deletePreviousVersions(config, recipe.id, key, priorVersions);
    } else if (replacement) {
      console.warn(
        `Recipe ${recipe.id} replacement is ${uploaded.status ?? "unknown"}; prior indexed versions remain until the new version completes`,
      );
    } else if (uploaded.status !== "completed") {
      console.warn(
        `Recipe ${recipe.id} uploaded but not yet indexed (status=${uploaded.status ?? "unknown"})`,
      );
    }
    console.log(`[${index + 1}/${recipes.length}] ${recipe.id} uploaded`);
  }
}

function parseArguments(args: string[]): CliOptions {
  const command = args[0];
  if (command !== "setup" && command !== "scrape" && command !== "index") {
    throw new Error(
      "Usage: bun scripts/recipes.ts <setup|scrape|index> [--limit N] [--output PATH] [--wait]",
    );
  }
  let output = DEFAULT_OUTPUT;
  let limit: number | undefined;
  let wait = false;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--limit") {
      limit = parseLimit(args[++index]);
      if (limit === undefined) throw new Error("--limit requires a positive integer");
    } else if (argument === "--output") {
      const value = args[++index];
      if (!value) throw new Error("--output requires a file path");
      output = value;
    } else if (argument === "--wait") {
      wait = true;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  if (command === "setup" && args.length > 1) throw new Error("setup does not accept options");
  if (command === "scrape" && wait) throw new Error("scrape does not accept --wait");
  return { command, output, limit, wait };
}

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === "setup") await setupSearch();
  else if (options.command === "scrape") await scrapeRecipes(options.output, options.limit);
  else await indexRecipes(options.output, options.limit, options.wait);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
