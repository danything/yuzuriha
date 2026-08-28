/**
 * 家いちば（空き家売ります掲示板）から物件を取得する。
 *
 * 一覧は「100万円未満」のタグページ。SPA だが HTML はサーバ側で組まれているので
 * ブラウザは要らない。カードには価格と所在地しか無いので、対象になった物件だけ
 * 詳細ページを開いて座標と掲載日を拾う（Nuxt の埋め込みデータに入っている）。
 *
 * 有償の物件が大半を占めるサイトなので、既定では価格0円のものだけ地図に載せる。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { MapProperty } from "../types.ts";

const BASE = "https://ieichiba.com";
const SOURCE = "ieichiba";
const RAW_FILE = "data/ieichiba.json";
/** 0円〜100万円未満のタグ。ここから価格で絞る */
const LIST_PATH = "/tags/0-100manyen";
const MAX_PAGES = 30;

const USER_AGENT =
	"zero-owner/1.0 (personal map project; +https://github.com/5ym/zero-owner)";
const DELAY_MS = Number(Bun.env.FETCH_DELAY_MS ?? 700);
/** これ以下の価格だけ地図に載せる（円） */
const MAX_PRICE = Number(Bun.env.IE_MAX_PRICE ?? 0);

export type IeichibaItem = {
	id: string;
	url: string;
	title: string;
	price: number;
	address: string;
	category: string | null;
	image: string | null;
	lat: number | null;
	lng: number | null;
	postDate: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const decode = (text: string) =>
	text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();

/** 「50万円」「0円」「1,200万円」を円に直す */
export function parsePrice(text: string): number {
	const normalized = text.replace(/[０-９]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0),
	);
	const oku = normalized.match(/([\d.,]+)\s*億円/);
	if (oku) return Math.round(Number(oku[1].replace(/,/g, "")) * 100_000_000);
	const man = normalized.match(/([\d.,]+)\s*万円/);
	if (man) return Math.round(Number(man[1].replace(/,/g, "")) * 10_000);
	const yen = normalized.match(/([\d,]+)\s*円/);
	return yen ? Number(yen[1].replace(/,/g, "")) : Number.NaN;
}

async function get(path: string): Promise<string> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "user-agent": USER_AGENT },
	});
	if (!res.ok) throw new Error(`家いちば ${path}: HTTP ${res.status}`);
	return await res.text();
}

