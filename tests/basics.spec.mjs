/* 기본 동작 시험. 폰 크기 화면에서 진짜 앱(index.html)을 진짜 서버와 시험 계정(qaA)으로 돌려 본다.
   하나라도 깨지면 TestFlight 에 올라가지 않는다(.github/workflows/app-ios.yml).
   돌리기: npx playwright test  (tests/ 에서. 시험 계정 열쇠는 .claude/qa.json 또는 QA_TOKEN) */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import SELF_DEFAULTS from "../server/self-defaults.js";

const qa = (() => { try { return JSON.parse(fs.readFileSync(new URL("../.claude/qa.json", import.meta.url), "utf8")) } catch { return null } })();
const TOKEN = process.env.QA_TOKEN || qa?.A?.token, ME = process.env.QA_ID || qa?.A?.id, ROOM = process.env.QA_ROOM || qa?.bond;
const BASE = process.env.BASE_URL || "http://localhost:8130/";

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

// 로그인된 상태로 앱을 연다
async function open(page) {
  await page.addInitScript(([t, id]) => {
    localStorage.setItem("tz:auth", JSON.stringify({ token: t, me: { id: Number(id), nickname: "qaA" } }));
  }, [TOKEN, ME]);
  await page.goto(BASE);
  await page.waitForFunction(() => typeof people !== "undefined" && people.length > 0 && stack.length > 0, null, { timeout: 15000 });   // 시작 화면이 걷힌 뒤
  await page.evaluate(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister() });
}
const selfId = (page) => page.evaluate(() => people.find((p) => p.self).id);
// 대화 목록이 t 밀리초 동안 움직이는지 잰다: 줄 수·높이·스크롤이 한 번이라도 바뀌면 그 순간들을 돌려준다
async function watchDays(page, ms) {
  return page.evaluate(async (ms) => {
    const d = document.getElementById("days"), L = [], t0 = performance.now();
    const snap = () => `${d.children.length}/${d.scrollHeight}/${Math.round(d.scrollTop)}`;
    let last = snap();
    await new Promise((r) => { const f = () => { const s = snap(); if (s !== last) { L.push(Math.round(performance.now() - t0) + ":" + last + "→" + s); last = s } (performance.now() - t0 < ms) ? requestAnimationFrame(f) : r() }; requestAnimationFrame(f) });
    const atBottom = d.scrollHeight - d.clientHeight - d.scrollTop < 2;
    return { changes: L, atBottom };
  }, ms);
}

// 내 컴퓨터에서 열쇠가 없으면 건너뛰지만, CI 에서 없으면 문이 그냥 열리는 셈이라 깨뜨린다
if (process.env.CI && !TOKEN) throw new Error("시험 계정 열쇠가 GitHub 설정에 없다");
test.beforeEach(async ({ page }) => { test.skip(!TOKEN, "시험 계정 열쇠가 없다"); await open(page) });

test("방에 들어가면 처음부터 바닥이고, 들어가는 동안 대화가 움직이지 않는다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), ROOM);
  await page.waitForTimeout(1500);
  await page.evaluate(() => back("till"));
  await page.waitForTimeout(500);
  const [r] = await Promise.all([watchDays(page, 1500), page.evaluate((id) => openChat(id), ROOM)]);
  expect(r.atBottom, "바닥에 있어야 한다").toBe(true);
  // 두 번째로 들어갈 때는 기억해 둔 대화와 서버 대화가 같다. 그러면 전환 중에도, 끝난 뒤에도 한 번도 바뀌면 안 된다
  expect(r.changes, "들어간 뒤 대화가 바뀌면 튄다: " + r.changes.join(" ")).toHaveLength(0);
});

