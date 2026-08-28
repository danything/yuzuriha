/**
 * NISUMEL ニスメル（株式会社いち・エステート）から物件を取得する。
 *
 * WordPress の REST API が開いている。物件はカテゴリ 23〜25（住居・土地・農地山林）の投稿で、
 * 本文の「物件概要」が <table> の見出しセル2列（項目・値）になっている。
 * 座標は無いので geocode.ts で住所から引く。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { SourceProperty } from "../types.ts";
import {
	jstToIso,
	parsePrice,
	readRaw as readRawFile,
	saveRaw,
	splitAddress,
	stripTags,
	type WpPost,
	wpImage,
	wpPosts,
} from "./common.ts";

const BASE = "https://ichi-estate.com";
const SOURCE = "nisumel";
const RAW_FILE = "data/nisumel.json";
/** 《住居・建物》《土地・宅地》《農地・山林》。地域カテゴリや読み物は含めない */
const CATEGORIES = "23,24,25";

export type NisumelPost = WpPost;

export async function fetchNisumel(): Promise<NisumelPost[]> {
	const { posts } = await wpPosts<NisumelPost>(
		BASE,
		{ categories: CATEGORIES },
		"NISUMEL",
	);
	return await saveRaw(RAW_FILE, posts);
}

export const readRaw = () => readRawFile<NisumelPost>(RAW_FILE);

/* ---------- 本文の解析 ---------- */

/** 物件概要のテーブルは <tr> に「項目セル・値セル」が並んでいる */
function summary(html: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(
			(c) => stripTags(c[1]),
		);
		if (cells.length >= 2 && cells[0]) map[cells[0]] = cells[1];
	}
	return map;
}

/** タイトルは「15. 静岡県 熱海市｜熱海の別荘地 526㎡の土地が0円」の形 */
function titleParts(rendered: string): {
	title: string;
	prefecture: string;
	city: string;
} {
	const title = stripTags(rendered);
	const head = title.split(/[｜|]/)[0].replace(/^\s*\d+\.\s*/, "");
	const { prefecture, city } = splitAddress(head);
	return { title, prefecture, city };
}

export function addressOf(post: NisumelPost): string {
	const { prefecture, city } = titleParts(post.title.rendered);
	if (!prefecture) return "";
	const rest = summary(post.content.rendered).所在地 ?? "";
	return normalizeAddress(prefecture, city, rest);
}

export function toMapProperties(
	posts: NisumelPost[],
	geo: GeoCache = {},
): { properties: SourceProperty[]; unmapped: number } {
	const properties: SourceProperty[] = [];
	let unmapped = 0;

	for (const post of posts) {
		// 「愛知｜空家 サンプル」などの見本投稿は物件ではない
		if (post.title.rendered.includes("サンプル")) continue;

		const address = addressOf(post);
		const hit = address ? geo[address] : null;
		if (!hit) {
			unmapped++;
			continue;
		}

		const table = summary(post.content.rendered);
		const { title, prefecture, city } = titleParts(post.title.rendered);
		const category = table.分類 ?? "";

		properties.push({
			id: `ni:${post.id}`,
			source: SOURCE,
			url: post.link,
			title,
			// 掲載が続いている間は募集中として扱う（成約済みは取り下げられる）
			status: "募集中",
			type: category.includes("建物")
				? "土地・建物"
				: category.includes("土地")
					? "土地のみ"
					: (category ?? "その他"),
			prefecture,
			city,
			address: table.所在地 ?? "",
			lat: hit.lat,
			lng: hit.lng,
			price: parsePrice(table.価格 ?? "", 0),
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: [table.現況, table.地目].filter(
				(n): n is string => Boolean(n) && n !== "-",
			),
			publishedAt: jstToIso(post.date),
			image: wpImage(post),
			approx: hit.title,
		});
	}

	return { properties, unmapped };
}
