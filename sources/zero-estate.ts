/**
 * みんなの0円物件（zero.estate / ０円都市開発合同会社）から物件を取得する。
 *
 * ログインして tRPC の property.list を 100 件ずつ巡回する。
 * 利用規約第6条9号により事前の承諾が要るため、承諾の回答が出るまで CI では取得しない。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { SourceProperty } from "../types.ts";
import { readRaw as readRawFile, saveRaw, toNumber } from "./common.ts";

const SOURCE = "zero.estate";
const RAW_FILE = "data/zero-estate.json";

type PropertyImage = {
	id: number;
	propertyId: number;
	imageUrl: string;
	sortOrder: number;
	caption: string | null;
	createdAt: string;
	isDummy: boolean;
	seedBatchId: number | null;
};

export type Items = {
	id: number;
	title: string;
	status: string;
	propertyType: string;
	address: string;
	prefecture: string | null;
	city: string | null;
	region: string | null;
	builtYear: string | null;
	viewCount: number;
	createdAt: string;
	approvedAt: string | null;
	publicStatus: string;
	isSuspended: boolean;
	specialNotes: string | null;
	latitude: string | null;
	longitude: string | null;
	approximateLatitude: string | null;
	approximateLongitude: string | null;
	slug: string | null;
	plan: string;
	images: PropertyImage[];
	ownerName: string | null;
	ownerPrefecture: string | null;
	isFavorite: boolean;
	favoriteCount: number;
};

/* ---------- ログインして Cookie を取得 ---------- */

async function loginAndGetCookie(email: string, password: string) {
	const res = await fetch("https://zero.estate/api/auth/sign-in/email", {
		method: "POST",
		headers: {
			accept: "*/*",
			"accept-language": "ja,en-US;q=0.9,en;q=0.8",
			"cache-control": "no-cache",
			"content-type": "application/json",
			dnt: "1",
			origin: "https://zero.estate",
			pragma: "no-cache",
			priority: "u=1, i",
			referer: "https://zero.estate/login",
			// ★ これが無いと絶対に弾かれる
			"sec-ch-ua":
				'"Microsoft Edge";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"Windows"',
			"sec-fetch-dest": "empty",
			"sec-fetch-mode": "cors",
			"sec-fetch-site": "same-origin",
			"user-agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0",
		},
		body: JSON.stringify({
			email,
			password,
			callbackURL: "/",
		}),
	});

	const cookie = res.headers.get("set-cookie");
	if (!cookie) {
		console.log("レスポンス:", res);
		throw new Error("ログイン失敗: Cookie が取得できません");
	}

	return cookie;
}

/* ---------- 全件取得して生データを保存 ---------- */

export async function fetchZeroEstate() {
	// 認証情報は環境変数から。手元では compose.override.yml、CI では Actions の Secrets
	const email = Bun.env.EMAIL;
	const password = Bun.env.PASSWORD;
	if (!email || !password) {
		throw new Error("環境変数 EMAIL / PASSWORD を設定してください");
	}

	const cookie = await loginAndGetCookie(email, password);

	let page = 1;
	const baseUrl = "https://zero.estate/api/trpc/property.list";
	const results: Items[] = [];

	while (true) {
		const inputJson = {
			"0": {
				json: {
					page,
					limit: 100,
					keyword: null,
					region: null,
					prefecture: null,
					status: null,
					propertyType: null,
					specialNotes: null,
					sortBy: "newest",
					publishedWithin: null,
				},
				meta: {
					values: {
						keyword: ["undefined"],
						region: ["undefined"],
						prefecture: ["undefined"],
						status: ["undefined"],
						propertyType: ["undefined"],
						specialNotes: ["undefined"],
						publishedWithin: ["undefined"],
					},
				},
			},
		};

		const params = new URLSearchParams({
			batch: "1",
			input: JSON.stringify(inputJson),
		});

		const url = `${baseUrl}?${params.toString()}`;

		console.log("request page:", page);

		const ret = await fetch(url, {
			headers: {
				Cookie: cookie,
				"User-Agent": "Mozilla/5.0",
				Accept: "application/json",
			},
		});

		const body = await ret.json();
		const items = body[0].result.data.json.items as Items[];

		if (items.length === 0) break;

		results.push(...items);
		page++;
	}

	return await saveRaw(RAW_FILE, results);
}

export const readRaw = () => readRawFile<Items>(RAW_FILE);

/* ---------- 地図用に整える ---------- */

/** 画像はすべてこの R2 バケット配下なので、共通部分は map.json から省く */
export const IMAGE_BASE =
	"https://pub-a219a93f532e41ea8c7013e00d34c61b.r2.dev/";

/** specialNotes は JSON 文字列の配列として入っている */
function parseNotes(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((n): n is string => typeof n === "string")
			: [];
	} catch {
		return [];
	}
}

function pickImage(images: PropertyImage[] | undefined): string | null {
	const usable = (images ?? [])
		.filter((image) => !image.isDummy && image.imageUrl)
		.sort((a, b) => a.sortOrder - b.sortOrder);

	const url = usable[0]?.imageUrl;
	if (!url) return null;
	return url.startsWith(IMAGE_BASE) ? url.slice(IMAGE_BASE.length) : url;
}

/** 住所検索に投げる形の住所 */
export function addressOf(item: Items): string {
	return normalizeAddress(
		item.prefecture ?? "",
		item.city ?? "",
		item.address ?? "",
	);
}

/** zero.estate の生データを地図用に整える */
export function toMapProperties(
	items: Items[],
	geo: GeoCache = {},
): {
	properties: SourceProperty[];
	unmapped: number;
} {
	const properties: SourceProperty[] = [];
	let unmapped = 0;

	for (const item of items) {
		let lat = toNumber(item.latitude ?? item.approximateLatitude);
		let lng = toNumber(item.longitude ?? item.approximateLongitude);
		let approx: string | null = null;

		// 掲載側に座標が無ければ、住所検索で引いた結果を使う
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			const hit = geo[addressOf(item)];
			if (!hit) {
				unmapped++;
				continue;
			}
			({ lat, lng } = hit);
			approx = hit.title;
		}

		properties.push({
			id: `zero:${item.id}`,
			source: SOURCE,
			url: `https://zero.estate/properties/${item.id}`,
			title: item.title,
			status: item.status,
			type: item.propertyType,
			prefecture: item.prefecture ?? "",
			city: item.city ?? "",
			address: item.address?.replace(/\s*\n\s*/g, " ") ?? "",
			lat,
			lng,
			price: 0,
			builtYear: item.builtYear,
			views: item.viewCount ?? 0,
			favorites: item.favoriteCount ?? 0,
			notes: parseNotes(item.specialNotes),
			publishedAt: item.approvedAt ?? item.createdAt,
			image: pickImage(item.images),
			approx,
		});
	}

	return { properties, unmapped };
}
