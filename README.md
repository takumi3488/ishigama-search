# ishigama-search

東芝 ER-WD7000の公式レシピカタログを検索するアプリ。フロントエンドにSolidJS、WorkerにHono、APIに型付きのoRPCを使う。レシピはCloudflare AI Searchの組み込みストレージに登録し、別のデータベースや旧AutoRAG APIは使わない。

## 設定と起動

ローカルコマンド用に、Gitの対象外となる`packages/infra/.env`を作成する。

```dotenv
CLOUDFLARE_ACCOUNT_ID=<32-character-account-id>
CLOUDFLARE_API_TOKEN=<secret-token>
AI_SEARCH_NAMESPACE=ishigama-recipes
AI_SEARCH_INSTANCE=er_wd7000
CORS_ORIGIN=http://localhost:3001
```

`CLOUDFLARE_API_TOKEN`は秘密情報であり、`VITE_*`などのWeb公開用変数に含めない。`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`があればAlchemyが直接認証するため、Alchemyのプロファイルは不要。

ローカル開発以外では、`CORS_ORIGIN`にデプロイ済みWebアプリのオリジンを完全一致で設定する。

`AI_SEARCH_NAMESPACE`の既定値は`ishigama-recipes`、`AI_SEARCH_INSTANCE`の既定値は`er_wd7000`。どちらかを変更する場合は、セットアップ、インデックス作成、Workerのデプロイ、ローカル開発で同じ名前空間とインスタンス名を使う。Workerにはネイティブの`AI_SEARCH`名前空間バインディングとインスタンス名を渡し、REST APIトークンは渡さない。このアプリが公開するのは検索処理だけだが、名前空間バインディング自体は管理操作にも対応する。

```bash
bun install
bun run --env-file packages/infra/.env dev
bun run --env-file packages/infra/.env deploy
```

既存のAlchemyスタックでは、サーバーはポート3000、Webアプリはポート3001で動く。`bun run dev:server`もスタック全体を起動するため、サーバーだけを起動するコマンドではない。Alchemyの出力に、取込に使うAI Searchの名前空間名とインスタンス名が表示される。

`dev_admin`のデプロイ先は次のとおり。

