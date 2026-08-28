/**
 * 取得元で共通して要るもの。
 *
 * 相手は5サイトとも別々の作りだが、名乗り方・間隔の空け方・生データの置き方と、
 * 日本語の住所や価格の読み方は同じでいいので、ここにまとめている。
 * 名乗りと待ちだけは住所検索 (geocode.ts) からも使う。
 */

/** ヘッダに非ASCIIは入れられないので英字で名乗る */
export const USER_AGENT =
	"yuzuriha/1.0 (personal map project; +https://github.com/danything/yuzuriha)";

/** 取得の間隔。相手のサイトに負荷をかけないための待ち */
export const DELAY_MS = Number(Bun.env.FETCH_DELAY_MS ?? 700);

export const sleep = (ms: number = DELAY_MS) =>
	new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- 取得 ---------- */

export async function getText(url: string, label: string): Promise<string> {
	const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
	if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
	return await res.text();
}

/** WordPress の投稿。負動産の掲示板と NISUMEL がどちらもこの形 */
export type WpPost = {
	id: number;
	date: string;
	link: string;
	title: { rendered: string };
	content: { rendered: string };
	_embedded?: { "wp:featuredmedia"?: { source_url?: string }[] };
};

/** wp-json の投稿一覧。総ページ数はヘッダにしか入っていない */
export async function wpPosts<T>(
	base: string,
	params: Record<string, string>,
	label: string,
): Promise<{ posts: T[]; totalPages: number }> {
	const query = new URLSearchParams({
		per_page: "100",
		_embed: "wp:featuredmedia",
		...params,
	});
	const res = await fetch(`${base}/wp-json/wp/v2/posts?${query}`, {
		headers: { "user-agent": USER_AGENT, accept: "application/json" },
	});
	if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
	return {
		posts: (await res.json()) as T[],
		totalPages: Number(res.headers.get("x-wp-totalpages") ?? 1),
	};
}

export const wpImage = (post: WpPost): string | null =>
	post._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null;

/* ---------- 生データの置き場 ---------- */

export async function saveRaw<T>(file: string, items: T[]): Promise<T[]> {
	await Bun.write(file, JSON.stringify(items, null, "\t"));
	console.log(`${file} 保存完了 (${items.length} 件)`);
	return items;
}

export async function readRaw<T>(file: string): Promise<T[]> {
	const raw = Bun.file(file);
	if (!(await raw.exists())) return [];
	return JSON.parse(await raw.text()) as T[];
}

/* ---------- HTML ---------- */

const ENTITIES: Record<string, string> = {
	"&nbsp;": " ",
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#39;": "'",
	"&#8211;": "-",
	"&#8212;": "-",
};

export const decodeEntities = (text: string): string =>
	text.replace(
		/&(?:nbsp|amp|lt|gt|quot|#39|#8211|#8212);/g,
		(entity) => ENTITIES[entity] ?? entity,
	);

/**
 * タグを落として実体参照を戻す。
 * keepBreaks を立てると改行を残す（行ごとに読みたい本文用）。
 */
export function stripTags(html: string, keepBreaks = false): string {
	const text = decodeEntities(
		html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""),
	);
	return (keepBreaks ? text : text.replace(/\s+/g, " ")).trim();
}

/* ---------- 日本語の住所と価格 ---------- */

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

const toHalfWidth = (text: string): string =>
	text.replace(/[０-９]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xfee0),
	);

/** 「０円」「50万円」「1.2億円」を円に直す。読めなければ fallback */
export function parsePrice(text: string, fallback = Number.NaN): number {
	const match = toHalfWidth(text ?? "").match(/([\d.,]+)\s*(億|万)?円/);
	if (!match) return fallback;
	const value = Number(match[1].replace(/,/g, ""));
	if (!Number.isFinite(value)) return fallback;
	return Math.round(
		value * (match[2] === "億" ? 1e8 : match[2] === "万" ? 1e4 : 1),
	);
}

/** 掲載日は JST で timezone が付いていないので、明示して ISO に直す */
export function jstToIso(text: string): string {
	const stamp = text.replace(" ", "T");
	return new Date(
		stamp.includes("T") ? `${stamp}+09:00` : `${stamp}T00:00:00+09:00`,
	).toISOString();
}

/** null や空文字を Number() に渡すと 0 になってしまうので明示的に弾く */
export function toNumber(value: string | null | undefined): number {
	if (value === null || value === undefined || value.trim() === "")
		return Number.NaN;
	return Number(value);
}
