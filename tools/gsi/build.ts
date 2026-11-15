/**
 * 地理院地図Vector (国土地理院最適化ベクトルタイル) の注記の層とスプライトを、yuzuriha が自分で配る形にする
 * (README の「地図」)。コンテナの中で動かす:
 *
 *   wslc run --rm -v "$PWD:/usr/src/app" -w /usr/src/app oven/bun:1.4.4-slim bun tools/gsi/build.ts
 *
 * - 元は国土地理院が公開しているスタイル (https://github.com/gsi-cyberjapan/optimal_bvmap の
 *   style/std.json) とスプライト。国土地理院コンテンツ利用規約 (公共データ利用規約 第 1.0 版) で、出典を書けば使える
 * - 注記 (Anno) の層だけを取り出す。道路は写真の上で読める色で自分で描く (`src/map-style.ts`)
 * - 字体 (glyphs) は読まない。text-font を端末の字体に替え、MapLibre が端末の中で字を描く (外から字体を読まない)
 * - 写真の上で読めるよう、字は白、縁を黒く太くする
 */

// このファイル自体はモジュールとして扱わせる（トップレベル await のため）
export {};

const BASE = "https://gsi-cyberjapan.github.io/optimal_bvmap/";
const OUT = "assets/gsi";

/** 端末の字体。src/map-style.ts の TEXT_FONT と同じ (MapLibre は glyphs の URL が無いと、この名前を CSS の字体として端末の中で字を描く) */
const TEXT_FONT = ["Noto Sans JP", "sans-serif"];

type Layer = {
  id: string;
  source?: string;
  "source-layer"?: string;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
};

const style = (await (await fetch(`${BASE}style/std.json`)).json()) as {
  layers: Layer[];
};
const anno = style.layers
  .filter((l) => l["source-layer"] === "Anno")
  .map((l) => ({
    ...l,
    id: `gsi-${l.id}`,
    source: "gsi",
    layout: { ...l.layout, "text-font": TEXT_FONT },
    paint: {
      ...l.paint,
      "text-color": "#ffffff",
      "text-halo-color": "rgba(0,0,0,0.85)",
      "text-halo-width": 1.6,
    },
  }));
if (anno.length === 0)
  throw new Error("注記の層がありません (std.json の形が変わった)");
await Bun.write(`${OUT}/anno.json`, `${JSON.stringify(anno)}\n`);

for (const name of ["std.json", "std.png", "std@2x.json", "std@2x.png"]) {
  const res = await fetch(`${BASE}sprite/${name}`);
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  await Bun.write(`${OUT}/sprite/${name}`, await res.arrayBuffer());
}
console.log(`注記の層 ${anno.length} とスプライトを ${OUT} に書きました`);
