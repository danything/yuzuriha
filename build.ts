/**
 * 取得 → 住所検索 → map.json の生成。
 *
 * CLI (app.ts) からも、常駐サーバの定期実行 (server.ts) からも呼ぶ。
 * 取得元ごとの言い方の違い（ステータス・地方）は、ここで揃えてから地図に渡す。
 */

import { geocodeMissing, loadCache } from "./geocode.ts";
import { SOURCES } from "./sources/index.ts";
import { IMAGE_BASE } from "./sources/zero-estate.ts";
import type { MapProperty } from "./types.ts";

/** 生成物の置き場。取得した生データも地図が読む JSON もここに入る */
export const OUT_FILE = "data/map.json";

/**
 * 同じ状態を指すのに言い方が違うものがあるので、揃えてから地図に出す。
 * フィールドマッチングの「公開中」は他サイトの「募集中」、
 * 同じく「交渉中」は負動産の掲示板の「商談中」にあたる。
 */
const STATUS_ALIASES: Record<string, string> = {
	公開中: "募集中",
	交渉中: "商談中",
};

/**
 * 地方は都道府県から引く。
 * zero.estate だけが自前で持っているが、同じ県に「中部」と「東海」が混ざるなど
 * 揺れているので、掲載側の値は使わない。
 */
const REGIONS: Record<string, string> = {
	北海道: "北海道",
	東北: "青森 岩手 宮城 秋田 山形 福島",
	関東: "茨城 栃木 群馬 埼玉 千葉 東京 神奈川",
	甲信越: "新潟 山梨 長野",
	北陸: "富山 石川 福井",
	東海: "岐阜 静岡 愛知 三重",
	近畿: "滋賀 京都 大阪 兵庫 奈良 和歌山",
	中国: "鳥取 島根 岡山 広島 山口",
	四国: "徳島 香川 愛媛 高知",
	"九州・沖縄": "福岡 佐賀 長崎 熊本 大分 宮崎 鹿児島 沖縄",
};

const REGION_OF = new Map(
	Object.entries(REGIONS).flatMap(([region, prefectures]) =>
		prefectures.split(" ").map((prefecture) => [prefecture, region]),
	),
);

/** 掲載側は「東京都」「鹿児島県」の形。北海道だけは接尾辞を落とせない */
const regionOf = (prefecture: string): string =>
	REGION_OF.get(prefecture) ??
	REGION_OF.get(prefecture.replace(/[都府県]$/, "")) ??
	"";

/** 取得元ごとの生データを1つの map.json にまとめる */
export async function generateJson() {
	const geo = await loadCache();
	const properties: MapProperty[] = [];
	const sources: { name: string; label: string; url: string; count: number }[] =
		[];
	let unmapped = 0;
	let filtered = 0;

	for (const source of SOURCES) {
		const result = source.toMapProperties(await source.readRaw(), geo);
		for (const property of result.properties) {
			properties.push({
				...property,
				status: STATUS_ALIASES[property.status] ?? property.status,
				region: regionOf(property.prefecture),
			});
		}
		unmapped += result.unmapped;
		filtered += result.filtered ?? 0;

		if (result.properties.length > 0) {
			sources.push({
				name: source.name,
				label: source.label,
				url: source.url,
				count: result.properties.length,
			});
		}
	}

	properties.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

	await Bun.write(
		OUT_FILE,
		JSON.stringify({
			generatedAt: new Date().toISOString(),
			total: properties.length,
			unmapped,
			// 五十音順に並べると北から南の並びが崩れるので、地方は順番も渡す
			regions: Object.keys(REGIONS).filter((region) =>
				properties.some((property) => property.region === region),
			),
			imageBase: IMAGE_BASE,
			sources,
			properties,
		}),
	);

	const approx = properties.filter((p) => p.approx).length;
	console.log(
		`${OUT_FILE} 出力完了 (${properties.length} 件 / うち住所から推定 ${approx} 件 / ` +
			`座標なし ${unmapped} 件${filtered ? ` / 価格で除外 ${filtered} 件` : ""})`,
	);
	for (const source of sources) {
		console.log(`  ${source.label}: ${source.count} 件`);
	}
}

/** 座標を持たない物件の住所をまとめて引く */
export async function runGeocode() {
	const queries: string[] = [];
	for (const source of SOURCES) {
		queries.push(...source.addressesOf(await source.readRaw()));
	}
	await geocodeMissing(queries);
}

/**
 * 取得できない取得元があっても、残りで地図は作れるようにする。
 * `only` を渡すとその取得元だけを取る。
 */
export async function fetchAll(only?: string[]) {
	const targets = only
		? SOURCES.filter((source) => only.includes(source.command))
		: SOURCES;

	for (const source of targets) {
		try {
			await source.fetch();
		} catch (error) {
			console.warn(`${source.label}: ${(error as Error).message}`);
		}
	}
}

/** 取得から生成まで通しで実行する */
export async function runBuild(only?: string[]) {
	await fetchAll(only);
	await runGeocode();
	await generateJson();
}
