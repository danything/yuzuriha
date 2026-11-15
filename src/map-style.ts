/**
 * 地図の下地と、重ねる層 (README の「地図」)。MapLibre の style を組むだけで、DOM にも MapLibre にも触らない
 * (試験できるように)。
 *
 * 下地は danything/sonae と同じ: 地理院タイル「写真」の上に、地理院地図Vector (国土地理院最適化ベクトルタイル) の
 * 道路と注記 (地名・施設の記号) を重ねる。注記の層は tools/gsi/build.ts が assets/gsi/anno.json に書き出し、
 * 地図を作ったあとで差し込む (`ANNO_BEFORE` の下)。
 */

import type { StyleSpecification } from "maplibre-gl";

const GSI = "https://cyberjapandata.gsi.go.jp/xyz";

/**
 * 地理院地図Vector の PMTiles。試験公開で URL が変わりうる。
 * 前の `{z}/{x}/{y}.pbf` の配信は 2023 年のデータで止まっているので、PMTiles の 1 ファイルを範囲で読む
 */
export const GSI_VECTOR_URL =
  "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles";

/** 地図の字に使う端末の字体 (字体のファイルは外から読まない。tools/gsi/build.ts と同じ) */
export const TEXT_FONT = ["Noto Sans JP", "sans-serif"];

/* 取得元をまたいで揃えた語（build.ts で正規化してある） */
export const STATUS_COLORS: Record<string, string> = {
  募集中: "#34d399",
  商談中: "#fbbf24",
  受付停止: "#fbbf24",
  成約済み: "#f87171",
  取引中止: "#60a5fa",
  未公開: "#a78bfa",
};
export const FALLBACK_COLOR = "#94a3b8";
export const ACCENT = "#34d399";
/** 地名・住所の検索で選んだ所の印 (物件の色と分ける。sonae と同じ白い縁の橙の丸) */
export const PLACE_COLOR = "#ff8a3d";

/* 負動産の掲示板は番地までの住所を出さないため、同じ大字の複数物件が
   同一座標に重なることがある。ズームでは絶対に割れないので、その点数は
   クラスタリングを打ち切る側にも合わせておく */
export const CLUSTER_MAX_ZOOM = 15;

/** 地理院の注記の層を差し込む位置 (この層の下。物件の印は注記より上) */
export const ANNO_BEFORE = "place";

const EMPTY = { type: "FeatureCollection", features: [] };

/**
 * 道路 (地理院地図Vector の道路中心線)。写真の上で読めるよう、細い黒い縁取りの上に明るい線を引く。
 * 引いているときは高速道路と国道だけ、寄せるほど細い道まで出す (読むタイルと描く線を減らす)
 */
export function roadLayers(): Record<string, unknown>[] {
  const kinds: {
    id: string;
    ctg: string[];
    min: number;
    color: string;
    w: [number, number, number, number];
  }[] = [
    {
      id: "minor",
      ctg: ["市区町村道等", "不明"],
      min: 13,
      color: "rgba(255,255,255,0.85)",
      w: [13, 0.6, 16, 2.5],
    },
    {
      id: "pref",
      ctg: ["都道府県道"],
      min: 10,
      color: "#ffffff",
      w: [10, 0.6, 16, 4],
    },
    {
      id: "national",
      ctg: ["国道"],
      min: 7,
      color: "#ffe066",
      w: [7, 0.6, 16, 5],
    },
    {
      id: "motorway",
      ctg: ["高速自動車国道等"],
      min: 6,
      color: "#ffa04d",
      w: [6, 0.8, 16, 5],
    },
  ];
  return kinds.flatMap((k) => {
    const [z0, w0, z1, w1] = k.w;
    const base = {
      type: "line",
      source: "gsi",
      "source-layer": "RdCL",
      minzoom: k.min,
      filter: ["in", ["get", "vt_rdctg"], ["literal", k.ctg]],
      layout: { "line-join": "round", "line-cap": "round" },
    };
    return [
      {
        ...base,
        id: `road-${k.id}-casing`,
        paint: {
          "line-color": "rgba(0,0,0,0.55)",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            z0,
            w0 + 1.2,
            z1,
            w1 + 2,
          ],
        },
      },
      {
        ...base,
        id: `road-${k.id}`,
        paint: {
          "line-color": k.color,
          "line-width": ["interpolate", ["linear"], ["zoom"], z0, w0, z1, w1],
        },
      },
    ];
  });
}

/**
 * 下地と、物件の層。物件のデータは地図を作ったあとで setData する。
 * 出典は MapLibre の (i) には出さず、地図の隅にいつも出す (index.html の `map-credit`)。
 * そのため source の attribution は書かない
 */
export function buildStyle(
  /** スプライト (地理院の記号) の頭。MapLibre は相対の URL を読まないので、絶対の URL にして渡す */
  spriteBase: string,
): StyleSpecification {
  const statusMatch: unknown[] = ["match", ["get", "status"]];
  for (const [status, color] of Object.entries(STATUS_COLORS)) {
    statusMatch.push(status, color);
  }
  statusMatch.push(FALLBACK_COLOR);

  // レイヤ定義は静的で、字句が仕様の union に合うかは MapLibre が起動時に
  // 検証する。ここで型を合わせるためだけに as const を撒くより読みやすい。
  return {
    version: 8,
    // 字体 (glyphs) の URL は書かない。MapLibre は端末の字体で字を描く (外から字体を読まない)
    sprite: `${spriteBase}/std`,
    sources: {
      photo: {
        type: "raster",
        tiles: [`${GSI}/seamlessphoto/{z}/{x}/{y}.jpg`],
        tileSize: 256,
        minzoom: 2,
        maxzoom: 18,
      },
      gsi: { type: "vector", url: `pmtiles://${GSI_VECTOR_URL}` },
      place: { type: "geojson", data: EMPTY },
      // クラスタリングは MapLibre 側 (supercluster) に任せる
      properties: {
        type: "geojson",
        data: EMPTY,
        cluster: true,
        clusterMaxZoom: CLUSTER_MAX_ZOOM,
        clusterRadius: 55,
      },
    },
    layers: [
      { id: "photo", type: "raster", source: "photo" },
      ...roadLayers(),
      // 地理院の注記 (地名・施設の記号) は、地図を作ったあとでここ (検索で選んだ所の印の下) に差し込む
      {
        id: "place",
        type: "circle",
        source: "place",
        paint: {
          "circle-color": PLACE_COLOR,
          "circle-radius": 8,
          "circle-stroke-width": 3,
          "circle-stroke-color": "#ffffff",
        },
      },
      {
        id: "clusters",
        type: "circle",
        source: "properties",
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "rgba(17, 23, 28, 0.85)",
          "circle-radius": [
            "step",
            ["get", "point_count"],
            17,
            25,
            20,
            100,
            24,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": ACCENT,
        },
      },
      {
        id: "cluster-count",
        type: "symbol",
        source: "properties",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": TEXT_FONT,
          "text-size": 12,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#eef2f5" },
      },
      {
        id: "points",
        type: "circle",
        source: "properties",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": statusMatch,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            5,
            5,
            12,
            7,
            16,
            9,
          ],
          "circle-stroke-width": 2,
          "circle-stroke-color": "rgba(255, 255, 255, 0.92)",
        },
      },
    ],
  } as unknown as StyleSpecification;
}
