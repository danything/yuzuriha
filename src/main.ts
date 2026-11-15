/*
 * 0円物件を衛星写真の地図に載せる。データは build.ts が書き出す map.json。
 *
 * maplibre-gl はバンドルに含めず external にしてある。描画の本体は Web Worker と
 * 共通コードを分け合っているので、まとめても worker 用の chunk は別に要る。
 * dist の .mjs をそのまま assets/ に置き、index.html の importmap で解決させている。
 */

import type { Feature, Point } from "geojson";
import {
  addProtocol,
  type GeoJSONSource,
  type LayerSpecification,
  LngLatBounds,
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  ScaleControl,
} from "maplibre-gl";
import { Protocol } from "pmtiles";

import type { MapProperty } from "../types.ts";
import {
  ANNO_BEFORE,
  buildStyle,
  CLUSTER_MAX_ZOOM,
  FALLBACK_COLOR,
  STATUS_COLORS,
} from "./map-style.ts";
import { setupPlaceSearch } from "./place-search.ts";

/** build.ts が書き出す map.json の形 */
type MapData = {
  generatedAt: string;
  total: number;
  unmapped: number;
  /** 北から南の並び。build.ts が並べたものをそのまま使う */
  regions: string[];
  sources: { name: string; label: string; url: string; count: number }[];
  properties: MapProperty[];
};

type SortKey = "new" | "views" | "favorites";

/** チップで絞り込む4つの項目。State のキーと DOM の id をここで結び付ける */
type ChipKey = "statuses" | "sources" | "types" | "notes";

type ChipGroup = {
  key: ChipKey;
  /** 並べる先と「すべて」ボタンの id */
  box: string;
  reset: string;
  /** その物件が当てはまる値。特記事項だけ1件が複数持つ */
  valuesOf: (property: MapProperty) => string[];
  /** 既定は data.properties から集めた値を五十音順に並べる */
  values?: () => string[];
  label?: (value: string) => string;
  color?: (value: string) => string;
};

type State = {
  q: string;
  statuses: Set<string>;
  sources: Set<string>;
  types: Set<string>;
  region: string;
  pref: string;
  notes: Set<string>;
  sort: SortKey;
  inView: boolean;
};

/* 見たいのはたいてい募集中なので、初期表示はそれだけに絞る */
const DEFAULT_STATUSES = ["募集中"];
const LIST_LIMIT = 120;

const CHIP_GROUPS: ChipGroup[] = [
  {
    key: "statuses",
    box: "statuses",
    reset: "status-reset",
    valuesOf: (property) => [property.status],
    color: (value) => statusColor(value),
  },
  {
    key: "sources",
    box: "sources",
    reset: "source-reset",
    valuesOf: (property) => [property.source],
    // 取得元は map.json に出ている順と表示名で出す
    values: () => data.sources.map((source) => source.name),
    label: (value) => sourceLabel(value),
  },
  {
    key: "types",
    box: "types",
    reset: "type-reset",
    valuesOf: (property) => [property.type],
  },
  {
    key: "notes",
    box: "notes",
    reset: "note-reset",
    valuesOf: (property) => property.notes,
  },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const statusColor = (status: string): string =>
  STATUS_COLORS[status] ?? FALLBACK_COLOR;

/** 取得元の表示名。map.json の sources から引く */
const sourceLabel = (name: string): string =>
  data.sources.find((s) => s.name === name)?.label ?? name;

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
};

/* ---------- 地図 ---------- */

// 地理院地図Vector は PMTiles の 1 ファイル。範囲を指定して要るタイルだけを読む
addProtocol("pmtiles", new Protocol().tile);

const map = new MapLibreMap({
  container: "map",
  style: buildStyle(new URL("./assets/gsi/sprite", location.href).href),
  center: [138.5, 37.2],
  zoom: 4.5,
  // MapLibre の (i) は押すまで出典が見えないので出さず、隅の出典 (index.html の map-credit) をいつも出す。
  // 国土地理院の出典の記載の決まり (表示されている間は常に見えるように明示) に沿う
  attributionControl: false,
  // 傾き・回転は物件を見るのに要らないので切る
  pitchWithRotate: false,
  dragRotate: false,
  touchPitch: false,
});
map.touchZoomRotate?.disableRotation();

