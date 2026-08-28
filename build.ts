/**
 * 取得 → 住所検索 → map.json の生成。
 *
 * CLI (app.ts) からも、常駐サーバの定期実行 (server.ts) からも呼ぶ。
 */

import { geocodeMissing, loadCache } from "./geocode.ts";
import { SOURCES } from "./sources/index.ts";
import type { MapProperty } from "./types.ts";

/** 生成物の置き場。取得した生データも地図が読む JSON もここに入る */
export const OUT_FILE = "data/map.json";

/**
 * 取得元ごとに言い方が違うだけで同じ状態を指すものがあるので、揃えてから地図に出す。
 * フィールドマッチングの「公開中」は他サイトの「募集中」、
 * 同じく「交渉中」は負動産の掲示板の「商談中」にあたる。
 */
const STATUS_ALIASES: Record<string, string> = {
	公開中: "募集中",
	交渉中: "商談中",
};

const normalizeStatus = (status: string): string =>
	STATUS_ALIASES[status] ?? status;

/** zero.estate の画像はすべてこの R2 バケット配下なので、共通部分は JSON から省く */
const IMAGE_BASE = "https://pub-a219a93f532e41ea8c7013e00d34c61b.r2.dev/";

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
			property.status = normalizeStatus(property.status);
		}
		properties.push(...result.properties);
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
