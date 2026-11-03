/* 기본 동작 시험. 폰 크기 화면에서 진짜 앱(index.html)을 진짜 서버와 시험 계정(qaA)으로 돌려 본다.
   하나라도 깨지면 TestFlight 에 올라가지 않는다(.github/workflows/app-ios.yml).
   돌리기: npx playwright test  (tests/ 에서. 시험 계정 열쇠는 .claude/qa.json 또는 QA_TOKEN) */
import { test, expect } from "@playwright/test";
import fs from "node:fs";

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
    page.evaluate(async () => { const card = document.querySelector(".rtcard"); await new Promise((r) => setTimeout(r, 80)); return card.getAnimations().length > 0 }),
    page.evaluate(() => swipeTool(1)),
  ]);
  await page.waitForTimeout(900);
  expect(moved, "상자(rtcard)가 움직여야 한다").toBe(true);
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
  const spot = await page.evaluate(() => { const s = document.querySelector(".spot"), b = document.querySelector(".lifted"); if (!s || !b) return null; const a = s.getBoundingClientRect(), c = b.getBoundingClientRect(); return Math.abs(a.width - c.width) + Math.abs(a.height - c.height) });
  expect(spot, "뚫린 자리가 말풍선 크기와 같아야 한다").not.toBeNull();
  expect(spot).toBeLessThan(12);
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
});