// 나챗방은 위에 도구 상자가 있다. 상자가 나중에 나타나며 대화를 밀어 올리면 그것도 튐이다
test("나챗방에 들어가도 대화가 움직이지 않는다", async ({ page }) => {
  const id = await selfId(page);
  await page.evaluate((id) => openChat(id), id);
  await page.waitForTimeout(2500);
  await page.evaluate(() => back("till"));
  await page.waitForTimeout(500);
  const [r] = await Promise.all([watchDays(page, 2000), page.evaluate((id) => openChat(id), id)]);
  expect(r.atBottom, "바닥에 있어야 한다").toBe(true);
  expect(r.changes, "들어간 뒤 대화가 바뀌면 튄다: " + r.changes.join(" ")).toHaveLength(0);
});

test("보내면 바닥에 붙는다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), ROOM);
  await page.waitForTimeout(1200);
  await page.fill("#msgIn", "시험 " + Date.now());
  await page.click("#sendBtn");
  await page.waitForTimeout(800);
  const at = await page.evaluate(() => { const d = document.getElementById("days"); return d.scrollHeight - d.clientHeight - d.scrollTop });
  expect(at).toBeLessThan(2);
});

test("도구 넘기기: 상자째 움직이고 다음 도구가 된다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), await selfId(page));   // 도구는 나챗방에 있다
  await page.waitForFunction(() => onTools().length >= 2, null, { timeout: 10000 });
  const before = await page.evaluate(() => viewTool());
  const [moved] = await Promise.all([
    page.evaluate(async () => { const tr = document.getElementById("rtTrack"); await new Promise((r) => setTimeout(r, 80)); return tr.getAnimations().length > 0 }),
    page.evaluate(() => swipeTool(1)),
  ]);
  await page.waitForTimeout(900);
  expect(moved, "도구 줄(rtTrack)이 움직여야 한다").toBe(true);
  expect(await page.evaluate(() => viewTool())).not.toBe(before);
});

test("아래로 쓸면 펼쳐지고 위로 쓸면 접힌다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), await selfId(page));   // 도구는 나챗방에 있다
  await page.waitForFunction(() => roomBox && roomBox.h.alive && roomBox.h.hasKeep, null, { timeout: 15000 });
  await page.evaluate(() => setKeep(true));
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => keepOpen && document.querySelector(".rtcard").classList.contains("open"))).toBe(true);
  const h1 = await page.evaluate(() => document.querySelector(".rtcard").offsetHeight);
  await page.evaluate(() => setKeep(false));
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => keepOpen)).toBe(false);
  expect(await page.evaluate(() => document.querySelector(".rtcard").offsetHeight)).toBeLessThan(h1);
});

test("모음: 추가 → 고치기 → 삭제, 지운 것은 돌아오지 않는다", async ({ page }) => {
  test.setTimeout(90000);
  await page.evaluate(() => goTab("s-box"));
  await page.waitForSelector(".boxt", { timeout: 10000 });
  const id = await page.evaluate(() => { const t = [...document.querySelectorAll(".boxt")].find((x) => x.textContent.includes("할 일")); t.click(); return boxOpen });
  await page.waitForFunction(() => boxH && boxH.alive, null, { timeout: 15000 });
  const mark = "시험 할 일 " + Date.now();
  await page.evaluate((t) => toolAsk({ id: 1, kind: "throw", opt: { text: t } }, null, boxH), mark);
  await page.waitForFunction((t) => (toolItems[boxOpen] || []).some((x) => x.text === t), mark, { timeout: 30000 });
  const iid = await page.evaluate((t) => toolItems[boxOpen].find((x) => x.text === t).id, mark);
  await page.evaluate(([i, t]) => toolAsk({ id: 2, kind: "item.edit", opt: { id: i, text: t } }, null, boxH), [iid, mark + " 고침"]);
  await page.waitForFunction((t) => (toolItems[boxOpen] || []).some((x) => x.text === t), mark + " 고침", { timeout: 30000 });
  await page.evaluate((i) => toolAsk({ id: 3, kind: "item.drop", opt: { id: i } }, null, boxH), iid);
  await page.waitForFunction((i) => !(toolItems[boxOpen] || []).some((x) => x.id === i), iid, { timeout: 15000 });
  await page.waitForTimeout(5000);
  expect(await page.evaluate((i) => (toolItems[boxOpen] || []).some((x) => x.id === i), iid), "지운 것이 돌아왔다").toBe(false);
  // 그 사이 화면이 통째로 다시 만들어지지 않았다(같은 칸이 계속 살아 있다)
  expect(await page.evaluate(() => boxH.alive && document.getElementById("boxvBody").contains(boxH.frame))).toBe(true);
});

