import {
	fetchFieldMatching,
	addressOf as fieldMatchingAddress,
	toMapProperties as fieldMatchingToMap,
	readRaw as readFieldMatchingRaw,
} from "./fieldmatching.ts";
import {
	type GeoCache,
	geocodeMissing,
	loadCache,
	normalizeAddress,
} from "./geocode.ts";
import {
	fetchMakedosan,
	addressOf as makedosanAddress,
	toMapProperties as makedosanToMap,
	readRaw as readMakedosanRaw,
} from "./makedosan.ts";
import {
	fetchNisumel,
	addressOf as nisumelAddress,
	toMapProperties as nisumelToMap,
	readRaw as readNisumelRaw,
} from "./nisumel.ts";
import type { MapProperty } from "./types.ts";
import {
	fetchZenkokuZeroen,
	readRaw as readZenkokuRaw,
	addressOf as zenkokuAddress,
	toMapProperties as zenkokuToMap,
} from "./zenkokuzeroen.ts";

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

type Items = {
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
async function fetchAll() {
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

	await Bun.write("data.json", JSON.stringify(results, null, "\t"));
	console.log("data.json 保存完了");
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
function zeroEstateAddress(item: Items): string {
	return normalizeAddress(
		item.prefecture ?? "",
		item.city ?? "",
		item.address ?? "",
	);
}

/** zero.estate の生データを地図用に整える */
function zeroEstateToMap(
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
			const hit = geo[zeroEstateAddress(item)];
			if (!hit) {
				unmapped++;
				continue;
			}
			({ lat, lng } = hit);
			approx = hit.title;
		}

		properties.push({
			id: `zero:${item.id}`,
			source: "zero.estate",
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

/** 取得元ごとの生データを1つの map.json にまとめる */
async function generateJson() {
	const zeroFile = Bun.file("data.json");
	const zeroItems = (await zeroFile.exists())
		? (JSON.parse(await zeroFile.text()) as Items[])
		: [];
	const fmItems = await readFieldMatchingRaw();
	const geo = await loadCache();

	const mdPosts = await readMakedosanRaw();
	const niPosts = await readNisumelRaw();
	const zzItems = await readZenkokuRaw();

	const zero = zeroEstateToMap(zeroItems, geo);
	const fm = fieldMatchingToMap(fmItems, geo);
	const md = makedosanToMap(mdPosts, geo);
	const ni = nisumelToMap(niPosts, geo);
	const zz = zenkokuToMap(zzItems, geo);

	const properties = [
		...zero.properties,
		...fm.properties,
		...md.properties,
		...ni.properties,
		...zz.properties,
	].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

	const sources = [
		{
			name: "zero.estate",
			label: "みんなの0円物件",
			url: "https://zero.estate/",
			count: zero.properties.length,
		},
		{
			name: "fieldmatching",
			label: "フィールドマッチング",
			url: "https://fieldmatching.klc1809.com/",
			count: fm.properties.length,
		},
		{
			name: "makedosan",
			label: "負動産の掲示板",
			url: "https://souzokutochi-kokkokizoku.com/deflug/",
			count: md.properties.length,
		},
		{
			name: "nisumel",
			label: "NISUMEL",
			url: "https://ichi-estate.com/",
			count: ni.properties.length,
		},
		{
			name: "zenkokuzeroen",
			label: "全国０円不動産",
			url: "https://zenkokuzeroen-fudosan.com/",
			count: zz.properties.length,
		},
	].filter((source) => source.count > 0);

	await Bun.write(
		"map.json",
		JSON.stringify({
			generatedAt: new Date().toISOString(),
			total: properties.length,
			unmapped:
				zero.unmapped + fm.unmapped + md.unmapped + ni.unmapped + zz.unmapped,
			imageBase: IMAGE_BASE,
			sources,
			properties,
		}),
	);

	const approx = properties.filter((p) => p.approx).length;
	console.log(
		`map.json 出力完了 (${properties.length} 件 / うち住所から推定 ${approx} 件 / ` +
			`座標なし ${zero.unmapped + fm.unmapped + md.unmapped + ni.unmapped + zz.unmapped} 件` +
			`${fm.filtered ? ` / 価格で除外 ${fm.filtered} 件` : ""})`,
	);
	for (const source of sources)
		console.log(`  ${source.label}: ${source.count} 件`);
}

/** 座標を持たない物件の住所をまとめて引く */
async function runGeocode() {
	const zeroFile = Bun.file("data.json");
	const zeroItems = (await zeroFile.exists())
		? (JSON.parse(await zeroFile.text()) as Items[])
		: [];

	const queries = [
		...zeroItems
			.filter((item) => !item.latitude && !item.approximateLatitude)
			.map(zeroEstateAddress),
		...(await readFieldMatchingRaw())
			.filter((item) => !item.lat || !item.lng)
			.map(fieldMatchingAddress),
		// 以下は掲載側が座標を持たないので全件を住所から引く
		...(await readMakedosanRaw()).map(makedosanAddress),
		...(await readNisumelRaw())
			.filter((post) => !post.title.rendered.includes("サンプル"))
			.map(nisumelAddress),
		...(await readZenkokuRaw()).map(zenkokuAddress),
	];

	await geocodeMissing(queries);
}

// -----------------------------
// 4. data.json を読み込んで CSV を生成
// -----------------------------
async function generateCsv() {
	const file = Bun.file("data.json");
	const text = await file.text();
	const items = JSON.parse(text) as Items[];

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

// -----------------------------
// 5. bun run app.ts <command>
// -----------------------------
const command = process.argv[2];

if (!command) {
	// ★ オプション無し → 取得 + 地図用 JSON 生成
	await fetchAll();
	await generateJson();
} else if (command === "fetch") {
	await fetchAll();
} else if (command === "fetch-fm") {
	await fetchFieldMatching();
} else if (command === "fetch-md") {
	await fetchMakedosan();
} else if (command === "fetch-ni") {
	await fetchNisumel();
} else if (command === "fetch-zz") {
	await fetchZenkokuZeroen();
} else if (command === "geocode") {
	await runGeocode();
} else if (command === "json") {
	await generateJson();
} else if (command === "csv") {
	await generateCsv();
} else {
	console.log("使い方:");
	console.log(
		"  bun run app.ts           # zero.estate を取得して json を作る",
	);
	console.log("  bun run app.ts fetch     # zero.estate から data.json を作る");
	console.log(
		"  bun run app.ts fetch-fm  # フィールドマッチングから data-fieldmatching.json を作る",
	);
	console.log(
		"  bun run app.ts fetch-md  # 負動産の掲示板から data-makedosan.json を作る",
	);
	console.log("  bun run app.ts fetch-ni  # NISUMEL から取得する");
	console.log("  bun run app.ts fetch-zz  # 全国０円不動産 から取得する");
	console.log(
		"  bun run app.ts geocode   # 座標が無い物件の住所を国土地理院APIで引く",
	);
	console.log(
		"  bun run app.ts json      # 生データから地図用 map.json を作る",
	);
	console.log("  bun run app.ts csv       # data.json から CSV を作る");
}
