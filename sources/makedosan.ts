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
import type { SourceProperty } from "../types.ts";
import {
	jstToIso,
	parsePrice,
	readRaw as readRawFile,
	saveRaw,
	sleep,
	splitAddress,
	stripTags,
	type WpPost,
	wpImage,
	wpPosts,
} from "./common.ts";

const BASE = "https://souzokutochi-kokkokizoku.com/deflug";
const SOURCE = "makedosan";
const RAW_FILE = "data/makedosan.json";

/** カテゴリIDが掲載状況を表す */
const CATEGORIES: Record<number, string> = {
	43: "募集中",
	42: "商談中",
	41: "成約済み",
};

export type MakedosanPost = WpPost & { categories: number[] };

export async function fetchMakedosan(): Promise<MakedosanPost[]> {
	const posts: MakedosanPost[] = [];

	for (const category of Object.keys(CATEGORIES).map(Number)) {
		const label = `負動産の掲示板 ${CATEGORIES[category]}`;
		const first = await wpPosts<MakedosanPost>(
			BASE,
			{ categories: String(category), page: "1" },
			label,
		);
		posts.push(...first.posts);

		for (let page = 2; page <= first.totalPages; page++) {
			await sleep();
			const next = await wpPosts<MakedosanPost>(
				BASE,
				{ categories: String(category), page: String(page) },
				label,
			);
			posts.push(...next.posts);
		}
		console.log(`  ${CATEGORIES[category]}: ${first.posts.length} 件〜`);
		await sleep();
	}

	return await saveRaw(RAW_FILE, posts);
}

export const readRaw = () => readRawFile<MakedosanPost>(RAW_FILE);

/* ---------- 本文の解析 ---------- */

/** 記事は <h2>見出し</h2><p>値</p> の繰り返しになっている */
function sections(html: string): Record<string, string> {
	const map: Record<string, string> = {};
	const re = /<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)(?=<h2|$)/g;
	for (const match of html.matchAll(re)) {
		// 値は行ごとに読むので改行を残す
		map[stripTags(match[1]).replace(/[【】]/g, "")] = stripTags(match[2], true);
	}
	return map;
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

export function toMapProperties(
	posts: MakedosanPost[],
	geo: GeoCache = {},
): { properties: SourceProperty[]; unmapped: number } {
	const properties: SourceProperty[] = [];
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
			address: split.rest,
			lat: hit.lat,
			lng: hit.lng,
			// 掲示板は0円譲渡が前提。読めなければ0円として扱う
			price: parsePrice(s.譲渡代金 ?? s.取引金額 ?? s.譲渡条件 ?? "", 0),
			builtYear: null,
			views: 0,
			favorites: 0,
			notes: [],
			publishedAt: jstToIso(post.date),
			image: wpImage(post),
			approx: hit.title,
		});
	}

	return { properties, unmapped };
}