test("길게 누르면 메뉴가 뜨고 바깥을 누르면 닫힌다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), ROOM);
  await page.waitForSelector("#days .msg", { timeout: 10000 });
  await page.evaluate(() => { const b = [...document.querySelectorAll("#days .msg")].pop(); const m = cur.msgs.find((x) => String(x.id) === b.dataset.id) || cur.msgs[cur.msgs.length - 1]; msgMenu(m, b) });
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getElementById("msgMenu").classList.contains("on"))).toBe(true);
  // 화면 전체가 어두워지고, 누른 말풍선의 사본만 같은 자리에 떠 있다
  const d = await page.evaluate(() => { const g = document.querySelector(".lifted"), o = [...document.querySelectorAll("#days .msg")].pop(); if (!g) return null; const a = g.getBoundingClientRect(), c = o.getBoundingClientRect(); return { off: Math.abs(a.left - c.left) + Math.abs(a.top - c.top) + Math.abs(a.width - c.width), dark: getComputedStyle(document.getElementById("msgMenuBg")).backgroundColor } });
  expect(d, "떠오른 사본이 있어야 한다").not.toBeNull();
  expect(d.off, "사본이 원래 자리에 있어야 한다").toBeLessThan(24);   // 1.03배 커지는 모션만큼은 어긋난다
  expect(d.dark).not.toBe("rgba(0, 0, 0, 0)");
  await page.evaluate(() => document.getElementById("msgMenuBg").click());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.getElementById("msgMenu").classList.contains("on"))).toBe(false);
});

test("탭 전환: 홈 → 모음 → 설정, 모음 칸이 보인다", async ({ page }) => {
  await page.evaluate(() => goTab("s-box"));
  await page.waitForSelector(".boxt", { timeout: 10000 });
  const n = await page.locator(".boxt").count();
  expect(n).toBeGreaterThan(0);
  await page.waitForFunction(() => !tabBusy);   // 넘어가는 동안의 탭 누름은 무시된다(의도)
  await page.evaluate(() => goTab("settings"));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.getElementById("settings").classList.contains("on"))).toBe(true);
});

// 틸봇이 도구를 고친다: 나챗방에서 "@할 일 …" 이라고 하면 할 일 도구의 새 버전이 붙고 위 상자가 그 버전으로 바뀐다(AI 호출 한 번)
test("틸봇에게 할 일 고치기를 시키면 새 버전이 붙는다", async ({ page }) => {
  test.setTimeout(240000);
  await page.evaluate((id) => openChat(id), await selfId(page));
  await page.waitForFunction(() => Object.values(roomData).some((d) => d && d.name === "할 일"), null, { timeout: 15000 });
  const [tid, before] = await page.evaluate(() => { const k = Object.keys(roomData).find((k) => roomData[k]?.name === "할 일"); return [k, roomData[k].ver] });
  // 매번 다른 부탁이어야 한다. 이미 그렇게 돼 있는 것을 부탁하면 봇이 "이미 그래요" 하고 고치지 않는다(맞는 행동)
  await page.evaluate((n) => callBot(null, `할 일 남은 할 일 제목 뒤에 "(${n})" 붙여줘`), Date.now() % 1000);
  await page.waitForFunction(([k, v]) => roomData[k] && roomData[k].ver > v, [tid, before], { timeout: 200000 });
  await page.waitForFunction((k) => roomBox && roomBox.key.startsWith(k + "@") && roomBox.h.alive, tid, { timeout: 30000 });
  expect(await page.evaluate(() => [...document.querySelectorAll("#days .botmsg:not(.work)")].length)).toBeGreaterThan(0);
  // 시험이 끝나면 되돌린다. 봇이 고친 판이 쌓이면 다른 시험이 보는 할 일 모양이 달라진다
  await page.evaluate(([k, v]) => api(`/api/tools/${k}/revert`, { method: "POST", body: { ver: v } }), [tid, before]);
});

