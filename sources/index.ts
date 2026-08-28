/**
 * 取得元の一覧。ここに1つ足せば、取得・住所検索・map.json への合流すべてに乗る。
 */

import type { GeoCache } from "../geocode.ts";
import type { SourceProperty } from "../types.ts";
import * as fieldmatching from "./fieldmatching.ts";
import * as ieichiba from "./ieichiba.ts";
import * as makedosan from "./makedosan.ts";
import * as nisumel from "./nisumel.ts";
import * as zenkokuzeroen from "./zenkokuzeroen.ts";

export type Source<Raw = unknown> = {
	/** map.json に入る識別子。物件の id もこれで前置する */
	name: string;
	label: string;
	url: string;
	/** `bun app.ts fetch:<command>` で呼ぶときの名前 */
	command: string;
	fetch: () => Promise<Raw[]>;
	readRaw: () => Promise<Raw[]>;
	/** 座標を持たない物件のために住所検索へ渡す住所。空文字は対象外 */
	addressesOf: (raw: Raw[]) => string[];
	toMapProperties: (
		raw: Raw[],
		geo: GeoCache,
	) => { properties: SourceProperty[]; unmapped: number; filtered?: number };
};

// biome-ignore lint/suspicious/noExplicitAny: 取得元ごとに生データの型が違う
type AnySource = Source<any>;

export const SOURCES: AnySource[] = [
	{
		name: "fieldmatching",
		label: "フィールドマッチング",
		url: "https://fieldmatching.klc1809.com/",
		command: "fm",
		fetch: fieldmatching.fetchFieldMatching,
		readRaw: fieldmatching.readRaw,
		addressesOf: (items) =>
			items
				.filter((item) => !item.lat || !item.lng)
				.map(fieldmatching.addressOf),
		toMapProperties: fieldmatching.toMapProperties,
	},
	{
		name: "makedosan",
		label: "負動産の掲示板",
		url: "https://souzokutochi-kokkokizoku.com/deflug/",
		command: "md",
		fetch: makedosan.fetchMakedosan,
		readRaw: makedosan.readRaw,
		// 掲載側が座標を持たないので全件を住所から引く
		addressesOf: (posts) => posts.map(makedosan.addressOf),
		toMapProperties: makedosan.toMapProperties,
	},
	{
		name: "nisumel",
		label: "NISUMEL",
		url: "https://ichi-estate.com/",
		command: "ni",
		fetch: nisumel.fetchNisumel,
		readRaw: nisumel.readRaw,
		addressesOf: (posts) =>
			posts
				.filter((post) => !post.title.rendered.includes("サンプル"))
				.map(nisumel.addressOf),
		toMapProperties: nisumel.toMapProperties,
	},
	{
		name: "ieichiba",
		label: "家いちば",
		url: "https://ieichiba.com/",
		command: "ie",
		fetch: ieichiba.fetchIeichiba,
		readRaw: ieichiba.readRaw,
		// 詳細ページに座標がある。無いものだけ住所検索に回す
		addressesOf: ieichiba.addressesOf,
		toMapProperties: ieichiba.toMapProperties,
	},
	{
		name: "zenkokuzeroen",
		label: "全国０円不動産",
		url: "https://zenkokuzeroen-fudosan.com/",
		command: "zz",
		fetch: zenkokuzeroen.fetchZenkokuZeroen,
		readRaw: zenkokuzeroen.readRaw,
		addressesOf: (items) => items.map(zenkokuzeroen.addressOf),
		toMapProperties: zenkokuzeroen.toMapProperties,
	},
];

export const findSource = (command: string): AnySource | undefined =>
	SOURCES.find((source) => source.command === command);
