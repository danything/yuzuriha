/**
 * 検索の欄の「場所の候補」(README の「検索」)。欄は 1 つで、打った字で一覧を絞るのは src/main.ts、
 * 同じ字で地名・住所を探して候補に出し、選んだら地図を寄せるのがここ。
 *
 * 欄は combobox、候補は listbox と option。↑↓で動き、Enter で選び (選んでいなければ今すぐ探す)、
 * Esc で候補だけを閉じる (欄の字は消さない)。問い合わせは Enter か、打つのが 0.6 秒止まったとき (2 文字から) だけ。
 * 打つのが止まって探したときは、候補が無ければ何も出さない (物件の名前を打っているだけのことが多い)。
 * Enter で探したときは、待つ間「住所を探しています…」、無ければ「地名・住所の候補はありません」と出す
 * (同じ字をもう探していれば、取りやめずにその答えを待つ)。どこへ問い合わせるかは places.ts に閉じてある。
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
  const input = document.getElementById("search") as HTMLInputElement | null;
  const box = document.getElementById("place-box");
  const list = document.getElementById("place-list") as HTMLUListElement | null;
  const status = document.getElementById("place-status");
  const root = input?.closest<HTMLElement>(".place-search");
  if (!input || !box || !list || !status || !root) return;

  let places: Place[] = [];
  let active = -1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  /** 待っている問い合わせの字と、Enter で探したか */
  let pendingQuery = "";
  let pendingAsked = false;

  const say = (text: string) => {
    status.textContent = text;
    status.hidden = text === "";
  };

  /** 候補か状態の 1 行のどちらかがあるときだけ箱を開く */
  const sync = () => {
    const open = places.length > 0 || !status.hidden;
    box.hidden = !open;
    input.setAttribute("aria-expanded", String(places.length > 0 && open));
  };

  /** 候補を閉じる。待っている問い合わせも捨てる (閉じたあとに答えが来て開き直さない) */
  const close = () => {
    clearTimeout(timer);
    pending?.abort();
    box.hidden = true;
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

  const show = (found: Place[], asked: boolean) => {
    places = found;
    list.innerHTML = found
      .map(
        (p, i) =>
          `<li id="place-opt-${i}" class="place-search__opt" role="option" aria-selected="false" data-i="${i}">${escapeHtml(p.label)}</li>`,
      )
      .join("");
    list.hidden = found.length === 0;
    setActive(-1);
    say(
      found.length === 0 && asked
        ? "地名・住所の候補はありません"
        : found.length > 0
          ? "住所: 国土地理院の住所検索"
          : "",
    );
    sync();
  };

  /** 地名・住所を探す。`asked` は Enter で探したとき (候補が無いことも伝える) */
  const run = async (query: string, asked: boolean) => {
    clearTimeout(timer);
    if (!shouldQuery(query)) return;
    if (asked) {
      // 住所検索は遅いことがある (10 秒を超えることもある) ので、Enter には探していることを返す
      say("住所を探しています…");
      sync();
    }
    // 同じ字をもう探しているなら、取りやめずにその答えを待つ (Enter で探し直して遅らせない)
    if (pending && !pending.signal.aborted && pendingQuery === query) {
      pendingAsked ||= asked;
      return;
    }
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    pendingQuery = query;
    pendingAsked = asked;
    try {
      const found = await searchPlaces(query, controller.signal);
      // 待っている間に打ち直したときは、古い答えを出さない
      if (pending === controller && input.value === query) {
        pending = undefined;
        show(found, pendingAsked);
      }
    } catch {
      if (controller.signal.aborted || pending !== controller) return;
      pending = undefined;
      show([], false);
      say("住所を探せませんでした (国土地理院の住所検索)");
      sync();
    }
  };

  const choose = (i: number) => {
    const place = places[i];
    if (!place) return;
    // 待っている問い合わせは捨てる (選んだあとに候補を開き直さない)。
    // 欄の字は打ったまま残す (一覧の絞り込みはその字のまま)
    clearTimeout(timer);
    pending?.abort();
    close();
    handlers.pick(place);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    pending?.abort();
    places = [];
    list.innerHTML = "";
    close();
    const query = input.value;
    if (query.trim() === "") {
      handlers.clear();
      return;
    }
    if (shouldQuery(query)) {
      timer = setTimeout(() => void run(query, false), REMOTE_DELAY_MS);
    }
  });

  input.addEventListener("keydown", (event) => {
    const open = !box.hidden && places.length > 0;
    if (event.key === "ArrowDown" && open) {
      event.preventDefault();
      setActive((active + 1) % places.length);
    } else if (event.key === "ArrowUp" && open) {
      event.preventDefault();
      setActive(active <= 0 ? places.length - 1 : active - 1);
    } else if (
      event.key === "Enter" &&
      // 日本語入力の確定の Enter では探さない (Safari は確定の Enter を isComposing なしで送り、keyCode が 229)
      !event.isComposing &&
      event.keyCode !== 229
    ) {
      event.preventDefault();
      if (open && active >= 0) choose(active);
      else void run(input.value, true);
    } else if (event.key === "Escape" && !box.hidden) {
      // type="search" の Esc は字を消すので、候補を開いているときは閉じるだけにする
      event.preventDefault();
      close();
    }
  });

  // 押しても欄からフォーカスを取らない (候補を閉じる前に選べるように)
  box.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const li = (event.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (li) choose(Number(li.dataset.i));
  });

  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) close();
  });
  input.addEventListener("focus", () => {
    if (places.length > 0 && input.value.trim() !== "") {
      say("住所: 国土地理院の住所検索");
      sync();
    }
  });
}