// 업계 방식(바뀐 부분만 갈아 끼우기): 적는 중에 새 데이터가 와도 적던 글·커서가 그대로다.
// 적는 줄은 도구 칸 바깥에 있으니, 칸을 다시 그려도 건드려지지 않는다
test("고치는 중에 알림이 와도 적던 글이 남는다", async ({ page }) => {
  const fr = await mountTodo(page);
  await fr.locator(".kl [data-id] .tx").first().tap();
  await page.locator("#askBar.on").waitFor({ timeout: 10000 });
  await page.locator("#askIn").fill("고치는 중");
  await page.evaluate(() => { __items.push({ id: "qa-new", kind: "text", text: "새로 온 줄", at: Date.now(), data: { what: "새로 온 줄" } }); __h.push() });
  await page.waitForTimeout(300);
  expect(await page.locator("#askBar.on").count(), "적는 줄이 사라졌다").toBe(1);
  expect(await page.locator("#askIn").inputValue(), "적던 글이 날아갔다").toBe("고치는 중");
  expect(await page.locator("#askIn").evaluate((e) => document.activeElement === e), "커서가 남아야 한다").toBe(true);
  expect(await fr.locator(".kl [data-id]").count(), "새로 온 줄이 안 들어왔다").toBe(4);
});

/* 막힌 길이 없다(interaction-guide E-1) · 누른 것이 튀지 않는다(E-2).
   모음의 할 일에서 이름을 고치러 들어가면 저장·삭제 말고는 나올 길이 없었고, 체크하면 그 줄이 아래
   「한 것」 구역으로 날아가며 화면이 밀렸다(2026-11-03 사용자 지적).
   서버에 깔린 판은 틸봇이 고쳐 둔 것일 수 있으니, 지금 소스의 기본 도구 코드를 그대로 띄워 본다 */
const TODO = SELF_DEFAULTS.find((d) => d.name === "할 일").code;
const QA_ITEMS = () => ["하나", "둘", "셋"].map((t, i) => ({ id: "qa-" + i, kind: "text", text: t, at: Date.now() - i, data: { what: t } }));

async function mountTodo(page) {
  await page.evaluate(([code, its]) => {
    window.__sent = []; window.__items = its;
    const real = toolAsk;   // 고치기·지우기는 서버까지 가지 않고 이 안에서 끝낸다
    window.toolAsk = (m, w, h) => {
      if (m.kind !== "item.edit" && m.kind !== "item.drop") return real(m, w, h);
      __sent.push(m.kind + ":" + ((m.opt && m.opt.text) || ""));
      const i = __items.findIndex((x) => String(x.id) === String(m.opt.id));
      if (i >= 0) { if (m.kind === "item.drop") __items.splice(i, 1); else { __items[i].text = m.opt.text; __items[i].data = { what: m.opt.text } } }
      try { w && w.postMessage({ tz: 1, k: "askd", id: m.id, val: true }, "*") } catch {}
      __h.push();
    };
    const host = document.createElement("div");
    host.id = "qaHost"; host.className = "roomtool on user";
    host.style.cssText = "position:absolute;left:0;top:60px;width:375px;height:280px;z-index:10;background:var(--card)";
    document.getElementById("phone").appendChild(host);
    let data = { done: {} };
    const h = (window.__h = mountSandbox(host, code, {
      state: () => ({ data, me: "1", self: true, members: [], items: __items, mode: "keep" }),
      save: (d) => { data = d; h.push() },
    }));
  }, [TODO, QA_ITEMS()]);
  await page.waitForFunction(() => window.__h && __h.alive, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  return page.frameLocator("#qaHost iframe");
}
const rowIds = (fr) => fr.locator(".kl [data-id]").evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));

