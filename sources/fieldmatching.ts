/**
 * フィールドマッチング (株式会社KLC) から物件を取得する。
 *
 * 検索は POST /api/property/search?page=N で、本文に {page, sort} が要る（sort は必須）。
 * 1ページ10件で固定。per_page 等を渡しても無視される。ログインは不要。
 *
 * 並び順にタイブレークが無いらしく、ページをまたぐと同じ物件が重複して出たり、
 * 逆に一度も出てこない物件があったりする（全ページ舐めても 973 件中 783 件しか取れない）。
 * そこで都道府県で区切り、区切りごとに件数が揃うまで並び順を変えて重ねる。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { MapProperty } from "../types.ts";

const BASE = "https://fieldmatching.klc1809.com";
const SEARCH = `${BASE}/api/property/search`;
const SOURCE = "fieldmatching";
const RAW_FILE = "data-fieldmatching.json";

/** 名乗ったうえで間隔を空けて取りに行く */
// ヘッダに非ASCIIは入れられないので英字で名乗る
const USER_AGENT =
	"zero-owner/1.0 (personal map project; +https://github.com/5ym/zero-owner)";
const DELAY_MS = Number(Bun.env.FETCH_DELAY_MS ?? 700);
/** 取りこぼしを埋めるために試す並び順 */
const SORTS = [1, 2, 3, 4];
const PREFECTURES = Array.from({ length: 47 }, (_, i) => String(i + 1));
/** これ以下の価格だけ地図に載せる。ほぼ0円物件は1円で出ていることが多い */
const MAX_PRICE = Number(Bun.env.FM_MAX_PRICE ?? 1);

type Category = { id: number; name: string };

export type FieldMatchingItem = {
	id: number;
	name: string;
	status_id: number;
	status_title: string;
	sale_price: string | null;
	lat: string | null;
	lng: string | null;
	prefectures_name: string | null;
	city: string | null;
	block: string | null;
	address: string | null;
	area: string | null;
	ground_name: string | null;
	construction_year: number | null;
	is_building: number;
	sum_liked: number | string | null;
	image_url: string | null;
	categories: Category[] | null;
	registered_at: string | null;
	created_at: string;
	updated_at: string;
};

type SearchResponse = {
	success: boolean;
	message?: string;
	data?: {
		current_page: number;
		last_page: number;
		total: number;
		data: FieldMatchingItem[];
	};
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Query = { page: number; sort: number; prefecture_id?: string[] };

async function searchPage(query: Query, attempt = 0): Promise<SearchResponse> {
	const res = await fetch(`${SEARCH}?page=${query.page}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/plain, */*",
			"user-agent": USER_AGENT,
		},
		// sort が「選別フィールド」。省くと 400 になる
		body: JSON.stringify(query),
	});

	// 混み合っているときは間隔を空けて数回だけ待つ
	if ((res.status === 429 || res.status >= 500) && attempt < 3) {
		await sleep(DELAY_MS * 2 ** (attempt + 1));
		return searchPage(query, attempt + 1);
	}
	if (!res.ok) {
		throw new Error(
			`フィールドマッチング ${query.page}ページ目: HTTP ${res.status}`,
		);
	}
	return (await res.json()) as SearchResponse;
}

export async function fetchFieldMatching(): Promise<FieldMatchingItem[]> {
	const found = new Map<number, FieldMatchingItem>();
	let requests = 0;
	let expected = 0;

	for (const prefecture of PREFECTURES) {
		const seen = new Set<number>();
		let total = 0;

		for (const sort of SORTS) {
			const first = await searchPage({
				page: 1,
				sort,
				prefecture_id: [prefecture],
			});
			requests++;
			if (!first.data) break;

			total = first.data.total;
			const collect = (items: FieldMatchingItem[]) => {
				for (const item of items) {
					seen.add(item.id);
					found.set(item.id, item);
				}
			};
			collect(first.data.data);

			for (let page = 2; page <= first.data.last_page; page++) {
				await sleep(DELAY_MS);
				const res = await searchPage({
					page,
					sort,
					prefecture_id: [prefecture],
				});
				requests++;
				if (!res.data) break;
				collect(res.data.data);
			}

			// 件数が揃ったら並び順を変える必要はない
			if (seen.size >= total) break;
			await sleep(DELAY_MS);
		}

		expected += total;
		if (total > 0 && seen.size < total) {
			console.warn(
				`  都道府県 ${prefecture}: ${seen.size}/${total} 件しか取れませんでした`,
			);
		}
		await sleep(DELAY_MS);
	}

	const items = [...found.values()];
	console.log(
		`フィールドマッチング: ${items.length}/${expected} 件 (リクエスト ${requests} 回)`,
	);

	await Bun.write(RAW_FILE, JSON.stringify(items, null, "\t"));
	console.log(`${RAW_FILE} 保存完了 (${items.length} 件)`);
	return items;
}

export async function readRaw(): Promise<FieldMatchingItem[]> {
	const file = Bun.file(RAW_FILE);
	if (!(await file.exists())) return [];
	return JSON.parse(await file.text()) as FieldMatchingItem[];
}

/** 詳細ページの URL は id を5桁ゼロ埋めして a を付けたもの */
const detailUrl = (id: number) =>
	`${BASE}/property/a${String(id).padStart(5, "0")}`;

function toNumber(value: string | null | undefined): number {
	if (value === null || value === undefined || value.trim() === "")
		return Number.NaN;
	return Number(value);
}

/** 掲載側に座標が無いとき、住所検索の結果で補う */
export function addressOf(item: FieldMatchingItem): string {
	return normalizeAddress(
		item.prefectures_name ?? "",
		item.city ?? "",
		[item.block, item.address].filter(Boolean).join(""),
	);
}

export function toMapProperties(
	items: FieldMatchingItem[],
	geo: GeoCache = {},
): {
	properties: MapProperty[];
	unmapped: number;
	filtered: number;
} {
	const properties: MapProperty[] = [];
	let unmapped = 0;
	let filtered = 0;

	for (const item of items) {
		const price = toNumber(item.sale_price);
		if (!Number.isFinite(price) || price > MAX_PRICE) {
			filtered++;
			continue;
		}

		let lat = toNumber(item.lat);
		let lng = toNumber(item.lng);
		let approx: string | null = null;

		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			const hit = geo[addressOf(item)];
			if (!hit) {
				unmapped++;
				continue;
			}
			({ lat, lng } = hit);
			approx = hit.title;
		}

		// 建物の有無は is_building、築年は不明だと -1 が入る
		const builtYear =
			item.construction_year && item.construction_year > 0
				? `${item.construction_year}年`
				: null;

		properties.push({
			id: `fm:${item.id}`,
			source: SOURCE,
			url: detailUrl(item.id),
			title: item.name,
			status: item.status_title,
			type: item.ground_name ?? "",
			prefecture: item.prefectures_name ?? "",
			city: item.city ?? "",
			region: "",
			address: [item.block, item.address].filter(Boolean).join(""),
			lat,
			lng,
			price,
			builtYear,
			views: 0,
			favorites: Number(item.sum_liked) || 0,
			notes: (item.categories ?? []).map((c) => c.name),
			// registered_at は JST の "YYYY-MM-DD HH:mm:ss"
			publishedAt: item.registered_at
				? new Date(
						`${item.registered_at.replace(" ", "T")}+09:00`,
					).toISOString()
				: item.created_at,
			image: item.image_url,
			approx,
		});
	}

	return { properties, unmapped, filtered };
}
