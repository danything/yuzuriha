/**
 * 座標を持たない物件を住所から推定する。
 *
 * 国土地理院の住所検索 API（地理院地図が使っているもの）を叩く。キーは不要。
 * 結果は geocode-cache.json に貯めて、次回以降は問い合わせない。
 */

import { sleep, USER_AGENT } from "./sources/common.ts";

const ENDPOINT = "https://msearch.gsi.go.jp/address-search/AddressSearch";
const CACHE_FILE = "data/geocode-cache.json";
const DELAY_MS = Number(Bun.env.GEOCODE_DELAY_MS ?? 500);

export type GeoHit = {
	lat: number;
	lng: number;
	/** API が実際に一致させた住所。どこまで絞れたか分かるように残す */
	title: string;
} | null;

export type GeoCache = Record<string, GeoHit>;

/**
 * 掲載住所は表記がまちまちなので、検索に通る形に均す。
 * 「①…②…」の複数筆は先頭だけ、括弧の注記と2筆目以降は落とす。
 */
export function normalizeAddress(
	prefecture: string,
	city: string,
	address: string,
): string {
	let a = (address ?? "").replace(/\r?\n/g, " ").trim();
	a = a.split(/[①②③④⑤⑥⑦⑧⑨⑩]/).filter(Boolean)[0] ?? a;
	a = a.replace(/[（(【「][^）)】」]*[）)】」]/g, " ");
	a = a.split(/[,、]/)[0] ?? a;
	a = a.trim();

	// 住所欄に都道府県から入っていることがあるので、二重に前置しない
	const head = a.startsWith(prefecture)
		? ""
		: `${prefecture}${a.startsWith(city) ? "" : city}`;
	return `${head}${a}`.replace(/\s+/g, "");
}

export async function loadCache(): Promise<GeoCache> {
	const file = Bun.file(CACHE_FILE);
	if (!(await file.exists())) return {};
	return JSON.parse(await file.text()) as GeoCache;
}

async function saveCache(cache: GeoCache): Promise<void> {
	await Bun.write(CACHE_FILE, JSON.stringify(cache, null, "\t"));
}

async function search(query: string): Promise<GeoHit> {
	const res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(query)}`, {
		headers: { "user-agent": USER_AGENT, accept: "application/json" },
	});
	if (!res.ok) throw new Error(`住所検索: HTTP ${res.status} (${query})`);

	const hits = (await res.json()) as {
		geometry?: { coordinates?: [number, number] };
		properties?: { title?: string };
	}[];

	const best = hits?.[0];
	const coords = best?.geometry?.coordinates;
	if (!coords || coords.length < 2) return null;

	return {
		lat: coords[1],
		lng: coords[0],
		title: best.properties?.title ?? query,
	};
}

/** まだ引いていない住所だけ問い合わせ、キャッシュを更新して返す */
export async function geocodeMissing(queries: string[]): Promise<GeoCache> {
	const cache = await loadCache();
	const todo = [...new Set(queries)].filter((q) => q && !(q in cache));

	if (todo.length === 0) {
		console.log("住所検索: 新しく引く住所はありません");
		return cache;
	}

	console.log(`住所検索: ${todo.length} 件を問い合わせます`);
	let found = 0;

	for (const [index, query] of todo.entries()) {
		try {
			const hit = await search(query);
			cache[query] = hit;
			if (hit) found++;
		} catch (error) {
			// 失敗は覚えさせない。次回また引けばいい
			console.warn(`  ${query}: ${(error as Error).message}`);
		}
		if ((index + 1) % 20 === 0) console.log(`  ${index + 1}/${todo.length}`);
		await sleep(DELAY_MS);
	}

	await saveCache(cache);
	console.log(`${CACHE_FILE} 保存完了 (今回 ${found}/${todo.length} 件ヒット)`);
	return cache;
}
