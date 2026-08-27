# zero-owner

[zero.estate](https://zero.estate/) に掲載された0円物件を集めて、**衛星写真の地図**に表示する静的サイト。

> **現在停止中。** 掲載情報の収集・掲載について zero.estate（０円都市開発合同会社）に
> 承諾を照会中のため、定期実行と一般公開を止めている。詳しくは「利用条件」を参照。

## 構成

```text
app.ts            収集 (zero.estate API) と map.json の生成
serve.ts          ローカル確認用の静的サーバ
index.html        地図ページ
assets/main.js    MapLibre GL の地図・絞り込み・一覧
assets/styles.css 見た目
data.json         API のレスポンスをそのまま保存したもの（生成物・コミットしない）
map.json          地図が読む軽量データ（生成物・コミットしない）
```

## 使い方

```bash
bun install

bun run start   # 取得 (data.json) + 地図用データ生成 (map.json)
bun run fetch   # 取得だけ
bun run json    # data.json から map.json を作り直すだけ
bun run dev     # http://localhost:5173/ で地図を確認
bun app.ts csv  # 旧形式の map.csv が要るとき
```

### 環境変数

| 変数 | 意味 |
| --- | --- |
| `EMAIL` / `PASSWORD` | zero.estate のログイン情報（必須） |

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
- 座標を持たない物件（現在 59 件）は地図に出せないため、件数だけヘッダに表示している

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

`data.json` / `map.json` はリポジトリにコミットしない（生成物のため）。

## 注意

掲載内容・ステータスは zero.estate の公式ページで必ず確認すること。
収集は 1 日 1 回。実行頻度を上げすぎないこと。
