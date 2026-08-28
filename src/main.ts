/*
 * 0円物件を衛星写真の地図に載せる。データは build.ts が書き出す map.json。
 *
 * maplibre-gl はバンドルに含めず external にしてある。描画の本体は Web Worker と
 * 共通コードを分け合っているので、まとめても worker 用の chunk は別に要る。
 * dist の .mjs をそのまま assets/ に置き、index.html の importmap で解決させている。
 */

import type { Feature, Point } from "geojson";
import {
	AttributionControl,
	type GeoJSONSource,
	LngLatBounds,
	Map as MapLibreMap,
	NavigationControl,
	Popup,
	ScaleControl,
	type StyleSpecification,
} from "maplibre-gl";
import type { MapProperty } from "../types.ts";

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

const GSI_ATTR =
	'<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>';
const ESRI_ATTR = "Esri, Maxar, Earthstar Geographics";
/* クラスタの件数表示に使うフォント。ラスタタイルには文字が焼き込まれているので、これだけ */
const GLYPHS = "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

/* 取得元をまたいで揃えた語（build.ts で正規化してある） */
const STATUS_COLORS: Record<string, string> = {
	募集中: "#34d399",
	商談中: "#fbbf24",
	受付停止: "#fbbf24",
	成約済み: "#f87171",
	取引中止: "#60a5fa",
	未公開: "#a78bfa",
};
const FALLBACK_COLOR = "#94a3b8";
/* 見たいのはたいてい募集中なので、初期表示はそれだけに絞る */
const DEFAULT_STATUSES = ["募集中"];
const ACCENT = "#34d399";
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

const BASES = [
	{
		id: "esri-photo",
		label: "衛星写真 (Esri)",
		tiles: [
			"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
		],
		maxzoom: 19,
		attribution: `衛星写真: ${ESRI_ATTR}`,
	},
	{
		id: "gsi-photo",
		label: "衛星写真 (地理院)",
		tiles: [
			"https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg",
		],
		maxzoom: 18,
		attribution: `衛星写真: ${GSI_ATTR}`,
	},
	{
		id: "gsi-pale",
		label: "淡色地図",
		tiles: ["https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"],
		maxzoom: 18,
		attribution: `地図: ${GSI_ATTR}`,
	},
];

const EMPTY = { type: "FeatureCollection", features: [] };

