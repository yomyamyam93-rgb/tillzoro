/* 받아 적기 시험. 배포할 때마다 돈다(.github/workflows/server.yml). 규칙을 바꿔도 예전에 맞던 것·고친 것이 다시 틀리지 않는지 본다.
   문제: eval-cases.json(손으로 만든 것) + DB corrections(사용자가 실제로 고친 것, 최근 50개).
   node eval.js  → 점수와 틀린 것을 찍는다. 돈: 한 번에 약 10원 */
const Anthropic = require("@anthropic-ai/sdk");
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod/v4");
const { Pool } = require("pg");
const U = require("./understand");
const C = require("./eval-cases.json");
const ai = new (Anthropic.default || Anthropic)();
const MetaOut = z.object({
  items: z.array(z.object({ item: z.number(), meta: z.array(z.object({ k: z.string(), v: z.string() })), tools: z.array(z.number()) })),
  facts: z.array(z.string()),
});
const tools = C.tools.map((x, i) => ({ id: i + 1, name: x.name, rule: { ask: x.ask, fields: x.fields || [] } }));
const idOf = (n) => tools.find((x) => x.name === n)?.id;

(async () => {
  const cases = C.cases.map((c) => ({ ...c, src: "기본" }));
  try {   // 사용자가 고친 것도 문제로(그 도구가 시험 도구에 있을 때만)
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const rows = (await pool.query("select body, tool, \"on\" from corrections order by id desc limit 50")).rows;
    for (const r of rows) if (idOf(r.tool)) cases.push({ text: r.body, [r.on ? "in" : "out"]: [r.tool], src: "고친 것" });
    await pool.end();
  } catch (e) { console.log("(고친 것 못 읽음: " + e.message + ")") }
  let ok = 0; const bad = [];
  for (let i = 0; i < cases.length; i += 20) {
    const chunk = cases.slice(i, i + 20);
    const items = chunk.map((c, k) => ({ id: i + k + 1, kind: "text", body: c.text, created_at: new Date(C.day) }));
    let r = null;
    for (let t = 0; t < 2 && !r; t++) try {
      r = await ai.beta.messages.parse({ model: "claude-haiku-5-5", max_tokens: 6000, output_config: { format: betaZodOutputFormat(MetaOut) },
        system: U.system(C.day), messages: [{ role: "user", content: U.content({ facts: C.facts, fixes: [], tools, items }) }] });
    } catch (e) { if (t) console.log("깨진 답: " + e.message.slice(0, 80)) }
    const { by } = U.read(r?.parsed_output, items, tools);
    chunk.forEach((c, k) => {
      const got = by.get(i + k + 1) || { meta: {}, tools: [] }, names = got.tools.map((t) => tools[t - 1].name), why = [];
      for (const n of c.in || []) if (!names.includes(n)) why.push(n + " 에 안 들어감");
      for (const n of c.out || []) if (names.includes(n)) why.push(n + " 에 잘못 들어감");
      for (const [key, want] of Object.entries(c.meta || {})) if (!String(got.meta[key] || "").includes(want)) why.push(`${key}="${got.meta[key] || ""}" (기대 ${want})`);
      if (why.length) bad.push(`[${c.src}] ${c.text} → ${why.join(", ")}`); else ok++;
    });
  }
  console.log(`받아 적기 시험: ${ok}/${cases.length}`);
  bad.forEach((b) => console.log("  X " + b));
})();
