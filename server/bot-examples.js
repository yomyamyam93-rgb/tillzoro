/* 봇에게 보여 주는 잘 만든 도구 예시. 배치를 베끼게 하려는 게 아니라 "이 앱다운 느낌"을 배우게 하려는 것이라
   일부러 모양이 서로 전혀 다른 것들로 골랐다. look 은 그 예시에서 배울 점이다.
   코드는 진짜 함수로 적어 두고 toString() 으로 보낸다(서버가 켜질 때 문법이 한 번 확인된다) */

// 1. 큰 값 하나에 시선: 강화
function ex1() {
  return function render(box, c) {
    const d = c.data, lv = (d.lv || {})[c.me] || 0, p = Math.max(30, 95 - lv * 8);
    const best = c.members.map((m) => ({ n: m.name, v: (d.lv || {})[m.id] || 0 })).sort((a, b) => b.v - a.v)[0];
    box.innerHTML = `<style>.pop{animation:pop .7s ease}@keyframes pop{40%{transform:scale(1.25)}}
      .shake{animation:sh .5s}@keyframes sh{20%,60%{transform:translateX(-4px)}40%,80%{transform:translateX(4px)}}</style>
      <div class="rt-row"><span class="rt-big ${c.ui.fx || ""}">+${lv}</span><span class="rt-title">${lv ? "나의 검" : "나무 막대"}</span>
        <span class="rt-pt">${p}%</span><button class="rt-btn">강화</button></div>
      <div class="rt-row"><span class="rt-sub">최고 ${esc(best ? best.n : "")} +${best ? best.v : 0}</span></div>`;
    box.querySelector("button").onclick = () => {
      const ok = Math.random() * 100 < p;
      d.lv = { ...(d.lv || {}), [c.me]: ok ? lv + 1 : Math.max(0, lv - 1) };
      c.ui.fx = ok ? "pop" : "shake";
      c.save(ok && lv + 1 >= 5 ? `+${lv + 1} 달성` : "");
      setTimeout(() => { c.ui.fx = "" }, 800);
    };
  };
}
// 2. 사람 알약 줄: 정산 (자기 줄만 누른다)
function ex2() {
  return function render(box, c) {
    const d = c.data, n = c.members.length || 1, paid = d.paid || {};
    const won = (v) => (v >= 100000 ? (v / 10000).toFixed(v % 10000 ? 1 : 0) + "만" : v.toLocaleString());
    if (!d.total && !c.ui.edit) {
      box.innerHTML = `<div class="rt-row"><span class="rt-title none">금액 미정</span><button class="rt-btn">입력</button></div>
        <div class="rt-row"><span class="rt-sub">${n}명</span></div>`;
      box.querySelector("button").onclick = () => { c.ui.edit = true; c.redraw() };
      return;
    }
    if (c.ui.edit) {
      box.innerHTML = `<div class="rt-row"><input class="rt-in" inputmode="numeric" placeholder="총 금액"><button class="rt-btn">나누기</button></div>
        <div class="rt-row"><span class="rt-sub">${n}명</span></div>`;
      const i = box.querySelector("input");
      box.querySelector("button").onclick = () => {
        const v = parseInt(i.value.replace(/\D/g, "")) || 0;
        if (!v) return;
        d.total = v; d.paid = {}; c.ui.edit = false; c.save(`총 ${v.toLocaleString()}원`);
      };
      return;
    }
    const each = Math.ceil(d.total / n), done = c.members.filter((m) => paid[m.id]).length;
    box.innerHTML = `<div class="rt-row"><span class="rt-big">${won(each)}</span><span class="rt-sub">원씩 · 총 ${won(d.total)}</span>
        <span class="rt-sp"></span><span class="rt-pt">${done}/${n}</span><button class="rt-btn ghost" data-k="e">다시</button></div>
      <div class="rt-row">${c.members.slice(0, 5).map((m) => `<button class="rt-chip ${paid[m.id] ? "on" : ""}" data-id="${esc(m.id)}">${esc(m.name)}</button>`).join("")}${n > 5 ? `<span class="rt-sub">+${n - 5}</span>` : ""}</div>`;
    box.querySelector("[data-k=e]").onclick = () => { c.ui.edit = true; c.redraw() };
    box.querySelectorAll(".rt-chip").forEach((b) => (b.onclick = () => {
      if (b.dataset.id !== c.me) { c.toast("자기 것만 누를 수 있어요"); return }
      d.paid = { ...paid, [c.me]: !paid[c.me] };
      c.save(paid[c.me] ? "" : "입금 완료");
    }));
  };
}
// 3. 작은 그래프: 하루 한 번 체크, 최근 7일 막대
function ex3() {
  return function render(box, c) {
    const d = c.data, kst = (o) => new Date(Date.now() + 9 * 3600e3 - o * 864e5).toISOString().slice(0, 10);
    const days = [6, 5, 4, 3, 2, 1, 0].map(kst), today = days[6], log = d.log || {};
    const has = (id, day) => (log[id] || []).includes(day);
    const cnt = days.map((x) => c.members.filter((m) => has(m.id, x)).length), max = Math.max(1, c.members.length);
    let streak = 0; for (let i = 6; i >= 0; i--) { if (has(c.me, days[i])) streak++; else if (i < 6) break }
    box.innerHTML = `<div class="rt-row"><span class="rt-big">${streak}</span><span class="rt-sub">일 연속</span><span class="rt-sp"></span>
        <span style="display:flex;align-items:flex-end;gap:3px;height:26px">${cnt.map((v, i) => `<i style="width:7px;border-radius:2px;height:${4 + (22 * v) / max}px;background:${i === 6 ? "var(--ink)" : "var(--line)"}"></i>`).join("")}</span>
        <button class="rt-btn ${has(c.me, today) ? "ghost" : ""}">${has(c.me, today) ? "완료" : "체크"}</button></div>
      <div class="rt-row"><span class="rt-sub">오늘 ${cnt[6]}/${c.members.length}명</span></div>`;
    box.querySelector("button").onclick = () => {
      if (has(c.me, today)) return;
      d.log = { ...log, [c.me]: (log[c.me] || []).filter((x) => days.includes(x)).concat(today) };   // 7일 넘은 것은 버린다
      c.save("오늘 체크");
    };
  };
}
// 4. 게임판: 사람 수만큼 상자, 다 고르면 하나가 당첨
function ex4() {
  return function render(box, c) {
    const d = c.data, pick = d.pick || {}, n = Math.max(2, c.members.length), got = Object.keys(pick);
    const all = got.length >= c.members.length, name = (id) => (c.members.find((m) => m.id === id) || {}).name || "";
    box.innerHTML = `<style>.bx{flex:1;min-width:0;height:34px;border-radius:9px;background:var(--paper-2);color:var(--ink-2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 4px}
      .bx.me{background:var(--ink);color:var(--paper)} .bx.win{background:var(--zero);color:#fff;animation:win 1s ease}
      @keyframes win{0%{transform:scale(.85)}50%{transform:scale(1.06)}}</style>
      <div class="rt-row" style="gap:6px">${[...Array(n)].map((_, i) => `<button class="bx ${pick[i] === c.me ? "me" : ""} ${all && String(i) === String(d.win) ? "win" : ""}" data-i="${i}">${pick[i] ? esc(name(pick[i])) : ""}</button>`).join("")}</div>
      <div class="rt-row"><span class="rt-sub">${all ? "당첨 " + esc(name(pick[d.win])) : got.length + "/" + c.members.length}</span><span class="rt-sp"></span>${all ? '<button class="rt-btn ghost">다시</button>' : ""}</div>`;
    box.querySelectorAll(".bx").forEach((b) => (b.onclick = () => {
      if (all || got.some((k) => pick[k] === c.me) || pick[b.dataset.i]) return;
      const p = { ...pick, [b.dataset.i]: c.me }, ks = Object.keys(p), done = ks.length >= c.members.length;
      d.pick = p; if (done) d.win = ks[Math.floor(Math.random() * ks.length)];
      c.save(done ? "당첨 " + name(p[d.win]) : "");
    }));
    const again = box.querySelector(".rt-btn"); if (again) again.onclick = () => { d.pick = {}; d.win = null; c.save() };
  };
}
// 5. 두 사람 비교: 양쪽 숫자와 기울어지는 막대
function ex5() {
  return function render(box, c) {
    const d = c.data, [x, y] = c.members, cnt = d.cnt || {}, a = cnt[x?.id] || 0, b = cnt[y?.id] || 0, t = a + b || 1;
    box.innerHTML = `<div class="rt-row"><span class="rt-sub" style="flex:1">${esc(x?.name || "")}</span><span class="rt-big">${a}</span>
        <span class="rt-sub">vs</span><span class="rt-big">${b}</span><span class="rt-sub" style="flex:1;text-align:right">${esc(y?.name || "")}</span></div>
      <div class="rt-row"><span style="flex:1;height:6px;border-radius:3px;background:var(--line);overflow:hidden;display:flex">
        <i style="width:${(a / t) * 100}%;background:var(--ink);transition:width .6s"></i></span><button class="rt-btn">먼저 연락</button></div>`;
    box.querySelector("button").onclick = () => { d.cnt = { ...cnt, [c.me]: (cnt[c.me] || 0) + 1 }; c.save("먼저 연락 +1") };
  };
}

module.exports = [
  { name: "강화", look: "가장 중요한 값(+단계) 하나만 크게. 이름·확률은 작게, 버튼은 오른쪽 끝. 결과 연출은 그 숫자에만 짧게.", code: ex1().toString() },
  { name: "정산", look: "사람마다 알약 하나, 자기 것만 누름. 금액은 쉼표, 크면 만 단위로 줄임. 입력칸은 버튼을 눌렀을 때만.", code: ex2().toString() },
  { name: "연속 체크", look: "숫자 하나 + 작은 막대 그래프. 그래프는 장식이 아니라 7일 기록. 데이터는 7일만 남긴다.", code: ex3().toString() },
  { name: "상자 뽑기", look: "칸을 사람 수만큼 나눠 꽉 채움. 칸 안 글자는 …로 줄임. 연출은 당첨 칸 하나에만.", code: ex4().toString() },
  { name: "누가 먼저", look: "두 사람을 좌우 대칭으로. 비교는 숫자 두 개와 한 줄 막대로.", code: ex5().toString() },
];
