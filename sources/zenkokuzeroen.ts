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
import type { SourceProperty } from "../types.ts";
import {
	getText,
	jstToIso,
	readRaw as readRawFile,
	saveRaw,
	sleep,
	splitAddress,
	stripTags,
} from "./common.ts";

const BASE = "https://zenkokuzeroen-fudosan.com";
const SOURCE = "zenkokuzeroen";
const RAW_FILE = "data/zenkokuzeroen.json";

/** 地域ごとの物件ページ */
const AREA_PAGES = [24, 29, 31, 32, 33, 34, 35, 36];

export type ZenkokuItem = {
	/** b_id と r_id の組が物件を一意にする */
	key: string;
	url: string;
	label: string;
	/** 一覧に出ている掲載日 (YYYY-MM-DD) */
	date: string | null;
	page: number;
};

export async function fetchZenkokuZeroen(): Promise<ZenkokuItem[]> {
	const items = new Map<string, ZenkokuItem>();

	for (const page of AREA_PAGES) {
		const html = await getText(
			`${BASE}/pages/${page}/`,
			`全国０円不動産 pages/${page}`,
		);

		// 掲載日はリンクの手前に出ているので、まとめて拾う
		for (const match of html.matchAll(
			/(\d{4}-\d{2}-\d{2})[\s\S]{0,600}?<a[^>]+href="([^"]*detail=1[^"]*)"[^>]*>([\s\S]{0,600}?)<\/a>/g,
		)) {
			const date = match[1];
			const href = match[2].replace(/&amp;/g, "&");
			const label = stripTags(match[3]);
			const ids = href.match(/b_id=(\d+)&r_id=(\d+)/);
			// 物件以外のリンクや、説明文の無いものは飛ばす
			if (!ids || label.length < 10) continue;

			const key = `${ids[1]}-${ids[2]}`;
			if (!items.has(key)) {
				items.set(key, { key, url: `${BASE}${href}`, label, date, page });
			}
		}
		await sleep();
	}

	return await saveRaw(RAW_FILE, [...items.values()]);
}

export const readRaw = () => readRawFile<ZenkokuItem>(RAW_FILE);

/** 「※成約済み【徳島県三好市池田町】…」の【】から所在地を取り出す */
const locationOf = (label: string) =>
	splitAddress((label.match(/【(.+?)】/) ?? [])[1] ?? "");

export function addressOf(item: ZenkokuItem): string {
	const { prefecture, city, rest } = locationOf(item.label);
	if (!prefecture) return "";
	return normalizeAddress(prefecture, city, rest);
}

export function toMapProperties(
	items: ZenkokuItem[],
	geo: GeoCache = {},
): { properties: SourceProperty[]; unmapped: number } {
	const properties: SourceProperty[] = [];
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
			address: rest,
			lat: hit.lat,
			lng: hit.lng,
			price: 0,
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: [],
			publishedAt: jstToIso(item.date ?? "2020-01-01"),
			image: null,
			approx: hit.title,
		});
	}

	return { properties, unmapped };
}