// 적는 것은 모두 앱의 적는 줄(#askBar)에서 한다. 도구 칸 안에는 입력칸이 열리지 않는다
const askOpen = (page) => page.locator("#askBar.on");
const askIn = (page) => page.locator("#askIn");

test("줄을 누르면 칸 안이 아니라 앱의 적는 줄이 열린다", async ({ page }) => {
  const fr = await mountTodo(page);
  await fr.locator(".kl [data-id] .tx").first().tap();
  await askOpen(page).waitFor({ timeout: 10000 });
  expect(await askIn(page).inputValue(), "고칠 글이 담겨 있어야 한다").toBe("하나");
  expect(await askIn(page).evaluate((e) => document.activeElement === e), "커서가 가 있어야 한다").toBe(true);
  expect(await fr.locator("input.rt-in").count(), "칸 안에 입력칸이 또 열렸다").toBe(0);
});

test("고치다가 적는 줄 바깥을 누르면 조용히 저장되고 닫힌다", async ({ page }) => {
  const fr = await mountTodo(page);
  await fr.locator(".kl [data-id] .tx").first().tap();
  await askOpen(page).waitFor({ timeout: 10000 });
  await askIn(page).fill("고친 이름");
  await page.locator("#askScrim").tap({ position: { x: 180, y: 300 } });   // 적는 줄 바깥 아무 곳
  await page.waitForTimeout(400);
  expect(await askOpen(page).count(), "바깥을 눌렀는데 적는 줄이 안 닫혔다").toBe(0);
  expect(await page.evaluate(() => __sent.join("|")), "적던 것이 저장되지 않았다").toContain("item.edit:고친 이름");
  expect(await fr.locator(".kl [data-id] .tx").first().innerText()).toBe("고친 이름");
});

test("비운 채 바깥을 누르면 없던 일이 되고, 비우고 확인하면 지워진다", async ({ page }) => {
  const fr = await mountTodo(page);
  await fr.locator(".kl [data-id] .tx").first().tap();
  await askOpen(page).waitFor({ timeout: 10000 });
  await askIn(page).fill("");
  await page.locator("#askScrim").tap({ position: { x: 180, y: 300 } });
  await page.waitForTimeout(400);
  expect(await askOpen(page).count()).toBe(0);
  expect(await page.evaluate(() => __sent.join("|")), "비우고 바깥을 눌렀는데 지워졌다").toBe("");
  expect(await fr.locator(".kl [data-id] .tx").first().innerText()).toBe("하나");
  // 비우고 확인은 "지움" 이다
  await fr.locator(".kl [data-id] .tx").first().tap();
  await askOpen(page).waitFor({ timeout: 10000 });
  await askIn(page).fill("");
  await page.locator("#askOk").click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => __sent.join("|")), "비우고 확인했는데 안 지워졌다").toContain("item.drop");
  expect(await fr.locator(".kl [data-id] .tx").first().innerText()).toBe("둘");
});

test("체크해도 줄은 제자리에 있고 「한 것」 구역이 생기지 않는다", async ({ page }) => {
  const fr = await mountTodo(page);
  const order0 = await rowIds(fr), y0 = (await fr.locator(".kl [data-id]").first().boundingBox()).y;
  await fr.locator(".kl [data-id] .ck").first().tap();
  await page.waitForTimeout(500);
  expect(await rowIds(fr), "체크한 줄이 다른 자리로 옮겨갔다").toEqual(order0);
  expect((await fr.locator(".kl [data-id]").first().boundingBox()).y, "줄이 위아래로 튀었다").toBeCloseTo(y0, 0);
  expect(await fr.locator(".kl [data-id] .ck.on").count(), "체크 표시가 안 들어갔다").toBe(1);
  expect(await fr.locator(".kl .hd").count(), "「한 것」 머리글이 새로 생겼다").toBe(1);
  await fr.locator(".kl [data-id] .ck").first().tap();   // 다시 누르면 풀린다
  await page.waitForTimeout(400);
  expect(await fr.locator(".kl [data-id] .ck.on").count(), "다시 눌러도 안 풀린다").toBe(0);
  expect(await rowIds(fr), "풀었더니 자리가 바뀌었다").toEqual(order0);
});

