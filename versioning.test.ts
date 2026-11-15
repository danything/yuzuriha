import { describe, expect, test } from "bun:test";

import {
  assetCacheControl,
  digest,
  IMMUTABLE,
  REVALIDATE,
  stampAssetUrls,
} from "./versioning.ts";

describe("stampAssetUrls", () => {
  test("引用符で囲んだ ./assets/ の URL に版を足す", () => {
    const html = [
      `<link rel="stylesheet" href="./assets/styles.css" />`,
      `{ "imports": { "maplibre-gl": "./assets/maplibre-gl.mjs" } }`,
      `<script type="module" src='./assets/main.js'></script>`,
    ].join("\n");
    const stamped = stampAssetUrls(html, (name) => `v-${name}`);
    expect(stamped).toBe(
      [
        `<link rel="stylesheet" href="./assets/styles.css?v=v-styles.css" />`,
        `{ "imports": { "maplibre-gl": "./assets/maplibre-gl.mjs?v=v-maplibre-gl.mjs" } }`,
        `<script type="module" src='./assets/main.js?v=v-main.js'></script>`,
      ].join("\n"),
    );
  });

  test("配っていない名前と、既に版の付いた URL は触らない", () => {
    const html = `<a href="./assets/missing.js"></a><a href="./assets/main.js?v=x"></a>`;
    expect(stampAssetUrls(html, () => undefined)).toBe(html);
    expect(
      stampAssetUrls(html, (n) => (n === "main.js" ? "y" : undefined)),
    ).toBe(html);
  });

  test("index.html が読む assets/ はどれも版が付く", async () => {
    const html = await Bun.file("index.html").text();
    const stamped = stampAssetUrls(html, () => "abc");
    const refs = [...html.matchAll(/["']\.\/assets\/[^"']+["']/g)];
    expect(refs.length).toBeGreaterThan(0);
    // 版の無いまま残る ./assets/ の URL が無い
    expect(stamped).not.toMatch(/["']\.\/assets\/[^"'?]+["']/);
    expect(stamped).toContain(`"./assets/main.js?v=abc"`);
    expect(stamped).toContain(
      `"maplibre-gl": "./assets/maplibre-gl.mjs?v=abc"`,
    );
  });
});

describe("assetCacheControl", () => {
  test("今の版の URL だけ長くキャッシュさせる", () => {
    expect(assetCacheControl("abc", "abc")).toBe(IMMUTABLE);
    expect(assetCacheControl("old", "abc")).toBe(REVALIDATE);
    expect(assetCacheControl(null, "abc")).toBe(REVALIDATE);
    expect(assetCacheControl("", "abc")).toBe(REVALIDATE);
  });
});

describe("digest", () => {
  test("中身が同じなら同じ、違えば違う。URL にそのまま入る文字だけ", () => {
    const a = digest(new TextEncoder().encode("a"));
    expect(a).toBe(digest(new TextEncoder().encode("a")));
    expect(a).not.toBe(digest(new TextEncoder().encode("b")));
    expect(a).toMatch(/^[\w-]{16}$/);
  });
});
