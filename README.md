# zero-owner

0円物件を掲載サイトから集めて、**衛星写真の地図**に表示する静的サイト。

| 取得元 | 対象 |
| --- | --- |
| [みんなの0円物件](https://zero.estate/) | 掲載されている全物件 |
| [フィールドマッチング](https://fieldmatching.klc1809.com/) | 売買価格が `FM_MAX_PRICE`（既定1円）以下の物件 |

> **現在停止中。** 掲載情報の収集・掲載について zero.estate（０円都市開発合同会社）に
> 承諾を照会中のため、定期実行と一般公開を止めている。詳しくは「利用条件」を参照。

## 構成

```text
app.ts            CLI と zero.estate の取得・map.json の生成
fieldmatching.ts  フィールドマッチングの取得
geocode.ts        座標が無い物件を住所から引く（国土地理院API）
types.ts          地図が読む共通の物件型
serve.ts          ローカル確認用の静的サーバ
index.html        地図ページ
assets/main.js    MapLibre GL の地図・絞り込み・一覧
assets/styles.css 見た目
data.json         zero.estate の生データ（生成物・コミットしない）
data-fieldmatching.json  フィールドマッチングの生データ（同上）
geocode-cache.json       住所検索の結果（同上）
map.json          地図が読む軽量データ（同上）
```

## 使い方

```bash
bun app.ts           # zero.estate を取得して map.json を作る
bun app.ts fetch     # zero.estate から data.json を作る
bun app.ts fetch-fm  # フィールドマッチングから data-fieldmatching.json を作る
bun app.ts geocode   # 座標が無い物件の住所を国土地理院APIで引く
bun app.ts json      # 生データから map.json を作る
bun run dev          # http://localhost:5173/ で確認
```

### 環境変数

| 変数 | 意味 |
| --- | --- |
| `EMAIL` / `PASSWORD` | zero.estate のログイン情報（zero.estate の取得に必須） |
| `FM_MAX_PRICE` | フィールドマッチングで地図に載せる価格の上限。既定 `1`（円） |
| `FETCH_DELAY_MS` | 取得の間隔。既定 `700`（ミリ秒） |
| `GEOCODE_DELAY_MS` | 住所検索の間隔。既定 `500`（ミリ秒） |

ローカルでは `.env` に書けば Bun が読み込む（`.env` は Git 管理外）。
CI ではリポジトリの **Settings → Secrets and variables → Actions** に同名で登録する。

## 地図

描画は **MapLibre GL JS**（WebGL）。ラスタタイルも点も GPU で描くので、
DOM でタイルを動かす方式（Leaflet）よりパンが軽い。WebGL2 が必要なので、
使えない環境では地図の代わりにその旨を表示する。

- 背景は **衛星写真**（既定: Esri World Imagery、切替で国土地理院シームレス空中写真・淡色地図）
- 地名ラベルを重ねて表示（右下のレイヤコントロールで切替）
- マーカーはステータス別の色。近い物件はクラスタにまとめ、ズームすると開く
  （クラスタの件数表示にだけ [MapLibre 配布のフォント](https://demotiles.maplibre.org/) を使う）
- 物件名・住所の検索、ステータス / 種別 / 地方 / 都道府県 / 特記事項での絞り込み、
  新着・閲覧数・お気に入り順の並べ替え、「地図に写っている物件だけ一覧に出す」表示
- 絞り込み条件は URL のハッシュに入るので、そのまま共有できる
- 掲載側に座標が無い物件は、住所から国土地理院の住所検索APIで引いて表示する。
  推定した場合はポップアップに一致した住所を出す（現在 72 件）
- 物件のポップアップと一覧には取得元を表示する

## 利用条件

zero.estate の利用規約は、**第６条第９号**で「当社の事前の承諾なく、本サービスの情報を
収集・蓄積する行為」を、**第９条第２項**で「事前の書面による承諾なく、本サービスの
コンテンツを複製、転載、改変、配布その他の方法で利用」することを禁じている。
`robots.txt` にも `Disallow: /api/` がある。

本リポジトリの収集・掲載はこれに該当するため、承諾を照会中。回答が出るまでの措置として:

- 定期実行（cron）と push トリガーを停止。手動実行のみ
- GitHub Pages の公開を停止（リポジトリを private 化）

再開するときは [`.github/workflows/main.yml`](.github/workflows/main.yml) のトリガーを戻し、
Pages を **Settings → Pages → Source: GitHub Actions** で有効にする。

フィールドマッチング（株式会社KLC）の[利用規約](https://fieldmatching.klc1809.com/terms)には、
収集や転載を明示的に禁じる条項は無い（第13条の禁止事項に該当する号が無く、第15条の知的財産権も
「当社が作成・提供する」ものに限られる）。`robots.txt` も物件ページを許可している。
とはいえ第13条(28)(32)の包括条項があるので、こちらも一報を入れる前提で扱う。

`data.json` / `map.json` はリポジトリにコミットしない（生成物のため）。

## 注意

掲載内容・ステータスは zero.estate の公式ページで必ず確認すること。
収集は 1 日 1 回。実行頻度を上げすぎないこと。
