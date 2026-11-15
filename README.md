# yuzuriha

0円物件を掲載サイトから集めて、**衛星写真の地図**に表示するサイト。サイト名は**譲葉**。
自宅クラスタ（[`deploy/`](deploy/)）に `server.ts` を常時デプロイしてあり、そこが配信する。
以前は GitHub Pages の静的サイトとしても同じものを配っていたが、DNSを自宅に
切り替えた上で Pages 側は削除済み。

| 取得元                                                         | 対象                                           |
| -------------------------------------------------------------- | ---------------------------------------------- |
| [フィールドマッチング](https://fieldmatching.klc1809.com/)     | 売買価格が `FM_MAX_PRICE`（既定1円）以下の物件 |
| [負動産の掲示板](https://souzokutochi-kokkokizoku.com/deflug/) | 募集中・商談中・成約済みの全物件               |
| [NISUMEL](https://ichi-estate.com/)                            | 掲載物件（サンプル投稿は除く）                 |
| [家いちば](https://ieichiba.com/)                              | 価格が `IE_MAX_PRICE`（既定0円）以下の物件     |
| [全国０円不動産](https://zenkokuzeroen-fudosan.com/)           | 地域ページに載っている全物件                   |

> **みんなの0円物件（zero.estate）は取得しない。** 収集・掲載を照会したところ
> 2026年8月に不承諾の回答を受けたため、取得コードごと外した。詳しくは「利用条件」を参照。

## 構成

```text
app.ts            CLI。取得・住所検索・生成を呼び分けるだけ
build.ts          取得 → 住所検索 → map.json。ステータスと地方もここで揃える
server.ts         配信と定期ビルド (Bun.serve + Bun.cron)。手元でも自宅鯖でも同じもの
versioning.ts     index.html の assets/ の URL に中身の版 (?v=) を足す。版の付いた URL だけ長くキャッシュ
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
src/map-style.ts  地図の下地と重ねる層（写真・道路・物件の印）
src/places.ts     地名・住所の検索の問い合わせ（国土地理院の住所検索。ここだけ替えれば移せる）
src/place-search.ts 地図の上の「地名・住所へ移動」の欄
build-web.ts      src/ を assets/ に書き出す
tools/gsi/build.ts 地理院地図Vector の注記の層とスプライトを assets/gsi/ に写す（bun run gsi）
assets/styles.css 見た目（ここは手書き）
assets/favicon.svg, assets/apple-touch-icon.png  アイコン（手書き）
assets/gsi/       地理院の注記の層 (anno.json) とスプライト。tools/gsi/build.ts の生成物だが Git に入れる
assets/main.js    生成物。maplibre-gl.* も生成時に置かれる
Dockerfile        実行イメージ。node_modules は入らない（実行時の依存が無いため）
compose.yml       ローカル実行。認証情報は compose.override.yml で上書きする
deploy/           自宅クラスタ用のマニフェスト。ArgoCD が追従してデプロイする
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
bun run gsi             # 地理院の注記の層とスプライトを assets/gsi/ に写し直す
bun run dev             # フロントをビルドして http://localhost:5173/ で確認
bun run start           # 配信のみ (BUILD_CRON を入れると定期ビルドも走る)
bun run lint            # oxlint と書式 (bun fmt --check)。直すのは bun run format
bun run typecheck       # 型
bun run test            # テスト (bun test)
```

取得元を足すときは `sources/` にファイルを1つ作り、`sources/index.ts` の
`SOURCES` に並べる。取得・住所検索・`map.json` への合流はそれだけで通る。

### 環境変数

| 変数               | 意味                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `FM_MAX_PRICE`     | フィールドマッチングで地図に載せる価格の上限。既定 `1`（円）                                          |
| `IE_MAX_PRICE`     | 家いちばで地図に載せる価格の上限。既定 `0`（円）                                                      |
| `FETCH_DELAY_MS`   | 取得の間隔。既定 `700`（ミリ秒）                                                                      |
| `GEOCODE_DELAY_MS` | 住所検索の間隔。既定 `500`（ミリ秒）                                                                  |
| `HTTPS_PROXY`      | 海外IPから負動産の掲示板・NISUMEL を取得する際に迂回させる。プロセス全体の `fetch` に掛かる。下記参照 |
| `PORT`             | 配信するポート。既定 `5173`                                                                           |
| `BUILD_CRON`       | 定期ビルドの時刻（例 `0 9 * * *`）。空なら定期ビルドをしない                                          |
| `TZ`               | `BUILD_CRON` を読む時間帯。既定 `Asia/Tokyo`                                                          |

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

自宅クラスタでは [`deploy/deployment.yaml`](deploy/deployment.yaml) に直接書く。
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

`assets/` のファイル名は固定（`main.js` など）なので、サーバ（`server.ts`）がページを返すときに
`index.html` の `./assets/…` へ中身のハッシュを `?v=` で足す（`versioning.ts`）。版の付いた URL は
1 年 `immutable` でキャッシュさせ、版の無い URL（maplibre が自分で読む shared / worker の chunk、
`assets/gsi/` の注記とスプライト）と古い版の URL は毎回問い合わせさせる（変わっていなければ 304）。
以前は 1 時間キャッシュさせていて、デプロイしても Cloudflare とブラウザに古い `main.js` が残った。

- 下地は [danything/sonae](https://github.com/danything/sonae) と同じ形にそろえてある（下の「地図の層と出典」）。
  地図は 1 つだけで、層はいつも全部出す。背景や層を選ぶ一覧は置かない（持ち主の決定、2026-11-16）。前の切替は選んだものを覚えていなかった（URL にも端末にも残していない）ので、消す設定も無い
- ステータスは取得元をまたいで揃えている（フィールドマッチングの「公開中」は
  他サイトの「募集中」、「交渉中」は負動産の掲示板の「商談中」にあたる）
- 地方は都道府県から引いている。掲載側の値は使わない（zero.estate は持っているが、
  同じ県が「中部」だったり「東海」だったりと揃っていない）
- マーカーはステータス別の色。近い物件はクラスタにまとめ、ズームすると開く
- 物件名・住所の検索、ステータス / 種別 / 地方 / 都道府県 / 特記事項での絞り込み、
  新着・閲覧数・お気に入り順の並べ替え、「地図に写っている物件だけ一覧に出す」表示
- 絞り込み条件は URL のハッシュに入るので、そのまま共有できる
- 掲載側に座標が無い物件は、住所から国土地理院の住所検索APIで引いて表示する。
  推定した場合はポップアップに一致した住所を出す。
  負動産の掲示板は番地を公開していないため、全件が大字までの推定になる
- 物件のポップアップと一覧には取得元を表示する

### 地図の層と出典

下から順に重ねる（`src/map-style.ts`）。

| 層               | 中身                                                                                                                                                                                                                                                                                       | 条件                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 下地             | 地理院タイル「写真」 `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg`（ズーム 2〜18）。2〜8 は世界衛星モザイク、9〜13 は全国ランドサットモザイク、14〜18 はシームレス空中写真                                                                                          | 国土地理院コンテンツ利用規約。申請は要らず、出典「国土地理院」と[地理院タイル一覧](https://maps.gsi.go.jp/development/ichiran.html)へのリンク。一覧の備考どおり Landsat8・GEBCO・NASA LP DAAC/USGS EROS・GRUS（© Axelspace）も書く |
| 道路             | 地理院地図Vector（国土地理院最適化ベクトルタイル）の道路中心線（`RdCL`）。高速道路（ズーム 6 から）・国道（7）・都道府県道（10）・ほかの道（13）を、黒い縁取りの上に明るい線で引く（`roadLayers`）。国土地理院のスタイルの道路の色は写真の上で沈むので使わない                             | 下の「地理院地図Vector」                                                                                                                                                                                                           |
| 地名と施設の記号 | 地理院地図Vector の注記（`Anno`）。国土地理院のスタイル `std.json` の注記の層 9 つを `tools/gsi/build.ts` で取り出し、字を白・縁を黒く太く（幅 1.6）し、字体を端末の字体に替えたもの（`assets/gsi/anno.json`）。記号は同じリポジトリのスプライトを写して自分で配る（`assets/gsi/sprite/`） | 下の「地理院地図Vector」                                                                                                                                                                                                           |
| 検索で選んだ所   | 白い縁の橙の丸（下の「地名・住所の検索」）                                                                                                                                                                                                                                                 |                                                                                                                                                                                                                                    |
| 物件             | ステータス別の色の点と、件数のクラスタ。写真の上で読めるよう、点は白い縁、クラスタは暗い地に緑の縁                                                                                                                                                                                         | 物件の出典はパネルのフッタ                                                                                                                                                                                                         |

**出典の出し方:** 国土地理院の[出典の記載](https://www.gsi.go.jp/LAW/2930-meizi.html)は「システムやWebサイトに測量成果を利用する場合、原則、測量成果が表示画面に表示されている間は、常に見えるように表示画面に明示」とする。
そのため MapLibre の出典の (i)（押すまで見えない）は出さず（`attributionControl: false`）、
地図の角にぴったり付けた小さく薄い帯に「出典: 国土地理院 ほか」をいつも出す（`index.html` の `map-credit`）。
押すと全文（地理院タイル・国土地理院最適化ベクトルタイルを加工したこと・写真の元の衛星画像・地名検索の問い合わせ先・MapLibre）が開く。
帯は PC では右下の角（右下の操作はその上）、スマホでは右上の角に置く（下はパネルが覆い、開いていると隠れてしまうため）。

**地理院地図Vector:**

- 配信は `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles`（PMTiles の 1 ファイル、ズーム 4〜16）。
  範囲（Range）を指定して要るタイルだけを読む（CORS は `*`）。`pmtiles`（Protomaps、BSD-3-Clause）で MapLibre に読ませる（`main.js` に入る）。
  前の `{z}/{x}/{y}.pbf` はデータが 2023-10 で止まっているので使わない
- 試験公開で、URL や属性が変わることがある。変わったら `src/map-style.ts` の `GSI_VECTOR_URL` と `tools/gsi/build.ts` を直す。
  写真は出るのに道路と地名が全部消えたら、まずこの配信を疑う（[optimal_bvmap の README](https://github.com/gsi-cyberjapan/optimal_bvmap) にお知らせが出る）
- [README](https://github.com/gsi-cyberjapan/optimal_bvmap) は国土地理院コンテンツ利用規約（公共データ利用規約 第 1.0 版）で使えるとしている。出典は「国土地理院最適化ベクトルタイル」と書き、加工したことも書く
- **字体（glyphs）は読まない。** MapLibre 6 はスタイルに `glyphs` の URL が無いと、字を端末の字体でその場で描く。
  字体の名前は `"Noto Sans JP", sans-serif`（入っていない端末は既定のゴシック）。前はクラスタの件数だけ MapLibre の配布のフォントを外から読んでいたが、それもやめた
- 注記とスプライトを写し直すときは `bun run gsi`（コンテナの中で。`tools/gsi/build.ts` の頭のコメント）。
  スプライトの `std@2x.*` は上流でも `std.*` と同じファイル（2026-11-16 に確かめた）なので、中身が同じなのは写し損ないではない

前は Esri World Imagery を既定にして、国土地理院の写真・淡色地図への切替と Esri の地名ラベルを置いていた。
sonae の形（写真に道路と地名を重ねる）にそろえるため、どれも外した（2026-11-16）。

### 地名・住所の検索

地図の上（PC は右上、スマホは上の端）の「地名・住所へ移動」の欄（`src/place-search.ts`・`src/places.ts`）。
物件を絞り込むパネルの検索とは別で、地図を寄せるだけ。候補を選ぶと、パネルに隠れていない所の真ん中へ寄せ
（ズーム 15 まで。それより寄せているときはそのまま）、白い縁の橙の丸の印を置く。欄を空にすると印も消える。
スマホではパネルを閉じる。

- 問い合わせ先は**国土地理院の住所検索**（`https://msearch.gsi.go.jp/address-search/AddressSearch?q=…`。地理院地図が使っているもの。sonae と同じ）。
  問い合わせるのは Enter を押したときか、打つのが 0.6 秒止まったとき（2 文字から）だけで、打つたびには送らない。
  同じ文字の答えはタブを開いている間は覚えて、問い合わせ直さない。候補は 8 つまで
- 欄は combobox、候補は listbox と option。↑↓で動き、Enter で選び（選んでいなければ今すぐ探す）、Esc で候補だけを閉じる
- 読めないときは「住所を探せませんでした (国土地理院の住所検索)」と出す
- 打った文字は**ブラウザから国土地理院へ直接送る**。譲葉のサーバーは通さず、残さない。Cookie は送らず、`Referer` も付けない
- 住所検索は、外のアプリが使ってよいとも、使うなとも書いていない（運営は「主に地理院地図からの利用を想定」「必ずしも常にまた長期的に提供できるとは限らない」と答えている。[gsimaps#29](https://github.com/gsi-cyberjapan/gsimaps/issues/29)）。
  使ってよいかを国土地理院に問い合わせている。替えるときは `src/places.ts`（`GSI_ADDRESS_SEARCH`・`gsiSearchUrl`・`parseGsi`）だけを替える
- 出典は地図の隅の全文に書く（住所の中身は CSIS シンプルジオコーディング実験（街区レベル位置参照情報））

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

[`deploy/`](deploy/) にマニフェストを置いてある。配信も定期ビルドも `server.ts` の
1プロセスなので、Deployment ひとつと、取得結果を残す PVC だけ。`danything`
配下のリポジトリは `deploy/argocd.yaml` が ApplicationSet に拾われて自動デプロイ
される。イメージは [`docker-publish.yml`](.github/workflows/docker-publish.yml)
が `main` への push のたびに ghcr へ push し、同じジョブが
`deploy/deployment.yaml` のタグをそのビルドの sha に書き換えて `main` に直接
コミットする。ArgoCD はそのタグの変化を差分として検知して自動でロールアウト
するので、手動で `kubectl rollout restart` する必要はない。

`y.doany.io` は自宅に向け直し済みで、GitHub Pages（独自ドメインを含む）も
削除した。これにより `5ym.github.io/zero-owner/` からのリダイレクトは消えている。
このURLはアキソルへの照会文に書いていたため切り替えを保留していたが、
両社とも回答済みだったので切り替えた。

## 利用条件

取得元ごとに規約を確認した結果。

| 取得元               | 収集                                   | 転載・公開                                           |
| -------------------- | -------------------------------------- | ---------------------------------------------------- |
| フィールドマッチング | 明文の禁止なし（第13条は包括条項のみ） | 明文の禁止なし（第15条は自社制作物に限定）           |
| 負動産の掲示板       | **利用規約が存在しない**               | 同左（無断転載禁止の明示も無い）                     |
| NISUMEL              | **利用規約が存在しない**               | 同左                                                 |
| 家いちば             | **利用規約が存在しない**               | 同左                                                 |
| 全国０円不動産       | 記述なし                               | サイトポリシーが**出所明示による転載を明示的に許可** |

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