function buildStyle(): StyleSpecification {
	const sources: Record<string, unknown> = {
		// 衛星写真だけでは地名が分からないので、ラベルだけの層を重ねる
		labels: {
			type: "raster",
			tiles: [
				"https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
			],
			tileSize: 256,
			maxzoom: 19,
			attribution: "地名: Esri",
		},
		// クラスタリングは MapLibre 側 (supercluster) に任せる
		properties: {
			type: "geojson",
			data: EMPTY,
			cluster: true,
			clusterMaxZoom: 15,
			clusterRadius: 55,
			// 物件の出典はパネルのフッタに出す（取得元が map.json 次第で変わるため）
		},
	};

	for (const base of BASES) {
		sources[base.id] = {
			type: "raster",
			tiles: base.tiles,
			tileSize: 256,
			maxzoom: base.maxzoom,
			attribution: base.attribution,
		};
	}

	const statusMatch = ["match", ["get", "status"]];
	for (const [status, color] of Object.entries(STATUS_COLORS)) {
		statusMatch.push(status, color);
	}
	statusMatch.push(FALLBACK_COLOR);

	// レイヤ定義は静的で、字句が仕様の union に合うかは MapLibre が起動時に
	// 検証する。ここで型を合わせるためだけに as const を撒くより読みやすい。
	return {
		version: 8,
		glyphs: GLYPHS,
		sources,
		layers: [
			...BASES.map((base, i) => ({
				id: base.id,
				type: "raster",
				source: base.id,
				layout: { visibility: i === 0 ? "visible" : "none" },
			})),
			{
				id: "labels",
				type: "raster",
				source: "labels",
				paint: { "raster-opacity": 0.9 },
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
					"text-font": ["Noto Sans Bold"],
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
	} as StyleSpecification;
}

const map = new MapLibreMap({
	container: "map",
	style: buildStyle(),
	center: [138.5, 37.2],
	zoom: 4.5,
	attributionControl: false,
	// 傾き・回転は物件を見るのに要らないので切る
	pitchWithRotate: false,
	dragRotate: false,
	touchPitch: false,
});
map.touchZoomRotate?.disableRotation();

// bottom-left はパネルの真下になり、半透明のパネル越しに透けて見えてしまう。
// bottom-right は後から足したものが上に積まれるので、縮尺 → 出典 → 背景切替 → ズームの順
map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
map.addControl(
	new AttributionControl({
		compact: true,
		customAttribution:
			'<a href="https://maplibre.org/" target="_blank" rel="noopener">MapLibre</a>',
	}),
	"bottom-right",
);

/** 背景の切替（MapLibre には標準のレイヤ切替が無いので自前） */
class LayerControl {
	private map!: MapLibreMap;
	private root!: HTMLElement;

	onAdd(mapInstance: MapLibreMap): HTMLElement {
		this.map = mapInstance;
		const root = document.createElement("div");
		root.className = "maplibregl-ctrl maplibregl-ctrl-group layers";
		root.innerHTML = `
			<button type="button" class="layers__toggle" aria-expanded="false" aria-label="背景を切り替え">
					<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
						<path d="M12 3 2 8l10 5 10-5-10-5Z" fill="currentColor" opacity=".9"/>
						<path d="M2 12.5 12 17.5l10-5M2 16.5 12 21.5l10-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
					</svg>
				</button>
			<div class="layers__menu" hidden>
				${BASES.map(
					(base, i) => `
					<label class="layers__item">
						<input type="radio" name="base" value="${base.id}" ${i === 0 ? "checked" : ""}>
						<span>${escapeHtml(base.label)}</span>
					</label>`,
				).join("")}
				<hr class="layers__sep">
				<label class="layers__item">
					<input type="checkbox" id="toggle-labels" checked>
					<span>地名ラベル</span>
				</label>
			</div>`;

		const menu = root.querySelector<HTMLElement>(".layers__menu");
		const toggle = root.querySelector<HTMLButtonElement>(".layers__toggle");
		if (!menu || !toggle) throw new Error("背景切替の描画に失敗");
		toggle.addEventListener("click", () => {
			menu.hidden = !menu.hidden;
			toggle.setAttribute("aria-expanded", String(!menu.hidden));
		});

		root.addEventListener("change", (event) => {
			const input = event.target as HTMLInputElement;
			if (input.name === "base") {
				for (const base of BASES) {
					this.map.setLayoutProperty(
						base.id,
						"visibility",
						base.id === input.value ? "visible" : "none",
					);
				}
			} else if (input.id === "toggle-labels") {
				this.map.setLayoutProperty(
					"labels",
					"visibility",
					input.checked ? "visible" : "none",
				);
			}
		});

		this.root = root;
		return root;
	}

	onRemove(): void {
		this.root.remove();
	}
}

map.addControl(new LayerControl(), "bottom-right");
map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

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
	const thumb = (property: MapProperty) =>
		property.image
			? `<img class="list__thumb" data-src="${escapeHtml(property.image)}" alt="" width="52" height="40" decoding="async">`
			: `<span class="list__thumb"></span>`;

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
	const feature = event.features?.[0];
	const property = feature && byId.get(String(feature.properties.id));
	if (property) openPopup(property);
});

map.on("click", "clusters", async (event) => {
	const cluster = event.features?.[0];
	const source = map.getSource("properties") as GeoJSONSource | undefined;
	if (!cluster || !source || cluster.geometry.type !== "Point") return;

	const zoom = await source.getClusterExpansionZoom(
		cluster.properties.cluster_id,
	);
	map.easeTo({
		center: cluster.geometry.coordinates as [number, number],
		zoom,
		duration: 500,
	});
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
