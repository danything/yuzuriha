/**
 * みんなの0円物件（zero.estate / ０円都市開発合同会社）から物件を取得する。
 *
 * ログインして tRPC の property.list を 100 件ずつ巡回する。
 * 利用規約第6条9号により事前の承諾が要るため、承諾の回答が出るまで CI では取得しない。
 */

import { type GeoCache, normalizeAddress } from "../geocode.ts";
import type { MapProperty } from "../types.ts";

const SOURCE = "zero.estate";
const RAW_FILE = "data.json";

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

// -----------------------------
// 1. ログインして Cookie を取得
// -----------------------------
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

// -----------------------------
// 2. API から全件取得して data.json に保存
// -----------------------------
export async function fetchZeroEstate() {
	// 認証情報は環境変数から。ローカルでは .env、CI では Actions の Secrets を使う
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

	await Bun.write(RAW_FILE, JSON.stringify(results, null, "\t"));
	console.log(`${RAW_FILE} 保存完了 (${results.length} 件)`);
	return results;
}

// -----------------------------
// 3. data.json を読み込んで地図用 JSON を生成
// -----------------------------

/** 画像はすべてこの R2 バケット配下なので、共通部分は JSON から省く */
const IMAGE_BASE = "https://pub-a219a93f532e41ea8c7013e00d34c61b.r2.dev/";

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

/** null や空文字を Number() に渡すと 0 になってしまうので明示的に弾く */
function toCoord(value: string | null | undefined): number {
	if (value === null || value === undefined || value.trim() === "")
		return Number.NaN;
	return Number(value);
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
	properties: MapProperty[];
	unmapped: number;
} {
	const properties: MapProperty[] = [];
	let unmapped = 0;

	for (const item of items) {
		let lat = toCoord(item.latitude ?? item.approximateLatitude);
		let lng = toCoord(item.longitude ?? item.approximateLongitude);
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
			region: item.region ?? "",
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

export async function readRaw(): Promise<Items[]> {
	const file = Bun.file(RAW_FILE);
	if (!(await file.exists())) return [];
	return JSON.parse(await file.text()) as Items[];
}

/** 旧形式の CSV。互換のために残してある */
export async function generateCsv() {
	const items = await readRaw();
	const csvFile = Bun.file("map.csv");
	const writer = csvFile.writer();

	writer.write("title,url,status,longitude,latitude,address\n");

	for (const json of items) {
		const longitude = json.longitude ?? json.approximateLongitude ?? "";
		const latitude = json.latitude ?? json.approximateLatitude ?? "";
		const safeAddress =
			json.address?.replace(/\n/g, "\\n") ??
			`${json.prefecture ?? ""}${json.city ?? ""}`;

		writer.write(
			`"${json.title}",https://zero.estate/properties/${json.id},${json.status},${longitude},${latitude},${safeAddress}\n`,
		);
	}

	writer.end();
	console.log("CSV 出力完了");
}
