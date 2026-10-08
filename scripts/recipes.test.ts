import { expect, test } from "bun:test";
import { parseHeatingMinutes, parseRecipeDetail } from "./recipes";

const detailWithIngredientTabs = `
<main>
  <div class="lytRecipe5">
    <div class="item">
      <h1 class="headH2"><span class="text"><span class="icon"><img alt="野菜"></span>根菜のオーブン焼き</span></h1>
      <p>野菜を焼きます。</p>
    </div>
    <div class="item"><div class="image"><img src="/jp/microwaves/recipes/sites/recipesite/files/root.jpg" alt="根菜"></div></div>
    <div class="item">
      <div class="listRecipe4">
        <dl><dt>メニュー</dt><dd>石窯おまかせ焼き 野菜</dd></dl>
        <dl><dt>調理時間の目安</dt><dd>加熱約130分</dd></dl>
        <dl><dt>手動加熱の設定</dt><dd>オーブン180℃ 38～43分</dd></dl>
      </div>
    </div>
  </div>
  <div id="anchor-1">
    <ul class="tabList js-tab-list">
      <li><button class="js-tab-button">2人分</button></li>
      <li><button class="js-tab-button">4人分</button></li>
    </ul>
    <div class="js-panel-item">
      <div class="inner">
        <h3 class="headH4"><span class="text">A</span></h3>
        <ul class="lytRecipe4"><li><span class="label">玉ねぎ</span><span class="quantity">100g</span></li><li>&nbsp;</li></ul>
        <h3 class="headH4"><span class="text">B</span></h3>
        <ul class="lytRecipe4"><li><span class="label">塩</span><span class="quantity">小さじ1・1/2</span></li></ul>
      </div>
    </div>
    <div class="js-panel-item">
      <div class="inner"><ul class="lytRecipe4"><li><span class="label">玉ねぎ</span><span class="quantity">200g</span></li><li><span class="label">スライスチーズ</span>1枚</li><li><strong>イタリアンパセリ</strong>適宜</li></ul></div>
    </div>
  </div>
  <h2 class="headH3">下準備</h2>
  <div class="lytRecipe2"><div class="item"><div class="content"><p>玉ねぎを切る。</p></div></div></div>
  <h2 class="headH3" id="anchor-2">作りかた</h2>
  <ol class="lytRecipe3">
    <li><div class="mark"><span>1</span></div><div class="content"><p><strong>生地づくり</strong></p><p>材料を混ぜる。</p></div></li>
    <li><div class="mark"><span>2</span></div><div class="content"><p>焼く。<br>途中で返す。</p></div></li>
  </ol>
  <h2 class="headH3">ポイント</h2>
  <div class="lytRecipe2"><div class="item"><div class="content"><p>焼き色を確認する。</p></div></div></div>
</main>`;

test("keeps ingredient variants and source procedure sections distinct", () => {
  const recipe = parseRecipeDetail(detailWithIngredientTabs, "1522");

  expect(recipe.ingredients).toEqual([
    "2人分: A: 玉ねぎ 100g",
    "2人分: B: 塩 小さじ1・1/2",
    "4人分: 玉ねぎ 200g",
    "4人分: スライスチーズ 1枚",
    "4人分: イタリアンパセリ適宜",
  ]);
  expect(recipe.procedure).toEqual([
    "下準備: 玉ねぎを切る。",
    "1. 生地づくり\n材料を混ぜる。",
    "2. 焼く。\n途中で返す。",
    "ポイント: 焼き色を確認する。",
  ]);
  expect(recipe.category).toEqual(["野菜", "石窯おまかせ焼き 野菜"]);
  expect(recipe.cooking_minutes).toBe(130);
  expect(recipe.image_url).toBe(
    "https://www.toshiba-lifestyle.com/jp/microwaves/recipes/sites/recipesite/files/root.jpg",
  );
});

test("keeps an absent description empty instead of collecting title text", () => {
  const html = detailWithIngredientTabs.replace("<p>野菜を焼きます。</p>", "");
  expect(parseRecipeDetail(html, "1522").description).toBe("");
});

test("reads only declared heating time, not manual oven settings", () => {
  expect(parseHeatingMinutes("加熱約1時間30分")).toBe(90);
  expect(parseHeatingMinutes("加熱約130分")).toBe(130);
  expect(parseHeatingMinutes("予熱約8分+加熱約23分")).toBe(23);
  expect(parseHeatingMinutes("オーブン180℃ 38～43分")).toBeNull();
});
