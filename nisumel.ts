/**
 * NISUMEL ニスメル（株式会社いち・エステート）から物件を取得する。
 *
 * WordPress の REST API が開いている。物件はカテゴリ 23〜25（住居・土地・農地山林）の投稿で、
 * 本文の「物件概要」が <table> の見出しセル2列（項目・値）になっている。
 * 座標は無いので geocode.ts で住所から引く。
 */

import { type GeoCache, normalizeAddress } from "./geocode.ts";
import type { MapProperty } from "./types.ts";

const BASE = "https://ichi-estate.com";
const SOURCE = "nisumel";
const RAW_FILE = "data-nisumel.json";
/** 《住居・建物》《土地・宅地》《農地・山林》。地域カテゴリや読み物は含めない */
const CATEGORIES = "23,24,25";

const USER_AGENT =
	"zero-owner/1.0 (personal map project; +https://github.com/5ym/zero-owner)";

export type NisumelPost = {
	id: number;
	date: string;
	link: string;
	title: { rendered: string };
	content: { rendered: string };
	_embedded?: { "wp:featuredmedia"?: { source_url?: string }[] };
};

export async function fetchNisumel(): Promise<NisumelPost[]> {
	const params = new URLSearchParams({
		categories: CATEGORIES,
		per_page: "100",
		_embed: "wp:featuredmedia",
	});
	const res = await fetch(`${BASE}/wp-json/wp/v2/posts?${params}`, {
		headers: { "user-agent": USER_AGENT, accept: "application/json" },
	});
	if (!res.ok) throw new Error(`NISUMEL: HTTP ${res.status}`);

	const posts = (await res.json()) as NisumelPost[];
	await Bun.write(RAW_FILE, JSON.stringify(posts, null, "\t"));
	console.log(`${RAW_FILE} 保存完了 (${posts.length} 件)`);
	return posts;
}

export async function readRaw(): Promise<NisumelPost[]> {
	const file = Bun.file(RAW_FILE);
	if (!(await file.exists())) return [];
	return JSON.parse(await file.text()) as NisumelPost[];
}

/* ---------- 本文の解析 ---------- */

const clean = (html: string) =>
	html
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&#8212;/g, "-")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ")
		.trim();

/** 物件概要のテーブルは <tr> に「項目セル・値セル」が並んでいる */
function summary(html: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
		const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(
			(c) => clean(c[1]),
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
	const title = clean(rendered);
	const head = title.split(/[｜|]/)[0].replace(/^\s*\d+\.\s*/, "");
	const match = head.match(
		/(北海道|東京都|京都府|大阪府|.{2,3}県)\s*(.*?[市区町村])?/,
	);
	return {
		title,
		prefecture: match?.[1] ?? "",
		city: match?.[2] ?? "",
	};
}

export function addressOf(post: NisumelPost): string {
	const { prefecture, city } = titleParts(post.title.rendered);
	if (!prefecture) return "";
	const rest = summary(post.content.rendered)["所在地"] ?? "";
	return normalizeAddress(prefecture, city, rest);
}

function priceOf(text: string): number {
	const normalized = (text ?? "").replace(/[０-９]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0),
	);
	const yen = normalized.match(/([\d,]+)\s*円/);
	return yen ? Number(yen[1].replace(/,/g, "")) : 0;
}

export function toMapProperties(
	posts: NisumelPost[],
	geo: GeoCache = {},
): { properties: MapProperty[]; unmapped: number } {
	const properties: MapProperty[] = [];
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
		const category = table["分類"] ?? "";

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
			region: "",
			address: table["所在地"] ?? "",
			lat: hit.lat,
			lng: hit.lng,
			price: priceOf(table["価格"] ?? ""),
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: [table["現況"], table["地目"]].filter(
				(n): n is string => Boolean(n) && n !== "-",
			),
			publishedAt: new Date(`${post.date}+09:00`).toISOString(),
			image: post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null,
			approx: hit.title,
		});
	}

	return { properties, unmapped };
}