- [Webアプリ（ライトテーマ）](https://ishigama-search-web-dev-admin-hm365fjffzgrplss.takumi3488.workers.dev/)
- [API](https://ishigama-search-server-dev-admin-5ow4bwhxj7knsmw4.takumi3488.workers.dev/)

このデプロイ先を更新するときは、`CORS_ORIGIN`に上記Webアプリのオリジンを完全一致で設定する。新しいステージでは、まずデプロイしてWebアプリのURLを取得し、そのURLを`CORS_ORIGIN`に設定してから、サーバーの設定を再度デプロイする。

## レシピの取込

```bash
bun run --env-file packages/infra/.env recipes:setup
bun run --env-file packages/infra/.env recipes:scrape
bun run --env-file packages/infra/.env recipes:index
```

- `recipes:setup`は設定済みの名前空間を作成または再利用し、その組み込みストレージ用インスタンスを作成または更新する。ベクトル検索、キーワード検索、RRF融合、Qwen3 0.6Bの埋め込み、BGEによる再順位付け、レシピのメタデータフィールドを有効にする。外部ソースを設定したインスタンスの用途変更は拒否する。
- `recipes:scrape`は[ER-WD7000のレシピ一覧](https://www.toshiba-lifestyle.com/jp/microwaves/recipes/er_wd7000)全体から重複のない詳細ページへのリンクを見つけ、各レシピを取得して検証する。既定では見つけたリンクをすべて処理し、詳細ページへのリクエストの間に1秒の間隔を置く。取得または解析でエラーが起きた場合、記録を黙って飛ばさず終了する。
- `recipes:index`は正規化したレシピのMarkdownと、JSON文字列形式の要約をCloudflareの項目メタデータに登録する。既定のJSONLファイルは`data/recipes.jsonl`で、`/data/`はGitの対象外。

`--limit N`は範囲を絞った疎通確認に限って使う。`scrape`と`index`の両方で指定できるが、完全なカタログにはならない。`--output PATH`は`scrape`と`index`で使うJSONLファイルを指定する。

`index`は既定で非同期に実行され、項目の状態と警告を表示する。`recipes:index --wait`はCloudflareに対し、最大25秒のリクエスト枠内でインデックス作成を待つよう求めるが、項目の準備完了を保証しない。カタログ全件の取得が正常に完了した`scrape`の結果だけをインデックス登録する。

インデックスに登録する項目のキーには内容ハッシュを含めるため、内容が変わらないレコードは冪等に処理できる。アップロード前に、状態順の一覧には頼らず、決定的な内容キーを`GET items?key=<key>&source=builtin`で直接確認する。バックグラウンド処理で項目の状態が変わっている間も、この方法で確認できる。

再実行時に、そのキーに対応する管理対象項目が`error`状態なら、ネイティブItems APIの`PUT /items`で再同期を要求する。リクエストは`{"key":"<key>","next_action":"INDEX","wait_for_completion":...}`。この操作は項目のメタデータを置き換えずに再インデックスを要求するもので、すでに完了していることを意味しない。

内容を変更した場合も、新しい版の処理が正常に完了するまでは以前の正常な版を検索できる。ネイティブHTTPのアップロードが失敗した場合、コマンドは終了し、失敗を黙って再試行したり飛ばしたりしない。

Cloudflareの組み込みインデックスにはレシピ本文全体を保存する。`recipe`メタデータ文字列の上限は8 KiB。

コーパスやトークナイザーを変更する場合は、新しいAI Searchインスタンスを用意して、コーパス全件をそこへインデックス登録する。新しいインスタンスで全件のインデックス作成が正常に完了するまでは、既存インスタンスとそのデータを維持する。デプロイ先の`AI_SEARCH_INSTANCE`を切り替えるのは、その完了後にする。

## レシピデータと検索

正規化したレシピには次の項目がある。

| 項目              | 内容                         |
| ----------------- | ---------------------------- |
| `id`              | レシピID                     |
| `title`           | タイトル                     |
| `aliases`         | タイトルまたは表記の異なる形 |
| `ingredients`     | 材料                         |
| `description`     | 説明                         |
| `procedure`       | 手順                         |
| `category`        | カテゴリ                     |
| `cooking_minutes` | 加熱時間                     |
| `source_url`      | 参照元URL                    |
| `image_url`       | 画像URL                      |

材料の各行には元データの分量を残し、手順は元の順序を保つ。カテゴリには東芝の情報を使う。`cooking_minutes`は元データに記載された概算の加熱時間だけを表し、準備時間は含まない。`aliases`にはタイトルまたは表記の異なる形を登録し、創作した同義語は加えない。

検索にはWorkerのネイティブバインディング`AI_SEARCH.get(AI_SEARCH_INSTANCE)`を使う。BM25キーワード検索とベクトル検索をRRFで組み合わせ、`@cf/baai/bge-reranker-base`で結果を並べ替える。埋め込みには`@cf/qwen/qwen3-embedding-0.6b`を使う。

再順位付けの閾値は旧設定の0.4ではなく0にしており、スコアが正の候補を除外せずに並べ替える。

検証時の検索では、ネイティブ検索の候補50件すべてが0.4未満で、最大スコアは0.379557だった。これが以前の検索結果が空だった理由。

クエリの書き換えとキャッシュは無効にしている。

インデックスに登録するMarkdownには、タイトル、別名、説明、カテゴリ、加熱時間、材料、手順といったレシピ情報を含め、キーワードを分割して並べた一覧は含めない。

ネイティブAI SearchのtrigramトークナイザーでBM25の部分一致を行う。ベクトル検索と再順位付けには、NFKC正規化した元のクエリをそのまま使う。1〜2文字の語はtrigramによる字句一致がなく、ベクトル検索に依存する。完全一致だけを行う隠れた代替処理はない。

型付きoRPCのエンドポイントは`/rpc`、OpenAPIのルートは`GET /api-reference/recipes/search?query=<query>&limit=12`。

クエリはNFKC正規化し、空白をまとめて前後を除去したうえで、500文字までに制限する。`limit`の既定値は12で、1〜20を指定できる。レスポンスには正規化済みクエリと、スコア・抜粋を含む順位付きレシピ要約を返す。検索サービスが空または利用できない場合に、合成した検索結果は返さない。

## スクレーパーのコンテナ

ローカルでスクレーパーのイメージをビルドして実行する。

```bash
docker build -f Dockerfile.scraper -t ishigama-search-scraper:local .
docker run --rm \
  -v ishigama-recipes:/app/data \
  ishigama-search-scraper:local scrape --output /app/data/recipes.jsonl
```

名前付きボリュームを使うと、非rootの`bun`実行ユーザーが`/app/data`へ書き込める。カタログはイメージに含めない。全カタログを上書きしないよう、疎通確認では`scrape --limit 1 --output /app/data/recipes-smoke.jsonl`を使う。

`setup`と`index`には`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`が必要。`AI_SEARCH_NAMESPACE`と`AI_SEARCH_INSTANCE`はスタックと同じ値にする（既定値は`ishigama-recipes`と`er_wd7000`）。認証情報はイメージのビルド時には渡さず、実行時に渡す。

```bash
docker run --rm \
  -e CLOUDFLARE_ACCOUNT_ID \
  -e CLOUDFLARE_API_TOKEN \
  -e AI_SEARCH_NAMESPACE \
  -e AI_SEARCH_INSTANCE \
  -v ishigama-recipes:/app/data \
  ishigama-search-scraper:local setup
docker run --rm \
  -e CLOUDFLARE_ACCOUNT_ID \
  -e CLOUDFLARE_API_TOKEN \
  -e AI_SEARCH_NAMESPACE \
  -e AI_SEARCH_INSTANCE \
  -v ishigama-recipes:/app/data \
  ishigama-search-scraper:local index --output /app/data/recipes.jsonl
```

## CIとGitHubデプロイ

設定済みのリポジトリ変数は`ALCHEMY_STAGE=dev_admin`、`CORS_ORIGIN`（上記Webアプリのオリジン）、`CLOUDFLARE_ACCOUNT_ID`、`AI_SEARCH_NAMESPACE`、`AI_SEARCH_INSTANCE`。`CLOUDFLARE_API_TOKEN`もリポジトリシークレットに登録済み。

Alchemy v2の既存のネイティブCloudflare状態を使った検証では、`ALCHEMY_PASSWORD`は任意であり、不要だった。

CI用トークンにはCloudflareの次の4権限がある。

| API／Terraformの権限名 | Cloudflare画面での選択           |
| ---------------------- | -------------------------------- |
| Workers Scripts Write  | Account → Workers Scripts → Edit |
| AI Search Write        | Account → AI Search → Edit       |
| AI Search Run          | Account → AI Search → Run        |
| Secrets Store Write    | Account → Secrets Store → Edit   |

AI SearchのRead／Indexは追加不要。Editで管理操作、Runで検索実行を許可する。

対象を絞ったTerraformの適用ではリソースを1件追加し、変更0件、削除0件だった。トークンは標準入力経由で渡し、表示していない。

Terraformでの管理は[PR #266](https://github.com/takumi3488-private/terraforms/pull/266)で追跡しており、PRはTerraform CIに通過してレビュー待ち。今後、mainのCloudflare Terraform適用を行う前にこのPRをマージし、作成したトークンをmain側の設定でも管理できる状態にする。

GitHub Actionsは、プルリクエストとmainへのプッシュで整形、lint、テスト、型チェック、ビルドを品質ゲートとして実行する。ゲート通過後、mainへのプッシュでAlchemyのWebとサーバーのWorkerを`dev_admin`へデプロイし、`ghcr.io/takumi3488/ishigama-search-scraper`を`latest`、`main`、完全なコミットSHAのタグ付きで`linux/amd64`と`linux/arm64`向けに公開する。
デプロイは`--no-input --yes`で非対話実行するため、Turboのinteractiveタスクには設定しない。

ワークフローはmainに反映済み。ワークフローだけを登録した初回プッシュは`[skip ci]`で実行を省略し、アプリ変更はPRのCI通過後にsquash mergeする。

ローカルでは`actionlint`とCI相当の品質チェックが通り、トークンを使ったAlchemyのデプロイにも成功した。

## 確認済みの状態

東芝のレシピ一覧とローカルJSONLを直近に比較した結果、両方に重複のないレシピIDが998件あり、不足と余分はいずれも0件だった。その時点で、デプロイ済みインデックスの状態は`completed`が998件、`queued`が0件、`error`が0件だった。

直近の確認では、玉ねぎを含むレシピは表記違いを含めて230件だった。デプロイ先で`玉ねぎ`を検索した確認時には、APIの既定値である12件が返った。1回のAPIレスポンスで230件すべてが返るわけではない。

`linux/amd64`と`linux/arm64`の両方でOCIイメージのビルドとコンテナ内の`scrape`に成功しており、各環境でレシピ1522を材料6件・手順4件で取得した。

## 確認用コマンド

```bash
bun run fmt:check
bun run lint
bun run test
bun run check-types
bun run build
```

整形チェックでは`.claude/`と`.omp/`だけを対象外にし、アプリケーションのソースとCI設定は対象に含める。

## 参照先

- [東芝 ER-WD7000レシピ](https://www.toshiba-lifestyle.com/jp/microwaves/recipes/er_wd7000)
- [Cloudflare AI SearchのWorkers用バインディング](https://developers.cloudflare.com/ai-search/api/search/workers-binding/)
- [Cloudflare AI Searchの対応モデル](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/)
- [Cloudflare AI Search 項目API](https://developers.cloudflare.com/ai-search/api/items/rest-api/)
- [Cloudflareのキーワードインデックス作成](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/)
- [Cloudflareのメタデータ上限](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/)
