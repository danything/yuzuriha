import { describe, expect, test } from "bun:test";

import anno from "../assets/gsi/anno.json";
import {
  ANNO_BEFORE,
  buildStyle,
  GSI_VECTOR_URL,
  roadLayers,
  TEXT_FONT,
} from "./map-style.ts";

describe("buildStyle", () => {
  const style = buildStyle("https://y.example/assets/gsi/sprite");
  const ids = style.layers.map((l) => l.id);

  test("下地は地理院タイル「写真」、道路と注記は地理院地図Vector", () => {
    expect(style.sources.photo).toMatchObject({
      type: "raster",
      tiles: [
        "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
      ],
      maxzoom: 18,
    });
    expect(style.sources.gsi).toEqual({
      type: "vector",
      url: `pmtiles://${GSI_VECTOR_URL}`,
    });
    expect(style.sprite).toBe("https://y.example/assets/gsi/sprite/std");
  });

  test("下地は 1 つだけで、隠した層も無い (選ぶ一覧を置かない)", () => {
    const rasters = style.layers.filter((l) => l.type === "raster");
    expect(rasters.map((l) => l.id)).toEqual(["photo"]);
    expect(
      style.layers.filter(
        (l) => (l.layout as { visibility?: string })?.visibility === "none",
      ),
    ).toEqual([]);
  });

  test("字体は外から読まない (glyphs が無い)", () => {
    expect(style.glyphs).toBeUndefined();
    const count = style.layers.find((l) => l.id === "cluster-count");
    expect(count?.layout).toMatchObject({ "text-font": TEXT_FONT });
  });

  test("現在地はいちばん上 (誤差の円 → 点)", () => {
    expect(style.sources.me).toMatchObject({ type: "geojson" });
    expect(ids.slice(-3)).toEqual([
      "me-accuracy",
      "me-accuracy-line",
      "me-dot",
    ]);
  });

  test("重ねる順は 写真 → 道路 → (注記) → 検索の印 → 物件", () => {
    expect(ids[0]).toBe("photo");
    const lastRoad = Math.max(
      ...ids.map((id, i) => (id.startsWith("road-") ? i : -1)),
    );
    expect(lastRoad).toBeLessThan(ids.indexOf(ANNO_BEFORE));
    expect(ids.indexOf(ANNO_BEFORE)).toBeLessThan(ids.indexOf("clusters"));
    expect(ids.indexOf("clusters")).toBeLessThan(ids.indexOf("points"));
  });
});

describe("roadLayers", () => {
  test("道路の種類ごとに、黒い縁取りの上に明るい線", () => {
    const layers = roadLayers() as { id: string; "source-layer": string }[];
    expect(layers).toHaveLength(8);
    for (let i = 0; i < layers.length; i += 2) {
      expect(layers[i]?.id).toBe(`${layers[i + 1]?.id}-casing`);
    }
    expect(layers.every((l) => l["source-layer"] === "RdCL")).toBe(true);
  });
});

describe("assets/gsi/anno.json", () => {
  test("注記の層だけで、字は白・端末の字体", () => {
    expect(anno.length).toBeGreaterThan(0);
    for (const l of anno as unknown as {
      id: string;
      source: string;
      "source-layer": string;
      layout: Record<string, unknown>;
      paint: Record<string, unknown>;
    }[]) {
      expect(l.id.startsWith("gsi-")).toBe(true);
      expect(l.source).toBe("gsi");
      expect(l["source-layer"]).toBe("Anno");
      expect(l.layout["text-font"]).toEqual(TEXT_FONT);
      expect(l.paint["text-color"]).toBe("#ffffff");
    }
  });
});