// 도구를 펼쳤다 닫으면 대화가 한 번 아래로 밀렸다: open 을 떼는 순간 아직 커 있는 상자 높이가 --rth 로 새어 들어갔다(2026-11-03)
test("도구를 펼쳤다 닫아도 대화가 비워 두는 자리가 안 변한다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), await selfId(page));
  await page.waitForFunction(() => roomBox && roomBox.h.alive && roomBox.h.hasKeep, null, { timeout: 20000 });
  const rth = () => page.evaluate(() => getComputedStyle(document.getElementById("days")).getPropertyValue("padding-top"));
  const before = await rth();
  await page.evaluate(() => setKeep(true)); await page.waitForTimeout(700);
  expect(await rth(), "펼치는 동안 대화 자리가 변했다").toBe(before);
  // 닫는 동안 한 프레임이라도 달라지면 그것이 눈에 튀는 그 순간이다
  const seen = await page.evaluate(async () => {
    const d = document.getElementById("days"), S = new Set(); const t0 = performance.now();
    setKeep(false);
    await new Promise((r) => { const f = () => { S.add(getComputedStyle(d).paddingTop); performance.now() - t0 < 700 ? requestAnimationFrame(f) : r() }; requestAnimationFrame(f) });
    return [...S];
  });
  expect(seen, "닫는 동안 대화 자리가 움직였다: " + seen.join(" → ")).toEqual([before]);
});

// 들어올 때 도구 칸이 깜빡였다: 칸째 감췄다가 iframe 이 준비되면 페이드로 들였다(2026-11-03 측정: 702ms 부터 300ms 페이드)
test("대화방에 들어올 때 도구 칸이 깜빡이지 않는다", async ({ page }) => {
  const seen = await page.evaluate(async (id) => {
    const out = new Set(); openChat(id);
    const t0 = performance.now();
    await new Promise((r) => { const f = () => { const c = document.querySelector(".rtcard");
      if (c && c.offsetHeight > 0) out.add((+getComputedStyle(c).opacity).toFixed(1));
      performance.now() - t0 < 1800 ? requestAnimationFrame(f) : r() }; requestAnimationFrame(f) });
    return [...out];
  }, await selfId(page));
  expect(seen, "자리를 잡은 칸이 투명해진 순간이 있다: " + seen.join(",")).toEqual(["1.0"]);
});

// 전에는 손을 뗀 뒤에야 움직여서 미는 동안 상자가 딱 붙어 있었다
test("도구를 미는 동안 상자가 손가락을 따라오고, 조금 밀면 제자리로 돌아온다", async ({ page }) => {
  await page.evaluate((id) => openChat(id), await selfId(page));
  await page.waitForFunction(() => onTools().length >= 2, null, { timeout: 10000 });
  const tf = () => page.evaluate(() => getComputedStyle(document.getElementById("rtTrack")).transform);
  expect(await tf()).toBe("none");
  await page.evaluate(() => dragTool(-80));
  expect(await tf(), "미는 동안 상자가 안 따라왔다").toContain("-80");
  const gap = await page.evaluate(() => { const c = document.getElementById("roomTool").getBoundingClientRect(),
      p = document.querySelector(".rttrack > .roomtool.peek");
    return p ? Math.round(p.getBoundingClientRect().left - c.right) : null });
  expect(gap, "옆 칸이 바로 옆(한 칸 간격)에 서 있지 않다").toBe(12);
  const before = await page.evaluate(() => viewTool());
  await page.evaluate(() => dropTool(-80, 1200));          // 느리고 조금만 — 제자리
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => viewTool()), "조금 밀었는데 넘어갔다").toBe(before);
  await page.evaluate(() => { const w = document.querySelector(".rtcard").offsetWidth; dragTool(-w); dropTool(-w, 1200) });
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => viewTool()), "끝까지 밀었는데 안 넘어갔다").not.toBe(before);
});
