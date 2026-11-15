/**
 * 地名・住所の検索 (地図の上の欄。README の「地名・住所の検索」)。DOM にも MapLibre にも触らない。
 *
 * 問い合わせる所は国土地理院の住所検索 (地理院地図が使っているもの) だけで、このファイルに閉じてある
 * (`GSI_ADDRESS_SEARCH`・`gsiSearchUrl`・`parseGsi`)。外のアプリが使ってよいかを国土地理院に問い合わせている
 * ところなので、替えるときはここだけを替える。
 * 送るのは打った文字だけで、ブラウザから直接送る (yuzuriha のサーバーは通さず、残さない)。
 */

/** 国土地理院の住所検索。CORS は `*` (2026-11-15 に確かめた。danything/sonae と同じ) */
export const GSI_ADDRESS_SEARCH =
  "https://msearch.gsi.go.jp/address-search/AddressSearch";

/** 問い合わせるのは、この文字数から (1 文字では候補が多すぎて役に立たない) */
export const REMOTE_MIN_CHARS = 2;
/** 打つのが止まってから問い合わせるまで (ミリ秒)。打つたびには送らない */
export const REMOTE_DELAY_MS = 600;
/** 候補の数の上限 */
export const PLACE_LIMIT = 8;

export interface Place {
  /** 候補の鍵 (並びの中で一意) */
  id: string;
  /** 候補の名前 (「東京都千代田区霞が関一丁目３番」) */
  label: string;
  /** 寄せる所 [経度, 緯度] */
  at: [number, number];
}

/** 比べるための形 (全角・半角の揺れと、「ヶ」「ケ」の揺れ (霞ヶ浦・霞ケ浦) をそろえ、空白を除く) */
export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[ヶヵ]/g, "ケ")
    .toLowerCase();
}

/** 問い合わせてよい文字か (2 文字から) */
export const shouldQuery = (query: string): boolean =>
  normalize(query).length >= REMOTE_MIN_CHARS;

/** 国土地理院の住所検索の URL (打った文字だけを送る) */
export const gsiSearchUrl = (query: string): string =>
  `${GSI_ADDRESS_SEARCH}?q=${encodeURIComponent(query.trim())}`;

/**
 * 国土地理院の住所検索の応答 (GeoJSON の Feature の配列) を候補にする。形の違うものは捨て、
 * 同じ名前は 1 つにして、`limit` までにする
 */
export function parseGsi(json: unknown, limit = PLACE_LIMIT): Place[] {
  if (!Array.isArray(json)) return [];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const f of json as {
    geometry?: { coordinates?: unknown };
    properties?: { title?: unknown };
  }[]) {
    const c = f?.geometry?.coordinates;
    const title = f?.properties?.title;
    if (
      !Array.isArray(c) ||
      typeof c[0] !== "number" ||
      typeof c[1] !== "number" ||
      !Number.isFinite(c[0]) ||
      !Number.isFinite(c[1]) ||
      typeof title !== "string" ||
      title === ""
    )
      continue;
    const key = normalize(title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `gsi:${title}:${c[0]},${c[1]}`,
      label: title,
      at: [c[0], c[1]],
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 同じ文字の答えは、タブを開いている間は覚えて問い合わせ直さない */
const cache = new Map<string, Place[]>();

/**
 * 住所・地名を探す。読めないときは投げる (呼ぶ側が「探せませんでした」を出す)。
 * Cookie は送らず、Referer も付けない
 */
export async function searchPlaces(
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Place[]> {
  const key = normalize(query);
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await fetchImpl(gsiSearchUrl(query), {
    signal,
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const places = parseGsi(await res.json());
  cache.set(key, places);
  return places;
}
