/**
 * 地図の上の「地名・住所へ移動」の欄 (README の「地名・住所の検索」)。
 *
 * 欄は combobox、候補は listbox と option。↑↓で動き、Enter で選び (選んでいなければ今すぐ探す)、
 * Esc で候補だけを閉じる (欄の字は消さない)。問い合わせは Enter か、打つのが 0.6 秒止まったとき (2 文字から) だけ。
 * どこへ問い合わせるかは places.ts に閉じてある。
 */

import {
  type Place,
  REMOTE_DELAY_MS,
  searchPlaces,
  shouldQuery,
} from "./places.ts";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function setupPlaceSearch(handlers: {
  /** 候補を選んだとき (地図を寄せて印を置く) */
  pick: (place: Place) => void;
  /** 欄を空にしたとき (印を消す) */
  clear: () => void;
}): void {
  const input = document.getElementById("place-q") as HTMLInputElement | null;
  const list = document.getElementById("place-list") as HTMLUListElement | null;
  const status = document.getElementById("place-status");
  const root = input?.closest<HTMLElement>(".place-search");
  if (!input || !list || !status || !root) return;

  let places: Place[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;

  const say = (text: string) => {
    status.textContent = text;
    status.hidden = text === "";
  };

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    say("");
  };

  const setActive = (next: number) => {
    active = next;
    for (const [i, el] of [...list.children].entries()) {
      el.setAttribute("aria-selected", String(i === active));
    }
    if (active >= 0) {
      input.setAttribute("aria-activedescendant", `place-opt-${active}`);
      list.children[active]?.scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  };

  const show = (found: Place[]) => {
    places = found;
    list.innerHTML = found
      .map(
        (p, i) =>
          `<li id="place-opt-${i}" class="place-search__opt" role="option" aria-selected="false" data-i="${i}">${escapeHtml(p.label)}</li>`,
      )
      .join("");
    list.hidden = found.length === 0;
    input.setAttribute("aria-expanded", String(found.length > 0));
    setActive(-1);
    say(found.length === 0 ? "見つかりませんでした" : "");
  };

  const run = async (query: string) => {
    clearTimeout(timer);
    pending?.abort();
    if (!shouldQuery(query)) return;
    const controller = new AbortController();
    pending = controller;
    try {
      const found = await searchPlaces(query, controller.signal);
      // 待っている間に打ち直したときは、古い答えを出さない
      if (pending === controller && input.value === query) show(found);
    } catch {
      if (controller.signal.aborted) return;
      show([]);
      say("住所を探せませんでした (国土地理院の住所検索)");
    }
  };

  const choose = (i: number) => {
    const place = places[i];
    if (!place) return;
    input.value = place.label;
    close();
    handlers.pick(place);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    pending?.abort();
    const query = input.value;
    if (query.trim() === "") {
      places = [];
      list.innerHTML = "";
      close();
      handlers.clear();
      return;
    }
    if (!shouldQuery(query)) {
      close();
      return;
    }
    timer = setTimeout(() => void run(query), REMOTE_DELAY_MS);
  });

  input.addEventListener("keydown", (event) => {
    const open = !list.hidden && places.length > 0;
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      setActive((active + 1) % places.length);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActive(active <= 0 ? places.length - 1 : active - 1);
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (open && active >= 0) choose(active);
      else void run(input.value);
    } else if (event.key === "Escape" && (open || !status.hidden)) {
      // type="search" の Esc は字を消すので、候補を開いているときは閉じるだけにする
      event.preventDefault();
      close();
    }
  });

  // 押しても欄からフォーカスを取らない (候補を閉じる前に選べるように)
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const li = (event.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (li) choose(Number(li.dataset.i));
  });

  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) close();
  });
  input.addEventListener("focus", () => {
    if (places.length > 0 && input.value.trim() !== "") {
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }
  });
}