// 地理院の注記 (地名・施設の記号) の層。読めなくても地図は出す
map.once("load", () => {
  void fetch("./assets/gsi/anno.json")
    .then((res) => (res.ok ? res.json() : []))
    .catch(() => [])
    .then((layers: { id: string }[]) => {
      for (const layer of layers) {
        if (!map.getLayer(layer.id)) {
          map.addLayer(layer as LayerSpecification, ANNO_BEFORE);
        }
      }
    });
});

// bottom-left はパネルの真下になり、半透明のパネル越しに透けて見えてしまう。
// bottom-right は後から足したものが上に積まれるので、縮尺 → ズームの順
map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

/** 地名・住所の検索で選んだ所へ寄せるときのズーム (これより寄せているときはそのまま) */
const PLACE_ZOOM = 15;

// 地名・住所の検索 (地図の上の欄)。選んだ所へ寄せて、白い縁の橙の丸を置く。欄を空にすると印も消える
setupPlaceSearch({
  pick: (place) => {
    (map.getSource("place") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: place.at },
          properties: {},
        },
      ],
    });
    // 画面が狭いときはパネルが地図の下半分を覆うので閉じる
    if (isNarrow()) setPanel(true);
    const pad = viewPadding();
    // パネルで隠れていない所の真ん中へ。動きは付けない
    map.easeTo({
      center: place.at,
      zoom: Math.max(map.getZoom(), PLACE_ZOOM),
      offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2],
      duration: 0,
    });
  },
  clear: () => {
    (map.getSource("place") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: [],
    });
  },
});

// WebGL2 が無い環境では地図が出せないので、白紙にせず理由を出す
map.on("error", (event) => {
  if (/WebGL/i.test(event.error?.message ?? "")) {
    toast("この環境では地図を表示できません (WebGL2 が必要です)");
  }
});

/* ---------- 状態 ---------- */

let data: MapData = {
  generatedAt: "",
  total: 0,
  unmapped: 0,
  regions: [],
  sources: [],
  properties: [],
};
let state: State = {
  q: "",
  statuses: new Set(),
  sources: new Set(),
  types: new Set(),
  region: "",
  pref: "",
  notes: new Set(),
  sort: "new",
  inView: false,
};
const byId = new Map<string, MapProperty>();
let popup: Popup | null = null;
let shownId: string | null = null;

/** skip に渡した項目だけ無視して判定する (チップの件数表示に使う) */
function matches(property: MapProperty, skip?: ChipKey): boolean {
  for (const group of CHIP_GROUPS) {
    const selected = state[group.key];
    if (group.key === skip || selected.size === 0) continue;
    if (!group.valuesOf(property).some((value) => selected.has(value)))
      return false;
  }
  if (state.region && property.region !== state.region) return false;
  if (state.pref && property.prefecture !== state.pref) return false;
  if (state.q) {
    const haystack =
      `${property.title} ${property.address} ${property.prefecture} ${property.city}`.toLowerCase();
    if (!haystack.includes(state.q)) return false;
  }
  return true;
}

const SORTERS: Record<SortKey, (a: MapProperty, b: MapProperty) => number> = {
  new: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
  views: (a, b) => b.views - a.views,
  favorites: (a, b) => b.favorites - a.favorites,
};

const isDefaultStatuses = () =>
  state.statuses.size === DEFAULT_STATUSES.length &&
  DEFAULT_STATUSES.every((status) => state.statuses.has(status));

function filtered() {
  return data.properties.filter((p) => matches(p)).sort(SORTERS[state.sort]);
}

/* ---------- 描画 ---------- */

