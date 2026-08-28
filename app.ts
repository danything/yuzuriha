/**
 * 0円物件を各サイトから集めて、地図が読む map.json を作る CLI。
 *
 * 取得元は sources/ に1ファイルずつ置いて sources/index.ts の SOURCES に並べている。
 * 実処理は build.ts にあり、常駐サーバ (server.ts) からも同じものを呼ぶ。
 */

import { fetchAll, generateJson, runBuild, runGeocode } from "./build.ts";
import { findSource, SOURCES } from "./sources/index.ts";

const [command, argument] = process.argv.slice(2);

if (!command) {
	await runBuild();
} else if (command === "fetch") {
	// 取得元を指定しなければ全部
	const source = argument ? findSource(argument) : null;
	if (argument && !source) {
		console.error(
			`不明な取得元: ${argument}（${SOURCES.map((s) => s.command).join(", ")}）`,
		);
		process.exit(1);
	}
	await fetchAll(source ? [source.command] : undefined);
} else if (command === "geocode") {
	await runGeocode();
} else if (command === "json") {
	await generateJson();
} else {
	console.log("使い方:");
	console.log("  bun app.ts              # 取得 → 住所検索 → map.json");
	console.log("  bun app.ts fetch        # すべての取得元から取得する");
	console.log("  bun app.ts fetch <名前> # 1つの取得元だけ取得する");
	console.log("  bun app.ts geocode      # 座標が無い物件の住所を引く");
	console.log("  bun app.ts json         # 生データから map.json を作る");
	console.log("");
	console.log("取得元:");
	for (const source of SOURCES) {
		console.log(`  ${source.command.padEnd(4)} ${source.label}`);
	}
}
