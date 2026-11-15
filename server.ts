/**
 * 地図の配信と、定期ビルド。
 *
 * ローカルの確認 (`bun run dev`) でも、自宅クラスタでの常駐でも同じものを使う。
 * 配信するのはページと map.json と assets/ の中身だけ。要求されたパスから
 * ファイル名を組み立てると `..` でリポジトリ内を読まれるので、起動時に作った
 * 一覧と照合して、載っていないものは 404 にしている。
 *
 * 圧縮はここで行う。以前は前段の Traefik(compress ミドルウェア)に任せていたが、
 * Gateway API に相当するフィルタが無いので自前で持つことにした。Bun.serve は自動では圧縮しない。
 */

import { OUT_FILE, runBuild } from "./build.ts";
import {
  assetCacheControl,
  digest,
  REVALIDATE,
  stampAssetUrls,
} from "./versioning.ts";

const port = Number(Bun.env.PORT ?? 5173);
/** 空なら定期ビルドをしない。ローカルでは未設定のまま使う */
const BUILD_CRON = Bun.env.BUILD_CRON ?? "";
const TZ = Bun.env.TZ ?? "Asia/Tokyo";

/**
 * 配信するファイル。ここに無いパスは 404。
 *
 * - page: index.html。assets/ の URL に版を足してから返す (versioning.ts)
 * - data: map.json。1日1回しか変わらないので、TTL で当てずに毎回問い合わせて 304 を返す
 * - asset: assets/ の中身。`?v=` が今の版と合えば長く、それ以外は毎回問い合わせ
 */
type Route = { path: string; kind: "page" | "data" | "asset" };

const ROUTES: Record<string, Route> = {
  "/": { path: "index.html", kind: "page" },
  "/index.html": { path: "index.html", kind: "page" },
  "/map.json": { path: OUT_FILE, kind: "data" },
};
/** assets/ の中の名前 (`gsi/anno.json` など)。index.html の URL に版を足すのに使う */
const ASSET_NAMES: string[] = [];

// assets/ は起動時にあるものをそのまま載せる。中身は maplibre の chunk まで
// 数えると6つあり、build-web.ts と名前を二重に持ちたくない。地理院の注記とスプライト
// (assets/gsi/。tools/gsi/build.ts が書く) もあるので、下のフォルダまで走査する。
// 走査した名前としか照合しないので、パスを組み立てるのと違って `..` は入らない。
try {
  for await (const found of new Bun.Glob("**/*").scan("assets")) {
    const name = found.replaceAll("\\", "/");
    ROUTES[`/assets/${name}`] = { path: `assets/${name}`, kind: "asset" };
    ASSET_NAMES.push(name);
  }
} catch {
  // フロントを一度もビルドしていないと assets/ 自体が無い
  console.warn(
    "assets/ がありません。先に bun build-web.ts を実行してください",
  );
}

/**
 * ファイルの中身の版。読むのはサイズか更新時刻が変わったときだけ。
 * 版は URL にも ETag にも使う。更新時刻はイメージを作るたびに変わるので、
 * 中身から作った方が、変わっていないファイルをデプロイ後も 304 で済ませられる。
 */
const versions = new Map<
  string,
  { size: number; mtime: number; hash: string }
>();
async function versionOf(path: string): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  const mtime = file.lastModified;
  const known = versions.get(path);
  if (known && known.size === size && known.mtime === mtime) return known.hash;
  const hash = digest(new Uint8Array(await file.arrayBuffer()));
  versions.set(path, { size, mtime, hash });
  return hash;
}

/** index.html の assets/ の URL に今の版を足したもの */
async function renderPage(path: string): Promise<Blob> {
  const current = new Map<string, string>();
  for (const name of ASSET_NAMES) {
    current.set(name, await versionOf(`assets/${name}`));
  }
  const html = stampAssetUrls(await Bun.file(path).text(), (name) =>
    current.get(name),
  );
  return new Blob([html], { type: "text/html;charset=utf-8" });
}

