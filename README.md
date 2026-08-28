# yuzuriha

0円物件を掲載サイトから集めて、**衛星写真の地図**に表示するサイト。サイト名は**譲葉**。
自宅クラスタ（[`k3s/`](k3s/)）に `server.ts` を常時デプロイしてあり、そこが配信する。
以前は GitHub Pages の静的サイトとしても同じものを配っていたが、そちらを最新に
保っていた GitHub Actions は削除済みで、もう更新されない。

| 取得元 | 対象 |
| --- | --- |
| [フィールドマッチング](https://fieldmatching.klc1809.com/) | 売買価格が `FM_MAX_PRICE`（既定1円）以下の物件 |
| [負動産の掲示板](https://souzokutochi-kokkokizoku.com/deflug/) | 募集中・商談中・成約済みの全物件 |
| [NISUMEL](https://ichi-estate.com/) | 掲載物件（サンプル投稿は除く） |
| [家いちば](https://ieichiba.com/) | 価格が `IE_MAX_PRICE`（既定0円）以下の物件 |
| [全国０円不動産](https://zenkokuzeroen-fudosan.com/) | 地域ページに載っている全物件 |

> **みんなの0円物件（zero.estate）は取得しない。** 収集・掲載を照会したところ
> 2026年8月に不承諾の回答を受けたため、取得コードごと外した。詳しくは「利用条件」を参照。

## 構成

```text
app.ts            CLI。取得・住所検索・生成を呼び分けるだけ
build.ts          取得 → 住所検索 → map.json。ステータスと地方もここで揃える
server.ts         配信と定期ビルド (Bun.serve + Bun.cron)。手元でも自宅鯖でも同じもの
sources/          取得元ごとの実装（1ファイル1サイト）
  index.ts          取得元の一覧。ここに足せば全部の処理に乗る
  common.ts         名乗り・待ち・生データの置き場・住所と価格の読み方
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
assets/favicon.svg, assets/apple-touch-icon.png  アイコン（手書き）
assets/main.js    生成物。maplibre-gl.* も生成時に置かれる
Dockerfile        実行イメージ。node_modules は入らない（実行時の依存が無いため）
compose.yml       ローカル実行。認証情報は compose.override.yml で上書きする
k3s/              自宅クラスタ用のマニフェスト。ArgoCD が追従してデプロイする
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
bun app.ts fetch fm     # 1つの取得元だけ（fm / md / ni / ie / zz）
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
| `FM_MAX_PRICE` | フィールドマッチングで地図に載せる価格の上限。既定 `1`（円） |
| `IE_MAX_PRICE` | 家いちばで地図に載せる価格の上限。既定 `0`（円） |
| `FETCH_DELAY_MS` | 取得の間隔。既定 `700`（ミリ秒） |
| `GEOCODE_DELAY_MS` | 住所検索の間隔。既定 `500`（ミリ秒） |
| `HTTPS_PROXY` | 海外IPから負動産の掲示板・NISUMEL を取得する際に迂回させる。プロセス全体の `fetch` に掛かる。下記参照 |
| `PORT` | 配信するポート。既定 `5173` |
| `BUILD_CRON` | 定期ビルドの時刻（例 `0 9 * * *`）。空なら定期ビルドをしない |
| `TZ` | `BUILD_CRON` を読む時間帯。既定 `Asia/Tokyo` |

ローカルでは `compose.override.yml` に書く（Git 管理外）。

```bash
cp compose.override.yml.example compose.override.yml   # 値を書き換えて使う
docker compose up --build                              # https://yuzuriha.localhost/
```

コンテナはポートを公開せず、[danything/genkan](https://github.com/danything/genkan)
（caddy-docker-proxy）にホスト名で振り分けてもらう。先に genkan を起動しておくこと。

```bash
curl -sf https://raw.githubusercontent.com/danything/genkan/main/init.sh | sh -s
```

`bun run dev` で直に動かす場合は `http://localhost:5173/`。

自宅クラスタでは [`k3s/deployment.yaml`](k3s/deployment.yaml) に直接書く。
イメージのビルド自体（`.github/workflows/docker-publish.yml`）はこれらの変数を
読まないので、GitHub Actions の Secrets には登録していない。

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
**海外IPからの `wp-json` へのアクセスを 403 で弾く**
（User-Agent は無関係。手元の日本のIPからは同じUAで 200 が返る）。

自宅クラスタは日本のIPから動くので、本番の定期ビルドはこの 403 を踏まない。
海外から `bun app.ts fetch` などを直接叩く場合だけ、`HTTPS_PROXY` に
`https://ユーザー:パスワード@ホスト名` を設定すると迂回できる。Bun の `fetch` は
`https://` 形式のプロキシと Basic 認証の両方に対応している。

（かつては GitHub Actions の定期ビルドが海外IPの Runner から動いていたため、
負動産の掲示板と NISUMEL の取得ステップだけこのプロキシを経由させていた。
そのワークフローは自宅クラスタへの移行にともなって削除済み。）

プロキシ側の構成は [`danything/k3s-gitops`](https://github.com/danything/k3s-gitops) の
`3proxy/` にある。宛先ACLでこの2ドメインへの CONNECT だけを許可しているので、
認証情報が漏れても踏み台にはならない。

## 自宅クラスタでの運用

[`k3s/`](k3s/) にマニフェストを置いてある。配信も定期ビルドも `server.ts` の
1プロセスなので、Deployment ひとつと、取得結果を残す PVC だけ。`danything`
配下のリポジトリは `k3s/argocd.yaml` が ApplicationSet に拾われて自動デプロイ
される。イメージは [`docker-publish.yml`](.github/workflows/docker-publish.yml)
が `main` への push のたびに ghcr へ push し、同じジョブが
`k3s/deployment.yaml` のタグをそのビルドの sha に書き換えて `main` に直接
コミットする。ArgoCD はそのタグの変化を差分として検知して自動でロールアウト
するので、手動で `kubectl rollout restart` する必要はない。

`y.doany.io` は現時点では GitHub Pages に CNAME している。自宅に向け直して
Pages 側の独自ドメインを外すと、`5ym.github.io/zero-owner/` からのリダイレクトが
消える。このURLをアキソルへの照会文に書いていたため切り替えを保留していたが、
両社とも回答済みなので、いつ切り替えてもよい。

## 利用条件

取得元ごとに規約を確認した結果。

| 取得元 | 収集 | 転載・公開 |
| --- | --- | --- |
| フィールドマッチング | 明文の禁止なし（第13条は包括条項のみ） | 明文の禁止なし（第15条は自社制作物に限定） |
| 負動産の掲示板 | **利用規約が存在しない** | 同左（無断転載禁止の明示も無い） |
| NISUMEL | **利用規約が存在しない** | 同左 |
| 家いちば | **利用規約が存在しない** | 同左 |
| 全国０円不動産 | 記述なし | サイトポリシーが**出所明示による転載を明示的に許可** |

**みんなの0円物件（zero.estate）は不承諾。** 第6条9号・第9条2項に基づいて収集と掲載の
承諾を照会したところ、2026年8月に承諾しかねる旨の回答を受けた。理由は、0円物件を探し
地域や条件から発見する体験そのものが同社のサービス価値であり、非営利か否か・送客の
有無にかかわらず、外部サービスでの再構成と一般公開は許諾していない、というもの。
`/api/trpc/property.list` を含む内部 API についても自動取得・蓄積を控えるよう求められた。

これを受けて **取得コード（`sources/zero-estate.ts`）ごと削除し、手元に残っていた
生データと、そこから引いた住所検索の結果も破棄した。** 再取得しないこと。

規約が無いことは許諾を意味しないので、残りの取得元にも順次一報を入れる。

[アキソル](https://akisol.jp/zero-bukken)（422件）は規約第12条8号・10号と第13条で
「当社の許可なく」の開示・公開・二次利用が禁じられている。許可を照会したところ、
2026年8月に辞退の回答を受けた（第三者サイトへの掲載には所有者ごとの許諾が要るが、
その対応も個別の可否判断も行っていない、とのこと）。**取得しない。実装もしない。**
照会から回答までの間も含め、1リクエストも送っていない。

## 注意

掲載内容・ステータスは各掲載元の公式ページで必ず確認すること。
収集は 1 日 1 回。実行頻度を上げすぎないこと。
