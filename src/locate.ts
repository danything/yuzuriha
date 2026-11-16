/**
 * 地図の現在地 (README の「現在地」)。DOM にも MapLibre にも触らない決め方と形だけ。
 * 見た目と動きは danything/sonae の現在地 (src/lib/map/locate.ts・QuakeMap.svelte) にそろえる。
 *
 * 違うのは既定だけで、譲葉は開いたら最初から現在地を出す (持ち主の決定、2026-11-16)。
 * ボタンで切ったときだけ端末に覚え (`yuzuriha.map.locate` に `off`)、次からは自動で始めない。
 * 位置そのものは覚えず、サーバーにも送らない。
 */

/** 覚えるときの localStorage の名前 */
export const LOCATE_KEY = "yuzuriha.map.locate";

/** 位置の許可の状態。`navigator.permissions.query` が無い・投げたときは "unknown" */
export type GeoPermission = PermissionState | "unknown";

/** 覚えた値を読む。切ったと覚えている (`off`) ときだけオフ。無い・ほかの値はオン (既定) */
export const readLocate = (raw: string | null): boolean => raw !== "off";

/**
 * 開いたときに自動で始めるか。オフを覚えていなければ始める。
 * 許可がまだ (`prompt`) か分からないときも始める (許可の窓はこのとき出る)。拒まれている (`denied`) ときは
 * 始めない (窓は出ず、何も言わない。地図は今の全国の表示のまま)
 */
export const autoLocate = (on: boolean, permission: GeoPermission): boolean =>
  on && permission !== "denied";

/** 押して始めたときに、初めて取れた所へ寄せるズーム (これより寄せているときはそのまま) */
export const LOCATE_ZOOM = 13;

/**
 * 現在地の点と、位置の誤差の円 (半径はメートル。地図のズームにかかわらず実際の大きさで描くため、
 * 多角形にする)。端末の中で描くだけで、緯度・経度はサーバーに送らない (sonae の `meFeatures` と同じ)
 */
export function meFeatures(
  lon: number,
  lat: number,
  accuracyM: number,
  steps = 64,
) {
  const R = 6_371_008.8;
  const r = Math.max(accuracyM, 0) / R;
  const φ = (lat * Math.PI) / 180;
  const λ = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const θ = (2 * Math.PI * (i % steps)) / steps;
    const φ2 = Math.asin(
      Math.sin(φ) * Math.cos(r) + Math.cos(φ) * Math.sin(r) * Math.cos(θ),
    );
    const λ2 =
      λ +
      Math.atan2(
        Math.sin(θ) * Math.sin(r) * Math.cos(φ),
        Math.cos(r) - Math.sin(φ) * Math.sin(φ2),
      );
    ring.push([(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]);
  }
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        properties: { kind: "accuracy" },
        geometry: { type: "Polygon" as const, coordinates: [ring] },
      },
      {
        type: "Feature" as const,
        properties: { kind: "dot" },
        geometry: { type: "Point" as const, coordinates: [lon, lat] },
      },
    ],
  };
}
