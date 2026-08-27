/**
 * 0円物件を各サイトから集めて、地図が読む map.json を作る。
 *
 * 取得元は sources/ に1ファイルずつ置いて sources/index.ts の SOURCES に並べている。
 */

import { geocodeMissing, loadCache } from "./geocode.ts";
import { findSource, generateCsv, SOURCES } from "./sources/index.ts";
import type { MapProperty } from "./types.ts";

/** zero.estate の画像はすべてこの R2 バケット配下なので、共通部分は JSON から省く */
const IMAGE_BASE = "https://pub-a219a93f532e41ea8c7013e00d34c61b.r2.dev/";

/** 取得元ごとの生データを1つの map.json にまとめる */
async function generateJson() {
	const geo = await loadCache();
	const properties: MapProperty[] = [];
	const sources: { name: string; label: string; url: string; count: number }[] =
		[];
	let unmapped = 0;
	let filtered = 0;

	for (const source of SOURCES) {
		const result = source.toMapProperties(await source.readRaw(), geo);
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
		"map.json",
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
		`map.json 出力完了 (${properties.length} 件 / うち住所から推定 ${approx} 件 / ` +
			`座標なし ${unmapped} 件${filtered ? ` / 価格で除外 ${filtered} 件` : ""})`,
	);
	for (const source of sources) {
		console.log(`  ${source.label}: ${source.count} 件`);
	}
}

/** 座標を持たない物件の住所をまとめて引く */
async function runGeocode() {
	const queries: string[] = [];
	for (const source of SOURCES) {
		queries.push(...source.addressesOf(await source.readRaw()));
	}
	await geocodeMissing(queries);
}

/** 取得できない取得元があっても、残りで地図は作れるようにする */
async function fetchAll() {
	for (const source of SOURCES) {
		try {
			await source.fetch();
		} catch (error) {
			console.warn(`${source.label}: ${(error as Error).message}`);
		}
	}
}

const [command, argument] = process.argv.slice(2);

if (!command) {
	await fetchAll();
	await runGeocode();
	await generateJson();
} else if (command === "fetch") {
	// 取得元を指定しなければ全部
	const source = argument ? findSource(argument) : null;
	if (argument && !source) {
		console.error(
			`不明な取得元: ${argument}（${SOURCES.map((s) => s.command).join(", ")}）`,
		);
		process.exit(1);
	}
	if (source) await source.fetch();
	else await fetchAll();
} else if (command === "geocode") {
	await runGeocode();
} else if (command === "json") {
	await generateJson();
} else if (command === "csv") {
	await generateCsv();
} else {
	console.log("使い方:");
	console.log("  bun app.ts              # 取得 → 住所検索 → map.json");
	console.log("  bun app.ts fetch        # すべての取得元から取得する");
	console.log("  bun app.ts fetch <名前> # 1つの取得元だけ取得する");
	console.log("  bun app.ts geocode      # 座標が無い物件の住所を引く");
	console.log("  bun app.ts json         # 生データから map.json を作る");
	console.log(
		"  bun app.ts csv          # zero.estate の生データから CSV を作る",
	);
	console.log("");
	console.log("取得元:");
	for (const source of SOURCES) {
		console.log(`  ${source.command.padEnd(4)} ${source.label}`);
	}
}