function popupHtml(property: MapProperty): string {
  const photo = property.image
    ? `<img class="pop__photo" src="${escapeHtml(property.image)}" alt="" decoding="async">`
    : "";
  const notes = property.notes
    .map((note) => `<span class="pop__tag">${escapeHtml(note)}</span>`)
    .join("");
  const rows = [
    ["所在地", `${property.prefecture}${property.city} ${property.address}`],
    // 0円が前提なので、値が付いているものだけ出す
    [
      "譲渡代金",
      property.price ? `${property.price.toLocaleString()} 円` : null,
    ],
    ["築年", property.builtYear],
    ["公開日", formatDate(property.publishedAt)],
    // 取得元によっては閲覧数もお気に入りも持っていない
    [
      "閲覧・お気に入り",
      property.views || property.favorites
        ? `${property.views.toLocaleString()} 回 / ${property.favorites} 件`
        : null,
    ],
    // 掲載側に座標が無く住所から引いた場合は、その旨を出す
    [
      "地図の位置",
      property.approx ? `${property.approx} の住所から推定` : null,
    ],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  return `
		<div class="pop" style="--pin:${statusColor(property.status)}">
			${photo}
			<div class="pop__inner">
				<h3 class="pop__name">${escapeHtml(property.title)}</h3>
				<div class="pop__tags">
					<span class="pop__badge">${escapeHtml(property.status)}</span>
					<span class="pop__tag">${escapeHtml(property.type)}</span>
					<span class="pop__tag pop__tag--source">${escapeHtml(sourceLabel(property.source))}</span>
					${notes}
				</div>
				<dl class="pop__rows">${rows}</dl>
				<div class="pop__links">
					<a class="pop__link pop__link--primary" href="${escapeHtml(property.url)}" target="_blank" rel="noopener">詳細ページ</a>
					<a class="pop__link" href="https://www.google.com/maps/dir/?api=1&destination=${property.lat},${property.lng}" target="_blank" rel="noopener">経路</a>
				</div>
			</div>
		</div>`;
}

function openPopup(property: MapProperty): void {
  popup?.remove();
  shownId = property.id;
  popup = new Popup({
    maxWidth: "280px",
    offset: 14,
    className: "pop-wrap",
  })
    .setLngLat([property.lng, property.lat])
    .setHTML(popupHtml(property))
    .addTo(map);
  popup.on("close", () => {
    shownId = null;
  });
}

/** 住所からの推定などで同じ座標に重なった物件は、ズームでは分離できない。選ばせる */
function pickerHtml(properties: MapProperty[]): string {
  const items = properties
    .map(
      (property) => `
			<li>
				<button type="button" class="pop-pick__item" data-pick-id="${escapeHtml(property.id)}">
					<span class="pop-pick__name">${escapeHtml(property.title)}</span>
					<span class="pop-pick__meta">${escapeHtml(property.status)} ・ ${escapeHtml(sourceLabel(property.source))}</span>
				</button>
			</li>`,
    )
    .join("");
  return `
		<div class="pop-pick">
			<p class="pop-pick__lead">同じ場所に ${properties.length} 件あります</p>
			<ul class="pop-pick__list">${items}</ul>
		</div>`;
}

function openPicker(properties: MapProperty[], lngLat: [number, number]): void {
  popup?.remove();
  shownId = null;
  popup = new Popup({
    maxWidth: "280px",
    offset: 14,
    className: "pop-wrap",
  })
    .setLngLat(lngLat)
    .setHTML(pickerHtml(properties))
    .addTo(map);
  popup
    .getElement()
    ?.querySelectorAll<HTMLButtonElement>("[data-pick-id]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const property = byId.get(button.dataset.pickId ?? "");
        if (property) openPopup(property);
      });
    });
}

function toFeature(property: MapProperty): Feature<Point> {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [property.lng, property.lat] },
    properties: { id: property.id, status: property.status },
  };
}

