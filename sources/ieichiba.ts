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
import type { SourceProperty } from "../types.ts";
import {
	getText,
	jstToIso,
	parsePrice,
	readRaw as readRawFile,
	saveRaw,
	sleep,
	splitAddress,
	stripTags,
} from "./common.ts";

const BASE = "https://ieichiba.com";
const SOURCE = "ieichiba";
const RAW_FILE = "data/ieichiba.json";
/** 0円〜100万円未満のタグ。ここから価格で絞る */
const LIST_PATH = "/tags/0-100manyen";
const MAX_PAGES = 30;
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

type Card = Omit<IeichibaItem, "lat" | "lng" | "postDate">;

const get = (path: string) => getText(`${BASE}${path}`, `家いちば ${path}`);

/** 一覧ページの物件カードを読む */
function parseCards(html: string): Card[] {
	const cards: Card[] = [];

	for (const chunk of html.split('<a href="/project/').slice(1)) {
		const href = (chunk.match(/^([^"]+)"/) ?? [])[1];
		const id = (chunk.match(/data-property-id="([^"]+)"/) ?? [])[1];
		const priceText = (chunk.match(/property__list-item-price[^>]*>([^<]+)/) ??
			[])[1];
		if (!href || !id || !priceText) continue;

		cards.push({
			id,
			url: `${BASE}/project/${href}`,
			title: stripTags((chunk.match(/<h3[^>]*>([^<]+)<\/h3>/) ?? [])[1] ?? ""),
			price: parsePrice(priceText),
			address: stripTags(
				(chunk.match(/property__list-item-address[^>]*>([^<]+)/) ?? [])[1] ??
					"",
			),
			category:
				stripTags(
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
	const cards: Card[] = [];

	for (let page = 1; page <= MAX_PAGES; page++) {
		const html = await get(
			page === 1 ? LIST_PATH : `${LIST_PATH}/page/${page}`,
		);
		const found = parseCards(html);
		if (found.length === 0) break;
		cards.push(...found);
		await sleep();
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
		await sleep();
		const detail = await get(card.url.replace(BASE, ""));
		items.push({ ...card, ...parseDetail(detail) });
	}

	return await saveRaw(RAW_FILE, items);
}

export const readRaw = () => readRawFile<IeichibaItem>(RAW_FILE);

const hasCoords = (item: IeichibaItem) =>
	Number.isFinite(item.lat) && Number.isFinite(item.lng);

const queryOf = (item: IeichibaItem) => {
	const { prefecture, city, rest } = splitAddress(item.address);
	return normalizeAddress(prefecture, city, rest);
};

/** 詳細ページに座標が無かったものだけ住所検索に回す */
export function addressesOf(items: IeichibaItem[]): string[] {
	return items
		.filter((item) => !hasCoords(item))
		.map(queryOf)
		.filter(Boolean);
}

export function toMapProperties(
	items: IeichibaItem[],
	geo: GeoCache = {},
): {
	properties: SourceProperty[];
	unmapped: number;
} {
	const properties: SourceProperty[] = [];
	let unmapped = 0;

	for (const item of items) {
		const { prefecture, city, rest } = splitAddress(item.address);
		let { lat, lng } = item;
		let approx: string | null = null;

		if (!hasCoords(item)) {
			const hit = geo[queryOf(item)];
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
			prefecture,
			city,
			address: rest,
			lat: lat as number,
			lng: lng as number,
			price: item.price,
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: item.category ? [item.category] : [],
			publishedAt: jstToIso(item.postDate ?? "2020-01-01"),
			image: item.image,
			approx,
		});
	}

	return { properties, unmapped };
}
