/* 받아 적기의 "이해" 한 덩어리. 서버(index.js)와 시험(eval.js)이 같은 것을 쓴다.
   던진 것은 도구와 상관없이 한 번 깊게 이해해서 넓은 틀(META_KEYS)로 남기고, 그다음 맞는 도구를 고른다.
   그 사람의 기억장(facts)과 예전에 사용자가 고친 것(fixes)을 함께 본다 */
const META_KEYS = ["type", "what", "who", "with", "date", "end", "time", "repeat", "place", "amount", "payer", "item", "title", "tags"];

function system(day) {
  return `너는 틸봇의 받아 적기다. 사용자가 나챗방(나에게 보내는 방)에 던진 글·사진을 하나씩 깊게 이해해서 정해진 틀로 적고, 맞는 도구를 고른다.

[틀] 아래 값 이름만 쓴다. 글에 없는 값은 쓰지 않는다(지어내지 않는다). 오늘은 ${day}.
- type: 약속 · 지출 · 수입 · 할 일 · 정보 · 기록 · 생각 · 링크 · 사진 중 하나
- what: 핵심만 짧게. 누구·언제·얼마는 빼고 그 일 자체("지연이 11월 3일부터 6일까지 일본여행" → 일본여행)
- who: 그 일을 하는 사람이 글쓴이 본인이 아니면 꼭 쓴다. 글에 다른 사람 이름·호칭이 주어로 나오면("지연이 일본여행", "엄마 병원", "민지 결혼식") 그 사람이다.
  기억장에 관계가 있으면 관계(이름)로 쓴다("지연" + 기억장 "지연은 와이프" → 와이프(지연)). 글쓴이 본인 일이면 쓰지 않는다
- with: 함께하는 사람(같은 규칙)
- date: 시작일 YYYY-MM-DD("토요일"은 다가오는 토요일, "내일"·"모레"는 오늘에서 셈)
- end: 끝나는 날 YYYY-MM-DD. 기간이면 꼭 쓴다("3일부터 6일까지", "3박 4일", "~금요일까지"). 하루짜리면 쓰지 않는다
- time: HH:MM / repeat: 반복("매주 화", "매일") / place: 장소
- amount: 금액 숫자만, 원 단위("1.2만"→12000, "4천"→4000) / payer: 돈을 낸 사람(본인이 아니면) / item: 산 것·받은 것
  "냄·냈다·납부·결제·나감·이체·샀다·먹었다" 처럼 이미 일어난 돈 일은 지출(또는 수입)이다. "사야 함·낼 것·얼마지" 는 아니다.
  물건·가게 이름과 금액만 적힌 짧은 글("점심 김밥 4500원", "택시비 12,800", "스벅 아아 4800")도 이미 쓴 돈(지출)이다
- title: 책·영화·글·노래 제목 / tags: 찾을 때 쓸 낱말 몇 개, 쉼표로

[도구 고르기] 각 도구의 조건을 글자 그대로 엄격하게 따른다 — 조건이 "넣지 않는다"고 한 것은 넣지 않고, 애매하면 넣지 않는다. 한 항목이 여러 도구에 맞을 수 있다.
도구에 "핵심 값"이 있으면, 그 값이 틀에 없는 항목은 그 도구에 넣지 않는다(예: 금액이 없는 글은 가계부에 넣지 않는다).
사용자가 예전에 고친 것이 있으면 그 판단을 따른다.

[기억장] 글에서 사람 관계나 늘 쓰는 사실이 새로 드러나면 facts 에 한 줄씩 적는다("지연은 와이프", "회사는 강남"). 이미 기억장에 있는 것, 확실하지 않은 것은 쓰지 않는다.`;
}

// items: [{id, kind, body, created_at, image?(base64 jpeg)}], tools: [{id, name, rule:{ask, fields}}]
function content({ facts, fixes, tools, items }) {
  const out = [{ type: "text", text:
    (facts.length ? "[기억장]\n" + facts.map((f) => "- " + f).join("\n") + "\n\n" : "") +
    (fixes.length ? "[사용자가 예전에 고친 것]\n" + fixes.map((f) => `- "${f.body}" → ${f.tool} ${f.on ? "에 넣는다" : "에는 넣지 않는다"}`).join("\n") + "\n\n" : "") +
    (tools.length ? "[도구]\n" + tools.map((x) => `#${x.id} ${x.name}: ${x.rule.ask}${x.rule.fields && x.rule.fields[0] ? " (핵심 값: " + x.rule.fields[0] + ")" : ""}`).join("\n") + "\n\n" : "[도구] 없음\n\n") +
    "[항목]" }];
  for (const it of items) {
    const head = `#${it.id} ${it.kind} ${new Date(it.created_at).toISOString().slice(0, 10)}`;
    if (it.image) {
      out.push({ type: "text", text: head + " (사진)" + (it.body ? " " + it.body : "") });
      out.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: it.image } });
    } else out.push({ type: "text", text: head + ": " + String(it.body || "").slice(0, 600) });
  }
  return out;
}

// 답(parsed)을 항목별 {meta, tools} 로. 모르는 값 이름·항목·도구는 버린다
function read(parsed, items, tools) {
  const ids = new Set(items.map((x) => Number(x.id))), ts = new Set(tools.map((x) => Number(x.id)));
  const by = new Map();
  for (const r of parsed?.items || []) {
    if (!ids.has(r.item)) continue;
    const meta = {};
    for (const p of r.meta) if (META_KEYS.includes(p.k) && String(p.v).trim()) meta[p.k] = String(p.v).slice(0, 120);
    if (meta.amount) meta.amount = String(meta.amount).replace(/[^0-9.-]/g, "");
    by.set(r.item, { meta, tools: r.tools.filter((t) => ts.has(t)) });
  }
  return { by, facts: (parsed?.facts || []).map((f) => String(f).trim().slice(0, 80)).filter(Boolean).slice(0, 5) };
}

module.exports = { META_KEYS, system, content, read };