function renderList(entries: MapProperty[]): void {
  const list = $("list");
  const bounds = state.inView ? map.getBounds() : null;
  const visible = bounds
    ? entries.filter((p) => bounds.contains([p.lng, p.lat]))
    : entries;

  $("count").textContent = `${visible.length.toLocaleString()} 件`;

  if (visible.length === 0) {
    list.innerHTML = `<li class="list__empty">条件に合う物件がありません</li>`;
    return;
  }

  // 写真は原寸 (1枚 500KB 前後) なので、実際に見えた行だけ読み込む
  const NO_PHOTO = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
		<path d="M4 5h16v14H4z" fill="none" stroke="currentColor" stroke-width="1.5"/>
		<circle cx="9" cy="10" r="1.4" fill="currentColor"/>
		<path d="m4 16 5-5 4 4 3-3 4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
	</svg>`;
  const thumb = (property: MapProperty) =>
    property.image
      ? `<img class="list__thumb" data-src="${escapeHtml(property.image)}" alt="" width="52" height="40" decoding="async">`
      : `<span class="list__thumb" aria-hidden="true">${NO_PHOTO}</span>`;

  list.innerHTML =
    visible
      .slice(0, LIST_LIMIT)
      .map(
        (property) => `
			<li class="list__item" data-id="${property.id}" style="--pin:${statusColor(property.status)}">
				${thumb(property)}
				<span class="list__body">
					<span class="list__name">${escapeHtml(property.title)}</span>
					<span class="list__meta">
						<span class="list__status">${escapeHtml(property.status)}</span>
						<span>${escapeHtml(property.prefecture)}${escapeHtml(property.city)}</span>
						<span>${escapeHtml(sourceLabel(property.source))}</span>
					</span>
				</span>
			</li>`,
      )
      .join("") +
    (visible.length > LIST_LIMIT
      ? `<li class="list__more">ほか ${(visible.length - LIST_LIMIT).toLocaleString()} 件（絞り込むと表示されます）</li>`
      : "");

  observeThumbs(list);
}

/** 一覧に入ってきたサムネイルだけ src を入れる */
const thumbObserver = new IntersectionObserver(
  (entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target as HTMLImageElement;
      if (img.dataset.src) img.src = img.dataset.src;
      observer.unobserve(img);
    }
  },
  { root: $("panel-body"), rootMargin: "150px" },
);

function observeThumbs(list: HTMLElement): void {
  for (const img of list.querySelectorAll<HTMLImageElement>(
    "img.list__thumb[data-src]",
  )) {
    thumbObserver.observe(img);
  }
}

function renderChipCounts() {
  for (const group of CHIP_GROUPS) {
    const counts = new Map<string, number>();
    for (const property of data.properties) {
      if (!matches(property, group.key)) continue;
      for (const value of group.valuesOf(property)) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    for (const chip of $(group.box).querySelectorAll<HTMLElement>(".chip")) {
      const count = counts.get(chip.dataset.value ?? "") ?? 0;
      const countEl = chip.querySelector(".chip__count");
      if (countEl) countEl.textContent = count.toLocaleString();
    }
  }
}

function render() {
  const entries = filtered();
  (map.getSource("properties") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: entries.map(toFeature),
  });
  // 絞り込みで消えた物件のポップアップは閉じる
  if (shownId !== null && !entries.some((p) => p.id === shownId)) {
    popup?.remove();
  }
  renderList(entries);
  renderChipCounts();
}

/** パネルに隠れる分を余白として扱い、実際に見えている範囲に収める */
function viewPadding() {
  const margin = 20;
  if (document.body.classList.contains("panel-hidden")) {
    return { top: margin, bottom: margin, left: margin, right: margin };
  }
  const rect = $("panel").getBoundingClientRect();
  return isNarrow()
    ? { top: margin, bottom: rect.height + margin, left: margin, right: margin }
    : {
        top: margin,
        bottom: margin,
        left: rect.width + margin * 2,
        right: margin,
      };
}

function fitToSelection() {
  const entries = filtered();
  if (entries.length === 0) return;
  const bounds = new LngLatBounds();
  for (const p of entries) bounds.extend([p.lng, p.lat]);
  map.fitBounds(bounds, { padding: viewPadding(), maxZoom: 14, duration: 600 });
}

const isNarrow = (): boolean => window.matchMedia("(max-width: 640px)").matches;

function setPanel(hidden: boolean): void {
  document.body.classList.toggle("panel-hidden", hidden);
  map.resize();
}

function focusProperty(id: string): void {
  const property = byId.get(id);
  if (!property) return;
  // 画面が狭いときはパネルがポップアップを覆ってしまうので閉じる
  if (isNarrow()) setPanel(true);
  const pad = viewPadding();
  const visibleHeight = map.getCanvas().clientHeight - pad.top - pad.bottom;
  map.easeTo({
    center: [property.lng, property.lat],
    zoom: Math.max(map.getZoom(), 16),
    // パネルで隠れていない領域の中央、から少し下へ。ポップアップが上に開いて収まる
    offset: [
      (pad.left - pad.right) / 2,
      (pad.top - pad.bottom) / 2 + visibleHeight * 0.2,
    ],
    duration: 700,
  });
  openPopup(property);
}

/* ---------- 地図の操作 ---------- */

map.on("click", "points", (event) => {
  // 同一座標に重なった物件は、クリックした地点にある特徴量が全部返ってくる
  const ids = new Set(
    (event.features ?? []).map((feature) => String(feature.properties?.id)),
  );
  const properties = Array.from(ids, (id) => byId.get(id)).filter(
    (property): property is MapProperty => !!property,
  );
  if (properties.length === 1) openPopup(properties[0]);
  else if (properties.length > 1)
    openPicker(properties, [properties[0].lng, properties[0].lat]);
});

map.on("click", "clusters", async (event) => {
  const cluster = event.features?.[0];
  const source = map.getSource("properties") as GeoJSONSource | undefined;
  if (!cluster || !source || cluster.geometry.type !== "Point") return;

  const clusterId = cluster.properties.cluster_id;
  const coordinates = cluster.geometry.coordinates as [number, number];
  const zoom = await source.getClusterExpansionZoom(clusterId);

  if (zoom > CLUSTER_MAX_ZOOM) {
    // clusterMaxZoom を超えてもズームで割れないクラスタは、たいてい住所からの
    // 推定で同一座標に重なっただけ（本当に近いだけの物件は、割れなくても
    // clusterMaxZoom を過ぎれば個別の点として離れて描かれる）
    const leaves = (await source.getClusterLeaves(
      clusterId,
      cluster.properties.point_count,
      0,
    )) as Feature<Point>[];
    const [first] = leaves;
    const samePoint =
      first &&
      leaves.every(
        (leaf) =>
          leaf.geometry.coordinates[0] === first.geometry.coordinates[0] &&
          leaf.geometry.coordinates[1] === first.geometry.coordinates[1],
      );
    if (samePoint) {
      const properties = leaves
        .map((leaf) => byId.get(String(leaf.properties?.id)))
        .filter((property): property is MapProperty => !!property);
      if (properties.length) {
        openPicker(properties, coordinates);
        return;
      }
    }
  }

  map.easeTo({ center: coordinates, zoom, duration: 500 });
});

for (const layer of ["points", "clusters"]) {
  map.on("mouseenter", layer, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", layer, () => {
    map.getCanvas().style.cursor = "";
  });
}

/* ---------- URL への状態保存 ---------- */

function readState(): State {
  const p = new URLSearchParams(location.hash.slice(1));
  const set = (key: string) =>
    new Set((p.get(key) ?? "").split(",").filter(Boolean));
  // st が無ければ既定 (募集中のみ)、st= と空で入っていれば全ステータス
  const st = p.get("st");
  const sort = p.get("sort");
  return {
    q: (p.get("q") ?? "").toLowerCase(),
    statuses: st === null ? new Set(DEFAULT_STATUSES) : set("st"),
    sources: set("src"),
    types: set("ty"),
    region: p.get("rg") ?? "",
    pref: p.get("pf") ?? "",
    notes: set("nt"),
    sort: sort && sort in SORTERS ? (sort as SortKey) : "new",
    inView: p.get("view") === "1",
  };
}

function writeState() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (!isDefaultStatuses()) p.set("st", [...state.statuses].join(","));
  if (state.types.size) p.set("ty", [...state.types].join(","));
  if (state.sources.size) p.set("src", [...state.sources].join(","));
  if (state.region) p.set("rg", state.region);
  if (state.pref) p.set("pf", state.pref);
  if (state.notes.size) p.set("nt", [...state.notes].join(","));
  if (state.sort !== "new") p.set("sort", state.sort);
  if (state.inView) p.set("view", "1");
  const hash = p.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
}

function update() {
  writeState();
  render();
}

/* ---------- UI 構築 ---------- */

const uniqueSorted = (values: (string | null | undefined)[]): string[] =>
  [...new Set(values.filter((v): v is string => Boolean(v)))].sort();

function chipHtml(group: ChipGroup, value: string): string {
  const color = group.color?.(value);
  const dot = color ? `<span class="chip__dot"></span>` : "";
  const label = group.label?.(value) ?? value;
  return `<button type="button" class="chip" data-value="${escapeHtml(value)}" aria-pressed="${state[group.key].has(value)}"${
    color ? ` style="--chip:${color}"` : ""
  }>${dot}${escapeHtml(label)}<span class="chip__count"></span></button>`;
}

function buildControls() {
  const properties = data.properties;

  for (const group of CHIP_GROUPS) {
    const values =
      group.values?.() ?? uniqueSorted(properties.flatMap(group.valuesOf));
    $(group.box).innerHTML = values
      .map((value) => chipHtml(group, value))
      .join("");
  }

  $<HTMLSelectElement>("region").innerHTML =
    `<option value="">すべて</option>` +
    data.regions
      .map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)
      .join("");
  $<HTMLSelectElement>("region").value = state.region;

  buildPrefOptions();
  $<HTMLSelectElement>("sort").value = state.sort;
  $<HTMLInputElement>("in-view").checked = state.inView;
  $<HTMLInputElement>("search").value = state.q;

  // 取得元はデータ次第で変わるので、フッタも map.json から組み立てる
  $("sources-credit").innerHTML = data.sources
    .map(
      (source) =>
        `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>（${source.count.toLocaleString()}件）`,
    )
    .join("・");

  const unmapped = data.unmapped
    ? `・座標なし ${data.unmapped} 件は非表示`
    : "";
  $("meta").innerHTML =
    `${data.properties.length.toLocaleString()} 件を表示${unmapped}<br>更新 ${formatDate(
      data.generatedAt,
    )}`;
}

/** 地方を選んだら、その地方の都道府県だけを選べるようにする */
function buildPrefOptions() {
  const prefs = uniqueSorted(
    data.properties
      .filter((p) => !state.region || p.region === state.region)
      .map((p) => p.prefecture),
  );
  if (state.pref && !prefs.includes(state.pref)) state.pref = "";
  $<HTMLSelectElement>("pref").innerHTML =
    `<option value="">すべて</option>` +
    prefs
      .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
      .join("");
  $<HTMLSelectElement>("pref").value = state.pref;
}

function wireChipGroup({ key, box, reset }: ChipGroup): void {
  $(box).addEventListener("click", (event: Event) => {
    const chip = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button[data-value]",
    );
    const value = chip?.dataset.value;
    if (!value) return;
    if (state[key].has(value)) state[key].delete(value);
    else state[key].add(value);
    chip.setAttribute("aria-pressed", String(state[key].has(value)));
    update();
  });

  $(reset).addEventListener("click", () => {
    state[key].clear();
    for (const chip of $(box).querySelectorAll<HTMLElement>(".chip")) {
      chip.setAttribute("aria-pressed", "false");
    }
    update();
  });
}

function wireEvents() {
  for (const group of CHIP_GROUPS) wireChipGroup(group);

  $<HTMLSelectElement>("region").addEventListener("change", (event: Event) => {
    state.region = (event.target as HTMLSelectElement).value;
    buildPrefOptions();
    update();
    fitToSelection();
  });

  $<HTMLSelectElement>("pref").addEventListener("change", (event: Event) => {
    state.pref = (event.target as HTMLSelectElement).value;
    update();
    fitToSelection();
  });

  $<HTMLSelectElement>("sort").addEventListener("change", (event: Event) => {
    state.sort = (event.target as HTMLSelectElement).value as SortKey;
    update();
  });

  $<HTMLInputElement>("in-view").addEventListener("change", (event) => {
    state.inView = (event.target as HTMLInputElement).checked;
    update();
  });

  let searchTimer: ReturnType<typeof setTimeout>;
  $<HTMLInputElement>("search").addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value.toLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = value;
      update();
    }, 200);
  });

  $("list").addEventListener("click", (event: Event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      ".list__item",
    );
    if (item?.dataset.id) focusProperty(item.dataset.id);
  });

  // 表示範囲で絞る設定のときだけ、地図の移動に合わせて一覧を作り直す
  map.on("moveend", () => {
    if (state.inView) renderList(filtered());
  });

  $("panel-close").addEventListener("click", () => setPanel(true));
  $("panel-toggle").addEventListener("click", () => setPanel(false));
}

function toast(message: string): void {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
}

async function boot() {
  const [loaded] = await Promise.all([
    fetch("./map.json", { cache: "no-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .catch((error) => {
        toast(`物件データを読み込めませんでした (${error.message})`);
        return null;
      }),
    map.loaded() ? Promise.resolve() : new Promise((r) => map.once("load", r)),
  ]);
  if (!loaded) return;

  data = loaded;
  for (const property of data.properties) byId.set(property.id, property);

  state = readState();
  buildControls();
  wireEvents();
  render();
  fitToSelection();
}

void boot();
