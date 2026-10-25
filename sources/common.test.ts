import { describe, expect, test } from "bun:test";

import { stripTags } from "./common.ts";

describe("stripTags", () => {
  test("タグを落として実体参照を戻す", () => {
    expect(stripTags("<p>山形県&nbsp;<b>尾花沢市</b> &amp; 延沢</p>")).toBe(
      "山形県 尾花沢市 & 延沢",
    );
  });

  test("keepBreaks で改行を残す", () => {
    expect(stripTags("一行目<br>二行目<br />三行目", true)).toBe(
      "一行目\n二行目\n三行目",
    );
  });

  test("消したあとにできるタグも残さない", () => {
    expect(stripTags("<scr<script>ipt>alert(1)</script>")).toBe("ipt>alert(1)");
    expect(stripTags("<<script>script>alert(1)")).toBe("script>alert(1)");
    expect(stripTags("a<<b>i>c")).toBe("ai>c");
    for (const input of [
      "<scr<script>ipt>alert(1)</script>",
      "<<script>script>alert(1)",
      "<<<b>b>b>x",
    ]) {
      expect(stripTags(input)).not.toMatch(/<[a-z]/i);
    }
  });

  test("閉じずに終わるタグも消す", () => {
    expect(stripTags("本文<script")).toBe("本文");
  });

  test("実体参照で書かれた < は本文として戻す", () => {
    expect(stripTags("1 &lt; 2")).toBe("1 < 2");
  });
});
