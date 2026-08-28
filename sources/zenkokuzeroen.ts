/**
 * 全国０円不動産（一般社団法人全国０円不動産）から物件を取得する。
 *
 * 物件は地域ごとの固定ページに埋め込まれていて、1件が
 * `?detail=1&b_id=..&r_id=..` へのリンクとして並んでいる。
 * リンクの文字列が「※成約済み【都道府県市町村】説明…」の形なので、そこから拾う。
 *
 * サイトポリシーが「出所を明示することにより、引用、転載複製を行うことができます」と
 * 明記している唯一の取得元。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { MapProperty } from "../types.ts";

const BASE = "https://zenkokuzeroen-fudosan.com";
const SOURCE = "zenkokuzeroen";
const RAW_FILE = "data/zenkokuzeroen.json";

/** 地域ごとの物件ページ */
const AREA_PAGES = [24, 29, 31, 32, 33, 34, 35, 36];

const USER_AGENT =
	"zero-owner/1.0 (personal map project; +https://github.com/5ym/zero-owner)";
const DELAY_MS = Number(Bun.env.FETCH_DELAY_MS ?? 700);

export type ZenkokuItem = {
	/** b_id と r_id の組が物件を一意にする */
	key: string;
	url: string;
	label: string;
	/** 一覧に出ている掲載日 (YYYY-MM-DD) */
	date: string | null;
	page: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const clean = (html: string) =>
	html
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();

export async function fetchZenkokuZeroen(): Promise<ZenkokuItem[]> {
	const items = new Map<string, ZenkokuItem>();

	for (const page of AREA_PAGES) {
		const res = await fetch(`${BASE}/pages/${page}/`, {
			headers: { "user-agent": USER_AGENT },
		});
		if (!res.ok)
			throw new Error(`全国０円不動産 pages/${page}: HTTP ${res.status}`);
		const html = await res.text();

		// 掲載日はリンクの手前に出ているので、まとめて拾う
		for (const match of html.matchAll(
			/(\d{4}-\d{2}-\d{2})[\s\S]{0,600}?<a[^>]+href="([^"]*detail=1[^"]*)"[^>]*>([\s\S]{0,600}?)<\/a>/g,
		)) {
			const date = match[1];
			const href = match[2].replace(/&amp;/g, "&");
			const label = clean(match[3]);
			const ids = href.match(/b_id=(\d+)&r_id=(\d+)/);
			// 物件以外のリンクや、説明文の無いものは飛ばす
			if (!ids || label.length < 10) continue;

			const key = `${ids[1]}-${ids[2]}`;
			if (!items.has(key)) {
				items.set(key, { key, url: `${BASE}${href}`, label, date, page });
			}
		}
		await sleep(DELAY_MS);
	}

	const list = [...items.values()];
	await Bun.write(RAW_FILE, JSON.stringify(list, null, "\t"));
	console.log(`${RAW_FILE} 保存完了 (${list.length} 件)`);
	return list;
}

export async function readRaw(): Promise<ZenkokuItem[]> {
	const file = Bun.file(RAW_FILE);
	if (!(await file.exists())) return [];
	return JSON.parse(await file.text()) as ZenkokuItem[];
}

/** 「※成約済み【徳島県三好市池田町】…」から所在地を取り出す */
function locationOf(label: string): {
	prefecture: string;
	city: string;
	rest: string;
} {
	const inside = (label.match(/【(.+?)】/) ?? [])[1] ?? "";
	const match = inside.match(
		/^(北海道|東京都|京都府|大阪府|.{2,3}県)(.*?郡.*?[町村]|.*?[市区町村])?(.*)$/,
	);
	return {
		prefecture: match?.[1] ?? "",
		city: match?.[2] ?? "",
		rest: match?.[3] ?? "",
	};
}

export function addressOf(item: ZenkokuItem): string {
	const { prefecture, city, rest } = locationOf(item.label);
	if (!prefecture) return "";
	return normalizeAddress(prefecture, city, rest);
}

export function toMapProperties(
	items: ZenkokuItem[],
	geo: GeoCache = {},
): { properties: MapProperty[]; unmapped: number } {
	const properties: MapProperty[] = [];
	let unmapped = 0;

	for (const item of items) {
		const address = addressOf(item);
		const hit = address ? geo[address] : null;
		if (!hit) {
			unmapped++;
			continue;
		}

		const { prefecture, city, rest } = locationOf(item.label);
		const sold = item.label.startsWith("※成約済み");
		const title = item.label.replace(/^※成約済み/, "").trim();

		properties.push({
			id: `zz:${item.key}`,
			source: SOURCE,
			url: item.url,
			title,
			status: sold ? "成約済み" : "募集中",
			type: /建物|空き家|住宅|マンション/.test(title)
				? "土地・建物"
				: /土地|山林|農地|田畑|原野|宅地/.test(title)
					? "土地のみ"
					: "その他",
			prefecture,
			city,
			region: "",
			address: rest,
			lat: hit.lat,
			lng: hit.lng,
			price: 0,
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: [],
			publishedAt: new Date(
				`${item.date ?? "2020-01-01"}T00:00:00+09:00`,
			).toISOString(),
			image: null,
			approx: hit.title,
		});
	}

	return { properties, unmapped };
}
