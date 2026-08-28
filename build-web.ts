/**
 * フロントを assets/ に書き出す。
 *
 * maplibre-gl はバンドルに含めない。描画の本体は Web Worker と共通コード
 * (maplibre-gl-shared.mjs) を分け合っていて、自前でバンドルしても worker 用の
 * chunk は結局別に配ることになる。dist の .mjs をそのまま置いて、
 * index.html の importmap で解決させる。
 */

// このファイル自体はモジュールとして扱わせる（トップレベル await のため）
export {};

const OUT = "assets";
const MAPLIBRE = "node_modules/maplibre-gl/dist";

// maplibre-gl.mjs は shared / worker のチャンクを相対パスで読むので一緒に置く
const copies = [
	[`${MAPLIBRE}/maplibre-gl.mjs`, `${OUT}/maplibre-gl.mjs`],
	[`${MAPLIBRE}/maplibre-gl-shared.mjs`, `${OUT}/maplibre-gl-shared.mjs`],
	[`${MAPLIBRE}/maplibre-gl-worker.mjs`, `${OUT}/maplibre-gl-worker.mjs`],
	[`${MAPLIBRE}/maplibre-gl.css`, `${OUT}/maplibre-gl.css`],
];

for (const [from, to] of copies) {
	await Bun.write(to, Bun.file(from));
}

const result = await Bun.build({
	entrypoints: ["src/main.ts"],
	outdir: OUT,
	target: "browser",
	minify: true,
	external: ["maplibre-gl"],
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

const sizes = await Promise.all(
	[...copies.map(([, to]) => to), `${OUT}/main.js`].map(async (path) => {
		const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
		const gz = Bun.gzipSync(bytes).byteLength;
		return `  ${path.padEnd(26)} ${(bytes.byteLength / 1024).toFixed(0).padStart(4)}KB (gzip ${(gz / 1024).toFixed(0)}KB)`;
	}),
);
console.log("フロント出力完了");
for (const line of sizes) console.log(line);
