/**
 * assets/ の URL に中身の版を付ける。
 *
 * assets/ のファイル名は固定 (main.js・styles.css など) なので、同じ URL のまま
 * 中身が替わる。以前は 1 時間キャッシュさせていて、Cloudflare とブラウザに
 * 古い main.js が残り、デプロイしても新しいページに古いコードが組み合わさった
 * (2026-11-16。地図の下地を替えた 5b5880d が出なかった)。
 *
 * そこで、ページを返すときに index.html の中の `./assets/…` に `?v=<中身のハッシュ>`
 * を足す。中身が替われば URL も替わるので、版の付いた URL は長くキャッシュさせて
 * よい。版の無い URL (maplibre が自分で読む shared / worker の chunk、main.js が
 * 読む assets/gsi/ の注記とスプライト) と、古い版の URL は毎回問い合わせさせる。
 */

/** 版の付いた URL。中身が替われば URL も替わるので、取り直させることは無い */
export const IMMUTABLE = "public, max-age=31536000, immutable";
/** 版の無い URL と古い版の URL。持っていてよいが、使う前に毎回問い合わせる (変わっていなければ 304) */
export const REVALIDATE = "public, max-age=0, must-revalidate";

/** 中身から作る版。URL と ETag に使う */
export function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256")
    .update(bytes)
    .digest("base64url")
    .slice(0, 16);
}

/**
 * HTML の中の `"./assets/<名前>"` (引用符で囲んだもの) に `?v=<版>` を足す。
 * importmap の JSON も同じ形なので一緒に替わる。`versionOf` が版を返さない
 * 名前 (配っていないもの) は触らない。
 */
export function stampAssetUrls(
  html: string,
  versionOf: (name: string) => string | undefined,
): string {
  return html.replace(
    /(["'])\.\/assets\/([^"'?#\s]+)\1/g,
    (whole, quote: string, name: string) => {
      const version = versionOf(name);
      return version ? `${quote}./assets/${name}?v=${version}${quote}` : whole;
    },
  );
}

/** 要求の `?v=` が今の中身の版と合うときだけ長くキャッシュさせる */
export function assetCacheControl(
  requested: string | null,
  current: string,
): string {
  return requested === current ? IMMUTABLE : REVALIDATE;
}
