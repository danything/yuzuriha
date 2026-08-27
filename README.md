# zero-owner

[zero.estate](https://zero.estate/) に掲載された0円物件を集めて、**衛星写真の地図**に表示する静的サイト。
GitHub Actions で毎日収集し、GitHub Pages に配信する。

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

## GitHub Pages への公開

1. リポジトリの **Settings → Pages → Source** を **GitHub Actions** にする
2. `main` への push、または 1 日 1 回（9:00 JST）の cron で
   [`.github/workflows/main.yml`](.github/workflows/main.yml) が収集・デプロイを行う
3. 公開先: `https://<ユーザー名>.github.io/zero-owner/`

`data.json` / `map.json` はリポジトリにコミットしない（CI が push すると手元の作業と衝突するため）。
デプロイのたびに作り直して Pages の成果物に載せている。

## 注意

掲載内容・ステータスは zero.estate の公式ページで必ず確認すること。
収集は 1 日 1 回。実行頻度を上げすぎないこと。