/** 一覧ページの物件カードを読む */
function parseCards(
	html: string,
): Omit<IeichibaItem, "lat" | "lng" | "postDate">[] {
	const cards: Omit<IeichibaItem, "lat" | "lng" | "postDate">[] = [];

	for (const chunk of html.split('<a href="/project/').slice(1)) {
		const href = (chunk.match(/^([^"]+)"/) ?? [])[1];
		const id = (chunk.match(/data-property-id="([^"]+)"/) ?? [])[1];
		const priceText = (chunk.match(/property__list-item-price[^>]*>([^<]+)/) ??
			[])[1];
		if (!href || !id || !priceText) continue;

		cards.push({
			id,
			url: `${BASE}/project/${href}`,
			title: decode((chunk.match(/<h3[^>]*>([^<]+)<\/h3>/) ?? [])[1] ?? ""),
			price: parsePrice(priceText),
			address: decode(
				(chunk.match(/property__list-item-address[^>]*>([^<]+)/) ?? [])[1] ??
					"",
			),
			category:
				decode(
					(chunk.match(/categories__item[^>]*>([^<]+)</) ?? [])[1] ?? "",
				) || null,
			image: (chunk.match(/<img src="([^"]+)"/) ?? [])[1] ?? null,
		});
	}

	return cards;
}

/** 詳細ページの Nuxt データから座標と掲載日を取る */
function parseDetail(
	html: string,
): Pick<IeichibaItem, "lat" | "lng" | "postDate"> {
	const lat = (html.match(/latitude:"([-\d.]+)"/) ?? [])[1];
	const lng = (html.match(/longitude:"([-\d.]+)"/) ?? [])[1];
	const date = (html.match(/post_date:"(\d{4}-\d{2}-\d{2})/) ?? [])[1];
	return {
		lat: lat ? Number(lat) : null,
		lng: lng ? Number(lng) : null,
		postDate: date ?? null,
	};
}

export async function fetchIeichiba(): Promise<IeichibaItem[]> {
	const cards: Omit<IeichibaItem, "lat" | "lng" | "postDate">[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		const html = await get(
			page === 1 ? LIST_PATH : `${LIST_PATH}/page/${page}`,
		);
		const found = parseCards(html);
		if (found.length === 0) break;
		cards.push(...found);
		await sleep(DELAY_MS);
	}

	// 大半は有償なので、対象になったものだけ詳細を開く
	const targets = cards.filter(
		(card) => Number.isFinite(card.price) && card.price <= MAX_PRICE,
	);
	console.log(
		`家いちば: 一覧 ${cards.length} 件 / ${MAX_PRICE.toLocaleString()}円以下 ${targets.length} 件`,
	);

	const items: IeichibaItem[] = [];
	for (const card of targets) {
		await sleep(DELAY_MS);
		const detail = await get(card.url.replace(BASE, ""));
		items.push({ ...card, ...parseDetail(detail) });
	}

	await Bun.write(RAW_FILE, JSON.stringify(items, null, "\t"));
	console.log(`${RAW_FILE} 保存完了 (${items.length} 件)`);
	return items;
}

export async function readRaw(): Promise<IeichibaItem[]> {
	const file = Bun.file(RAW_FILE);
	if (!(await file.exists())) return [];
	return JSON.parse(await file.text()) as IeichibaItem[];
}

const PREF_RE =
	/^(北海道|東京都|京都府|大阪府|.{2,3}県)(.*?郡.*?[町村]|.*?[市区町村])?(.*)$/;

/** 詳細ページに座標が無かったものだけ住所検索に回す */
export function addressesOf(items: IeichibaItem[]): string[] {
	return items
		.filter((item) => !Number.isFinite(item.lat) || !Number.isFinite(item.lng))
		.map((item) => {
			const parts = item.address.match(PREF_RE);
			return normalizeAddress(
				parts?.[1] ?? "",
				parts?.[2] ?? "",
				parts?.[3] ?? "",
			);
		})
		.filter(Boolean);
}

export function toMapProperties(
	items: IeichibaItem[],
	geo: GeoCache = {},
): {
	properties: MapProperty[];
	unmapped: number;
} {
	const properties: MapProperty[] = [];
	let unmapped = 0;

	for (const item of items) {
		const parts = item.address.match(PREF_RE);
		let lat = item.lat;
		let lng = item.lng;
		let approx: string | null = null;

		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			const hit =
				geo[
					normalizeAddress(parts?.[1] ?? "", parts?.[2] ?? "", parts?.[3] ?? "")
				];
			if (!hit) {
				unmapped++;
				continue;
			}
			({ lat, lng } = hit);
			approx = hit.title;
		}

		properties.push({
			id: `ie:${item.id}`,
			source: SOURCE,
			url: item.url,
			title: item.title,
			// 掲載が続いているものだけ一覧に出るので募集中として扱う
			status: "募集中",
			type: /古民家|空き家|一軒家|住宅|建物|マンション/.test(
				`${item.title} ${item.category ?? ""}`,
			)
				? "土地・建物"
				: "土地のみ",
			prefecture: parts?.[1] ?? "",
			city: parts?.[2] ?? "",
			region: "",
			address: parts?.[3] ?? "",
			lat: lat as number,
			lng: lng as number,
			price: item.price,
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: item.category ? [item.category] : [],
			publishedAt: new Date(
				`${item.postDate ?? "2020-01-01"}T00:00:00+09:00`,
			).toISOString(),
			image: item.image,
			approx,
		});
	}

	return { properties, unmapped };
}
