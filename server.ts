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

const port = Number(Bun.env.PORT ?? 5173);
/** 空なら定期ビルドをしない。ローカルでは未設定のまま使う */
const BUILD_CRON = Bun.env.BUILD_CRON ?? "";
const TZ = Bun.env.TZ ?? "Asia/Tokyo";

/** 1日1回しか変わらないので、TTL で当てずに毎回問い合わせて 304 を返す */
const REVALIDATE = "public, max-age=0, must-revalidate";

/** 配信するファイル。ここに無いパスは 404 */
const ROUTES: Record<string, { path: string; cache: string }> = {
	"/": { path: "index.html", cache: REVALIDATE },
	"/index.html": { path: "index.html", cache: REVALIDATE },
	"/map.json": { path: OUT_FILE, cache: REVALIDATE },
};

// assets/ は起動時にあるものをそのまま載せる。中身は maplibre の chunk まで
// 数えると6つあり、build-web.ts と名前を二重に持ちたくない。
// 走査した名前としか照合しないので、パスを組み立てるのと違って `..` は入らない。
try {
	for await (const name of new Bun.Glob("*").scan("assets")) {
		ROUTES[`/assets/${name}`] = {
			path: `assets/${name}`,
			cache: "public, max-age=3600",
		};
	}
} catch {
	// フロントを一度もビルドしていないと assets/ 自体が無い
	console.warn(
		"assets/ がありません。先に bun build-web.ts を実行してください",
	);
}

/** 中身を読まずに済ませたいので、サイズと更新時刻から作る */
const etagOf = (size: number, mtime: number) =>
	`W/"${size.toString(16)}-${mtime.toString(16)}"`;

async function serve(req: Request): Promise<Response> {
	const route = ROUTES[new URL(req.url).pathname];
	if (!route) return new Response("Not Found", { status: 404 });

	const file = Bun.file(route.path);
	if (!(await file.exists())) {
		return new Response("Not Found", { status: 404 });
	}

	const etag = etagOf(file.size, file.lastModified);
	const headers = {
		"cache-control": route.cache,
		etag,
		// 掲載元の検索流入を奪わない約束をしているので、明示しておく
		"x-robots-tag": "noindex, nofollow",
	};

	if (req.headers.get("if-none-match") === etag) {
		return new Response(null, { status: 304, headers });
	}

	// 圧縮が効くのはテキストだけ。画像やフォントは既に圧縮済みなので触らない。
	// 小さいものは伸ばすだけ無駄なので閾値を置く。
	const type = file.type ?? "";
	const compressible =
		/^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/.test(type);
	if (!compressible || file.size < 1024) {
		return new Response(file, { headers });
	}

	// 同じ URL でも Accept-Encoding で中身が変わるので、キャッシュに知らせる
	const accept = req.headers.get("accept-encoding") ?? "";
	const body = new Uint8Array(await file.arrayBuffer());
	if (accept.includes("zstd")) {
		return new Response(Bun.zstdCompressSync(body), {
			headers: { ...headers, "content-encoding": "zstd", vary: "accept-encoding" },
		});
	}
	if (accept.includes("gzip")) {
		return new Response(Bun.gzipSync(body), {
			headers: { ...headers, "content-encoding": "gzip", vary: "accept-encoding" },
		});
	}
	return new Response(file, { headers: { ...headers, vary: "accept-encoding" } });
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
