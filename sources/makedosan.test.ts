import { describe, expect, test } from "bun:test";

import fixtures from "./fixtures/makedosan-map.json";
import {
  addressOf,
  type MakedosanPost,
  mapPlacesOf,
  refineByMap,
} from "./makedosan.ts";

// 実際の記事から物件概要と地図の埋め込みだけを残したもの
const post = (id: number) =>
  fixtures.find((p) => p.id === id) as unknown as MakedosanPost;

describe("mapPlacesOf", () => {
  test("埋め込みの pb から場所の名前を読み、郵便番号を落とす", () => {
    expect(mapPlacesOf(post(329).content.rendered)).toEqual([
      "岡山県井原市美星町宇戸谷",
    ]);
    expect(mapPlacesOf(post(3165).content.rendered)).toEqual([
      "埼玉県入間郡越生町龍ケ谷",
    ]);
  });

  test("地図が複数あれば全部", () => {
    expect(mapPlacesOf(post(359).content.rendered)).toEqual([
      "長崎県長崎市松原町",
      "長崎県長崎市中里町",
    ]);
  });

  test("地図が無ければ空", () => {
    expect(mapPlacesOf("<p>所在：岡山県井原市美星町</p>")).toEqual([]);
  });
});

describe("addressOf", () => {
  test("地図の方が細かければ地図の町名・字を使う", () => {
    expect(addressOf(post(329))).toBe("岡山県井原市美星町宇戸谷");
    expect(addressOf(post(3165))).toBe("埼玉県入間郡越生町龍ケ谷");
  });

  test("地図の方が粗ければ本文のまま", () => {
    expect(addressOf(post(272))).toBe("奈良県天理市山田町・福住町");
    expect(addressOf(post(359))).toBe("長崎県長崎市松原町・中里町");
  });

  test("郡の有無が違うだけなら本文のまま", () => {
    expect(addressOf(post(200))).toBe("広島県世羅町");
  });
});

describe("refineByMap", () => {
  test("本文が郡を省いていても同じ町なら細かくする", () => {
    expect(refineByMap("広島県世羅町", ["広島県世羅郡世羅町小国"])).toBe(
      "広島県世羅町小国",
    );
  });

  test("番地は使わず町名・字で止める", () => {
    expect(
      refineByMap("岡山県井原市美星町", ["岡山県井原市美星町宇戸谷1234-5"]),
    ).toBe("岡山県井原市美星町宇戸谷");
    expect(
      refineByMap("岡山県井原市美星町", ["岡山県井原市美星町宇戸谷１２３番地"]),
    ).toBe("岡山県井原市美星町宇戸谷");
  });

  test("別の市町村や続きでない場所は使わない", () => {
    expect(
      refineByMap("岡山県井原市美星町", ["岡山県笠岡市美星町宇戸谷"]),
    ).toBe("岡山県井原市美星町");
    expect(refineByMap("岡山県井原市美星町", ["岡山県井原市芳井町吉井"])).toBe(
      "岡山県井原市美星町",
    );
  });
});
