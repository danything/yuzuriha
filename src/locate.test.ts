import { describe, expect, test } from "bun:test";

import { autoLocate, meFeatures, readLocate } from "./locate.ts";

/** 誤差の円の輪 (最初の Feature の多角形の外周) */
const ringOf = (fc: ReturnType<typeof meFeatures>): [number, number][] => {
  const geometry = fc.features[0]?.geometry;
  if (geometry?.type !== "Polygon") return [];
  return geometry.coordinates[0] ?? [];
};

describe("readLocate", () => {
  test("切ったと覚えているときだけオフ。無い・ほかの値はオン (既定)", () => {
    expect(readLocate(null)).toBe(true);
    expect(readLocate("on")).toBe(true);
    expect(readLocate("")).toBe(true);
    expect(readLocate("off")).toBe(false);
  });
});

describe("autoLocate", () => {
  test("オンなら、許可があるとき・まだのとき・分からないときに始める", () => {
    expect(autoLocate(true, "granted")).toBe(true);
    expect(autoLocate(true, "prompt")).toBe(true);
    expect(autoLocate(true, "unknown")).toBe(true);
  });
  test("拒まれているときと、オフを覚えているときは始めない", () => {
    expect(autoLocate(true, "denied")).toBe(false);
    expect(autoLocate(false, "granted")).toBe(false);
    expect(autoLocate(false, "prompt")).toBe(false);
  });
});

describe("meFeatures", () => {
  test("誤差の円と点を返し、円の頂点は中心から誤差の距離にある", () => {
    const fc = meFeatures(139.75, 35.68, 100, 8);
    expect(fc.features.map((f) => f.properties.kind)).toEqual([
      "accuracy",
      "dot",
    ]);
    expect(fc.features[1]?.geometry).toEqual({
      type: "Point",
      coordinates: [139.75, 35.68],
    });
    const ring = ringOf(fc);
    expect(ring).toHaveLength(9);
    // 閉じた輪 (最初と最後が同じ)
    expect(ring[0]).toEqual(ring[8] as [number, number]);
    // 真北の頂点は緯度で約 100 m 北 (1 度は約 111 km)
    const [lon, lat] = ring[0] as [number, number];
    expect(lon).toBeCloseTo(139.75, 6);
    expect((lat - 35.68) * 111_195).toBeCloseTo(100, 0);
  });
  test("誤差が負なら半径 0", () => {
    for (const p of ringOf(meFeatures(0, 0, -5, 4))) {
      expect(p[0]).toBeCloseTo(0, 9);
      expect(p[1]).toBeCloseTo(0, 9);
    }
  });
});
