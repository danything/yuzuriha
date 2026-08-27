/**
 * 負動産の掲示板（合同会社 負動産の窓口）から物件を取得する。
 *
 * WordPress の REST API がそのまま開いているので、カテゴリ指定で投稿を取るだけ。
 * 1リクエスト100件まで。認証は不要。
 *
 * 掲載は「住所については現地見学の際にご案内します」という方針で、番地は伏せられている。
 * 座標も無いので、公開されている大字までの住所を geocode.ts で引いて地図に置く。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { MapProperty } from "../types.ts";

const BASE = "https://souzokutochi-kokkokizoku.com/deflug";
const SOURCE = "makedosan";
const RAW_FILE = "data-makedosan.json";

const USER_AGENT =
	"zero-owner/1.0 (personal map project; +https://github.com/5ym/zero-owner)";
const DELAY_MS = Number(Bun.env.FETCH_DELAY_MS ?? 700);

/** カテゴリIDが掲載状況を表す */
const CATEGORIES: Record<number, string> = {
	43: "募集中",
	42: "商談中",
	41: "成約済み",
};

export type MakedosanPost = {
	id: number;
	date: string;
	link: string;
	title: { rendered: string };
	content: { rendered: string };
	categories: number[];
	_embedded?: { "wp:featuredmedia"?: { source_url?: string }[] };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPage(
	category: number,
	page: number,
): Promise<{ posts: MakedosanPost[]; totalPages: number }> {
	const params = new URLSearchParams({
		categories: String(category),
		per_page: "100",
		page: String(page),
		_embed: "wp:featuredmedia",
	});
	const res = await fetch(`${BASE}/wp-json/wp/v2/posts?${params}`, {
		headers: { "user-agent": USER_AGENT, accept: "application/json" },
	});
	if (!res.ok) {
		throw new Error(
			`負動産の掲示板 カテゴリ${category} ${page}ページ目: HTTP ${res.status}`,
		);
	}
	return {
		posts: (await res.json()) as MakedosanPost[],
		totalPages: Number(res.headers.get("x-wp-totalpages") ?? 1),
	};
}

export async function fetchMakedosan(): Promise<MakedosanPost[]> {
	const posts: MakedosanPost[] = [];

	for (const category of Object.keys(CATEGORIES).map(Number)) {
		const first = await fetchPage(category, 1);
		posts.push(...first.posts);

		for (let page = 2; page <= first.totalPages; page++) {
			await sleep(DELAY_MS);
			const next = await fetchPage(category, page);
			posts.push(...next.posts);
		}
		console.log(`  ${CATEGORIES[category]}: ${first.posts.length} 件〜`);
		await sleep(DELAY_MS);
	}

	await Bun.write(RAW_FILE, JSON.stringify(posts, null, "\t"));
	console.log(`${RAW_FILE} 保存完了 (${posts.length} 件)`);
	return posts;
}

export async function readRaw(): Promise<MakedosanPost[]> {
	const file = Bun.file(RAW_FILE);
	if (!(await file.exists())) return [];
	return JSON.parse(await file.text()) as MakedosanPost[];
}

/* ---------- 本文の解析 ---------- */

const stripTags = (html: string) =>
	html
		.replace(/<br\s*\/?>/g, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&#8211;/g, "-")
		.trim();

/** 記事は <h2>見出し</h2><p>値</p> の繰り返しになっている */
function sections(html: string): Record<string, string> {
	const map: Record<string, string> = {};
	const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g;
	for (const match of html.matchAll(re)) {
		map[stripTags(match[1]).replace(/[【】]/g, "")] = stripTags(match[2]);
	}
	return map;
}

const PREF_RE =
	/(北海道|東京都|京都府|大阪府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)/;

/** 「山形県尾花沢市大字延沢」を都道府県・市区町村・それ以降に割る */
export function splitAddress(text: string): {
	prefecture: string;
	city: string;
	rest: string;
} {
	const cleaned = text.replace(/\s+/g, "").replace(/※.*$/, "");
	const pref = cleaned.match(PREF_RE);
	if (!pref) return { prefecture: "", city: "", rest: cleaned };

	const after = cleaned.slice(cleaned.indexOf(pref[1]) + pref[1].length);
	// 郡がある場合は郡＋町村までを市区町村として扱う
	const city = after.match(/^(.+?郡.+?[町村]|.+?[市区町村])/);
	return {
		prefecture: pref[1],
		city: city ? city[1] : "",
		rest: city ? after.slice(city[1].length) : after,
	};
}

/** 表記ゆれが多いので、住所は本文とタイトルの両方から拾う */
export function addressOf(post: MakedosanPost): string {
	const s = sections(post.content.rendered);
	const body = s.物件概要 ?? "";
	const shozai =
		(body.match(/所在[：:]\s*(.+)/) ?? [])[1] ?? s.住所?.split("\n")[0] ?? "";

	// タイトルの【】にも所在地が入っている（本文に都道府県が無いことがある）
	const inTitle =
		(stripTags(post.title.rendered).match(/【(.+?)】/) ?? [])[1] ?? "";

	const primary = splitAddress(shozai);
	const fallback = splitAddress(inTitle);

	const prefecture = primary.prefecture || fallback.prefecture;
	// 掲示板には物件ではないカテゴリ案内の記事も混ざる。住所が取れないものは対象外
	if (!prefecture) return "";

	const city = primary.city || fallback.city;
	const rest = (primary.prefecture ? primary.rest : shozai) || fallback.rest;

	return normalizeAddress(prefecture, city, rest.replace(/^[、,]/, ""));
}

function propertyType(s: Record<string, string>, title: string): string {
	const building = s.建物の有無 ?? "";
	if (building.includes("建物なし")) return "土地のみ";
	if (building.includes("建物あり")) return "土地・建物";
	if (/古民家|空き家|建物/.test(title)) return "土地・建物";
	if (/土地|山林|農地|田畑|原野|宅地/.test(title)) return "土地のみ";
	return "その他";
}

/** 「０円」など全角が混ざるので数値に均す */
function priceOf(s: Record<string, string>): number {
	const text = s.譲渡代金 ?? s.取引金額 ?? s.譲渡条件 ?? "";
	const normalized = text.replace(/[０-９]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0),
	);
	const yen = normalized.match(/([\d,]+)\s*円/);
	// 掲示板は0円譲渡が前提。読めなければ0円として扱う
	return yen ? Number(yen[1].replace(/,/g, "")) : 0;
}

export function toMapProperties(
	posts: MakedosanPost[],
	geo: GeoCache = {},
): { properties: MapProperty[]; unmapped: number } {
	const properties: MapProperty[] = [];
	let unmapped = 0;

	for (const post of posts) {
		const address = addressOf(post);
		const hit = address ? geo[address] : null;
		if (!hit) {
			unmapped++;
			continue;
		}

		const s = sections(post.content.rendered);
		const title = stripTags(post.title.rendered);
		const status =
			CATEGORIES[post.categories.find((c) => c in CATEGORIES) ?? 0] ?? "募集中";
		const split = splitAddress(address);

		properties.push({
			id: `md:${post.id}`,
			source: SOURCE,
			url: post.link,
			title,
			status,
			type: propertyType(s, title),
			prefecture: split.prefecture,
			city: split.city,
			region: "",
			address: split.rest,
			lat: hit.lat,
			lng: hit.lng,
			price: priceOf(s),
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: [],
			// 投稿日時は JST で timezone が付いていない
			publishedAt: new Date(`${post.date}+09:00`).toISOString(),
			image: post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null,
			approx: hit.title,
		});
	}

	return { properties, unmapped };
}
