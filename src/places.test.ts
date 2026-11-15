import { describe, expect, test } from "bun:test";

import {
  gsiSearchUrl,
  normalize,
  parseGsi,
  PLACE_LIMIT,
  searchPlaces,
  shouldQuery,
} from "./places.ts";

const feature = (title: unknown, coordinates: unknown) => ({
  geometry: { coordinates, type: "Point" },
  type: "Feature",
  properties: { addressCode: "", title },
});

describe("normalize", () => {
  test("全角・半角と「ヶ」「ケ」の揺れ、空白をそろえる", () => {
    expect(normalize("霞ヶ浦 １丁目")).toBe(normalize("霞ケ浦1丁目"));
  });
});

describe("shouldQuery", () => {
  test("2 文字から問い合わせる", () => {
    expect(shouldQuery("高")).toBe(false);
    expect(shouldQuery(" 高 ")).toBe(false);
    expect(shouldQuery("高山")).toBe(true);
  });
});

describe("gsiSearchUrl", () => {
  test("打った文字だけを送る", () => {
    expect(gsiSearchUrl(" 高山市 ")).toBe(
      "https://msearch.gsi.go.jp/address-search/AddressSearch?q=%E9%AB%98%E5%B1%B1%E5%B8%82",
    );
  });
});

describe("parseGsi", () => {
  test("Feature を候補にし、形の違うものは捨てる", () => {
    const places = parseGsi([
      feature("岐阜県高山市", [137.252, 36.146]),
      feature("", [137, 36]),
      feature("座標なし", null),
      feature("文字の座標", ["137", "36"]),
      feature("無限", [Number.POSITIVE_INFINITY, 36]),
      null,
    ]);
    expect(places).toEqual([
      {
        id: "gsi:岐阜県高山市:137.252,36.146",
        label: "岐阜県高山市",
        at: [137.252, 36.146],
      },
    ]);
  });

  test("同じ名前は 1 つにする", () => {
    const places = parseGsi([
      feature("高山", [137, 36]),
      feature("高山", [138, 35]),
    ]);
    expect(places.map((p) => p.at)).toEqual([[137, 36]]);
  });

  test("上限までにする", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      feature(`地名${i}`, [i, i]),
    );
    expect(parseGsi(many)).toHaveLength(PLACE_LIMIT);
  });

  test("配列でなければ空", () => {
    expect(parseGsi({ error: "x" })).toEqual([]);
  });
});

describe("searchPlaces", () => {
  test("Cookie と Referer を送らず、同じ文字は問い合わせ直さない", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json([feature("長野県松本市", [137.97, 36.23])]);
    }) as typeof fetch;
    const first = await searchPlaces("松本市", undefined, fake);
    const again = await searchPlaces("松本市 ", undefined, fake);
    expect(first[0]?.label).toBe("長野県松本市");
    expect(again).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(calls[0]?.init?.referrerPolicy).toBe("no-referrer");
  });

  test("読めないときは投げる", async () => {
    const fake = (async () =>
      new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(searchPlaces("読めない所", undefined, fake)).rejects.toThrow(
      "HTTP 503",
    );
  });
});
