# zero-owner

0円物件を掲載サイトから集めて、**衛星写真の地図**に表示するサイト。
公開しているのは GitHub Pages の静的サイトで、同じものを `server.ts` でも配信できる。

| 取得元 | 対象 |
| --- | --- |
| [みんなの0円物件](https://zero.estate/) | 掲載されている全物件（**承諾待ちのため取得・掲載とも停止中**） |
| [フィールドマッチング](https://fieldmatching.klc1809.com/) | 売買価格が `FM_MAX_PRICE`（既定1円）以下の物件 |
| [負動産の掲示板](https://souzokutochi-kokkokizoku.com/deflug/) | 募集中・商談中・成約済みの全物件 |
| [NISUMEL](https://ichi-estate.com/) | 掲載物件（サンプル投稿は除く） |
| [家いちば](https://ieichiba.com/) | 価格が `IE_MAX_PRICE`（既定0円）以下の物件 |
| [全国０円不動産](https://zenkokuzeroen-fudosan.com/) | 地域ページに載っている全物件 |

> **みんなの0円物件（zero.estate）だけ停止中。** 収集・掲載の承諾を照会中のため、
> CI では取得せず、公開している地図にも載せていない。詳しくは「利用条件」を参照。

## 構成

```text
app.ts            CLI。取得・住所検索・生成を呼び分けるだけ
build.ts          取得 → 住所検索 → map.json。ステータスと地方もここで揃える
server.ts         配信と定期ビルド (Bun.serve + Bun.cron)。手元でも自宅鯖でも同じもの
sources/          取得元ごとの実装（1ファイル1サイト）
  index.ts          取得元の一覧。ここに足せば全部の処理に乗る
  common.ts         名乗り・待ち・生データの置き場・住所と価格の読み方
  zero-estate.ts    みんなの0円物件
  fieldmatching.ts  フィールドマッチング
  makedosan.ts      負動産の掲示板
  nisumel.ts        NISUMEL
  ieichiba.ts       家いちば
  zenkokuzeroen.ts  全国０円不動産
geocode.ts        座標が無い物件を住所から引く（国土地理院API）
types.ts          地図が読む共通の物件型
index.html        地図ページ
src/main.ts       MapLibre GL の地図・絞り込み・一覧（TypeScript）
build-web.ts      src/ を assets/ に書き出す
assets/styles.css 見た目（ここは手書き）
assets/main.js    生成物。maplibre-gl.* も生成時に置かれる
Dockerfile        実行イメージ。node_modules は入らない（実行時の依存が無いため）
compose.yml       ローカル実行。認証情報は compose.override.yml で上書きする
k3s/              自宅クラスタ用のマニフェスト（未適用）
data/             生成物。すべて Git 管理外
  map.json          地図が読む軽量データ
  <取得元>.json     取得元ごとの生データ
  geocode-cache.json 住所検索の結果
```

`data/` は丸ごと生成物なので、消しても `bun app.ts` で作り直せる
（住所検索のキャッシュも消えるため、その分だけ国土地理院APIを引き直す）。
公開時は `data/map.json` をサイト直下の `/map.json` として配る。

## 使い方

```bash
bun app.ts              # 取得 → 住所検索 → map.json
bun app.ts fetch        # すべての取得元から取得する
bun app.ts fetch fm     # 1つの取得元だけ（zero / fm / md / ni / ie / zz）
bun app.ts geocode      # 座標が無い物件の住所を国土地理院APIで引く
bun app.ts json         # 生データから map.json を作る
bun run build:web       # src/main.ts を assets/ に書き出す
bun run dev             # フロントをビルドして http://localhost:5173/ で確認
bun run start           # 配信のみ (BUILD_CRON を入れると定期ビルドも走る)
bunx biome check .      # TS / CSS / HTML の書式と lint
bun run typecheck       # 型
```

取得元を足すときは `sources/` にファイルを1つ作り、`sources/index.ts` の
`SOURCES` に並べる。取得・住所検索・`map.json` への合流はそれだけで通る。

### 環境変数

| 変数 | 意味 |
| --- | --- |
| `EMAIL` / `PASSWORD` | zero.estate のログイン情報（zero.estate の取得に必須） |
| `FM_MAX_PRICE` | フィールドマッチングで地図に載せる価格の上限。既定 `1`（円） |
| `IE_MAX_PRICE` | 家いちばで地図に載せる価格の上限。既定 `0`（円） |
| `FETCH_DELAY_MS` | 取得の間隔。既定 `700`（ミリ秒） |
| `GEOCODE_DELAY_MS` | 住所検索の間隔。既定 `500`（ミリ秒） |
| `HTTPS_PROXY` | 負動産の掲示板・NISUMEL の取得だけに使う。下記参照 |
| `PORT` | 配信するポート。既定 `5173` |
| `BUILD_CRON` | 定期ビルドの時刻（例 `0 9 * * *`）。空なら定期ビルドをしない |
| `TZ` | `BUILD_CRON` を読む時間帯。既定 `Asia/Tokyo` |

ローカルでは `compose.override.yml` に書く（Git 管理外）。

```bash
cp compose.override.yml.example compose.override.yml   # 値を書き換えて使う
docker compose up --build                              # http://localhost:5173/
```

CI ではリポジトリの **Settings → Secrets and variables → Actions** に同名で登録する。

## 地図

描画は **MapLibre GL JS**（WebGL）。ラスタタイルも点も GPU で描くので、
DOM でタイルを動かす方式（Leaflet）よりパンが軽い。WebGL2 が必要なので、
使えない環境では地図の代わりにその旨を表示する。

maplibre-gl はバンドルに含めず、`dist` の `.mjs` をそのまま `assets/` に置いて
`importmap` で解決している。まとめても得にならないため。描画は Web Worker と
共通コード（`maplibre-gl-shared.mjs`）を分け合っていて、自前でバンドルすると
主スレッド側の 254KB (gzip) に加えて worker 用の chunk を別に配ることになる。
dist のまま置けば主スレッドと worker が同じ chunk を使うので合計 281KB (gzip)。
CDN は使っていない。

- 背景は **衛星写真**（既定: Esri World Imagery、切替で国土地理院シームレス空中写真・淡色地図）
- 地名ラベルを重ねて表示（右下のレイヤコントロールで切替）
- ステータスは取得元をまたいで揃えている（フィールドマッチングの「公開中」は
  他サイトの「募集中」、「交渉中」は負動産の掲示板の「商談中」にあたる）
- 地方は都道府県から引いている。掲載側の値は使わない（zero.estate は持っているが、
  同じ県が「中部」だったり「東海」だったりと揃っていない）
- マーカーはステータス別の色。近い物件はクラスタにまとめ、ズームすると開く
  （クラスタの件数表示にだけ [MapLibre 配布のフォント](https://demotiles.maplibre.org/) を使う）
- 物件名・住所の検索、ステータス / 種別 / 地方 / 都道府県 / 特記事項での絞り込み、
  新着・閲覧数・お気に入り順の並べ替え、「地図に写っている物件だけ一覧に出す」表示
- 絞り込み条件は URL のハッシュに入るので、そのまま共有できる
- 掲載側に座標が無い物件は、住所から国土地理院の住所検索APIで引いて表示する。
  推定した場合はポップアップに一致した住所を出す。
  負動産の掲示板は番地を公開していないため、全件が大字までの推定になる
- 物件のポップアップと一覧には取得元を表示する

## 国内プロキシ

負動産の掲示板と NISUMEL は、どちらも日本のレンタルサーバで動く WordPress で、
**海外IPからの `wp-json` へのアクセスを 403 で弾く**。GitHub Actions の Runner は
海外IPなので、この2つだけ国内のプロキシを経由させる必要がある
（User-Agent は無関係。手元の日本のIPからは同じUAで 200 が返る）。

`HTTPS_PROXY` に `https://ユーザー:パスワード@ホスト名` を Secret で設定すると、
該当2ステップだけがそのプロキシを通る。Bun の `fetch` は `https://` 形式の
プロキシと Basic 認証の両方に対応している。

プロキシ側の構成は [`danything/k3s-gitops`](https://github.com/danything/k3s-gitops) の
`3proxy/` にある。宛先ACLでこの2ドメインへの CONNECT だけを許可しているので、
認証情報が漏れても踏み台にはならない。

## 自宅クラスタへの移行（未適用）

[`k3s/`](k3s/) にマニフェストを置いてある。配信も定期ビルドも `server.ts` の
1プロセスなので、Deployment ひとつと、取得結果を残す PVC だけ。イメージは
`.github/workflows/docker-publish.yml` が ghcr に push したものを使う。
`danything` 配下のリポジトリは `k3s/argocd.yaml` が ApplicationSet に拾われて
デプロイされるので、**移管しない限り適用されない**（イメージ名もリポジトリ名に
追従するので、移管・改名が済むまで `k3s/deployment.yaml` の参照先は存在しない）。

移行するとビルドも国内IPから走るので、負動産の掲示板と NISUMEL の 403 を
踏まなくなり、3proxy を経由する必要がなくなる。

切り替えの順序に注意。`y.doany.io` を自宅に向け直して Pages 側の独自ドメインを
外すと、`5ym.github.io/zero-owner/` からのリダイレクトが消える。この URL は
アキソルへの依頼文に書いてあるので、回答が来るまで切り替えない。

## 利用条件

取得元ごとに規約を確認した結果。

| 取得元 | 収集 | 転載・公開 |
| --- | --- | --- |
| みんなの0円物件 | 第6条9号で**事前の承諾が必要** | 第9条2項で**事前の書面による承諾が必要** |
| フィールドマッチング | 明文の禁止なし（第13条は包括条項のみ） | 明文の禁止なし（第15条は自社制作物に限定） |
| 負動産の掲示板 | **利用規約が存在しない** | 同左（無断転載禁止の明示も無い） |
| NISUMEL | **利用規約が存在しない** | 同左 |
| 家いちば | **利用規約が存在しない** | 同左 |
| 全国０円不動産 | 記述なし | サイトポリシーが**出所明示による転載を明示的に許可** |

みんなの0円物件は `robots.txt` に `Disallow: /api/` もあり、承諾の回答が出るまで
**CI では取得しない**（`data/zero-estate.json` を作らなければ `map.json` にも入らない）。
手元で `bun app.ts fetch zero` を実行すれば取得できるが、公開する成果物には載せないこと。

規約が無いことは許諾を意味しないので、みんなの0円物件以外にも順次一報を入れる。

[アキソル](https://akisol.jp/zero-bukken)（422件）は規約第12条8号・10号と第13条で
「当社の許可なく」の開示・公開・二次利用が禁じられている。条件付き禁止なので許可を
照会中。**回答が来るまで1リクエストも取得しない。**

## 注意

掲載内容・ステータスは各掲載元の公式ページで必ず確認すること。
収集は 1 日 1 回。実行頻度を上げすぎないこと。
