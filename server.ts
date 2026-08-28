/**
 * 地図の配信と、定期ビルド。
 *
 * ローカルの確認 (`bun run dev`) でも、自宅クラスタでの常駐でも同じものを使う。
 * 配信するのは3種類のファイルだけなので、パスから組み立てずに列挙している
 * （`./${url.pathname}` のような組み立ては `..` でリポジトリ内を読まれる）。
 *
 * 圧縮は前段の Traefik に任せる。Bun.serve は自動では圧縮しない。
 */

import { OUT_FILE, runBuild } from "./build.ts";

const port = Number(Bun.env.PORT ?? 5173);
/** 空なら定期ビルドをしない。ローカルでは未設定のまま使う */
const BUILD_CRON = Bun.env.BUILD_CRON ?? "";
const TZ = Bun.env.TZ ?? "Asia/Tokyo";

/** 配信するファイル。ここに無いパスは 404 */
const ROUTES: Record<string, { path: string; cache: string }> = {
	"/": { path: "index.html", cache: "public, max-age=0, must-revalidate" },
	"/index.html": {
		path: "index.html",
		cache: "public, max-age=0, must-revalidate",
	},
	// 1日1回しか変わらないので、TTL で当てずに毎回問い合わせて 304 を返す
	"/map.json": { path: OUT_FILE, cache: "public, max-age=0, must-revalidate" },
	"/assets/main.js": { path: "assets/main.js", cache: "public, max-age=3600" },
	"/assets/maplibre-gl.mjs": {
		path: "assets/maplibre-gl.mjs",
		cache: "public, max-age=86400",
	},
	"/assets/maplibre-gl-shared.mjs": {
		path: "assets/maplibre-gl-shared.mjs",
		cache: "public, max-age=86400",
	},
	"/assets/maplibre-gl-worker.mjs": {
		path: "assets/maplibre-gl-worker.mjs",
		cache: "public, max-age=86400",
	},
	"/assets/maplibre-gl.css": {
		path: "assets/maplibre-gl.css",
		cache: "public, max-age=86400",
	},
	"/assets/styles.css": {
		path: "assets/styles.css",
		cache: "public, max-age=3600",
	},
};

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
	return new Response(file, { headers });
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