async function serve(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = ROUTES[url.pathname];
  if (!route) return new Response("Not Found", { status: 404 });

  const file = Bun.file(route.path);
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 });
  }

  let body: Blob = file;
  let version: string;
  let cache = REVALIDATE;
  if (route.kind === "page") {
    body = await renderPage(route.path);
    version = digest(new Uint8Array(await body.arrayBuffer()));
  } else {
    version = await versionOf(route.path);
    if (route.kind === "asset") {
      cache = assetCacheControl(url.searchParams.get("v"), version);
    }
  }

  const etag = `W/"${version}"`;
  const headers = {
    "cache-control": cache,
    etag,
    // 掲載元の検索流入を奪わない約束をしているので、明示しておく
    "x-robots-tag": "noindex, nofollow",
  };

  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers });
  }

  // 圧縮が効くのはテキストだけ。画像やフォントは既に圧縮済みなので触らない。
  // 小さいものは伸ばすだけ無駄なので閾値を置く。
  const type = body.type ?? "";
  const compressible =
    /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/.test(
      type,
    );
  if (!compressible || body.size < 1024) {
    return new Response(body, { headers });
  }

  // 同じ URL でも Accept-Encoding で中身が変わるので、キャッシュに知らせる。
  //
  // **content-type は自分で書く。** BunFile をそのまま渡したときは Bun が
  // 拡張子から入れてくれるが、**圧縮すると渡すのは Uint8Array になる**ので
  // 推測のしようがなく、`application/octet-stream` になる。ブラウザは必ず
  // `Accept-Encoding: gzip` を送るので、**全員がページをダウンロードさせられる**
  // (2026-09-06 の圧縮の移設で入り、2026-09-08 に見つけた)。
  const accept = req.headers.get("accept-encoding") ?? "";
  const compressed = {
    ...headers,
    "content-type": type,
    vary: "accept-encoding",
  };
  const bytes = new Uint8Array(await body.arrayBuffer());
  if (accept.includes("zstd")) {
    // zstdCompressSync は Buffer を返し、型の上では Response の body に渡せない
    // (中身は ArrayBuffer なので Uint8Array として渡す。写しは作らない)
    const zstd = Bun.zstdCompressSync(bytes);
    return new Response(
      new Uint8Array(
        zstd.buffer as ArrayBuffer,
        zstd.byteOffset,
        zstd.byteLength,
      ),
      {
        headers: { ...compressed, "content-encoding": "zstd" },
      },
    );
  }
  if (accept.includes("gzip")) {
    return new Response(Bun.gzipSync(bytes), {
      headers: { ...compressed, "content-encoding": "gzip" },
    });
  }
  return new Response(body, {
    headers: { ...headers, vary: "accept-encoding" },
  });
}

let building = false;

/**
 * Bun.cron は前回が終わるまで次を出さないので重複しないが、
 * 起動直後の初回ビルドと重なりうるので念のため見張る。
 */
async function build(reason: string) {
  if (building) {
    console.warn(`${reason}: 前回のビルドが実行中のため見送り`);
    return;
  }
  building = true;
  console.log(`${reason}: ビルド開始`);
  try {
    await runBuild();
  } catch (error) {
    console.error(`ビルド失敗: ${(error as Error).message}`);
  } finally {
    building = false;
  }
}

Bun.serve({ port, fetch: serve });
console.log(`http://localhost:${port}/`);

if (BUILD_CRON) {
  Bun.cron(BUILD_CRON, () => build("定期実行"), { tz: TZ });
  console.log(`定期ビルド: ${BUILD_CRON} (${TZ})`);

  // 新しいボリュームだと map.json がまだ無いので、初回だけ作る
  if (!(await Bun.file(OUT_FILE).exists())) {
    void build("初回");
  }
}
