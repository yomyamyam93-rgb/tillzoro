/* 스키마에 새로 생긴 칸을 지금 돌고 있는 DB 에 적용한다.
 *
 * 서버는 켜질 때 schema.sql 을 스스로 적용하지 않는다. 그래서 칸이 늘어난 날에는
 * 이것을 한 번 돌린다. 모두 "없으면 만든다" 라 여러 번 돌려도 탈이 없다.
 *
 *   cd /opt/tillzero && node apply-schema.mjs
 *
 * DATABASE_URL 은 묻지 않는다. 이미 돌고 있는 서버가 쓰는 값을 그대로 빌려 쓴다
 * (화면에 찍지 않는다).
 */
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

function liveDatabaseUrl() {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, "utf8").split("\0");
      const hit = env.find((x) => x.startsWith("DATABASE_URL="));
      if (hit) return hit.slice("DATABASE_URL=".length);
    } catch {}
  }
  return process.env.DATABASE_URL || null;
}

// schema.sql 의 같은 줄과 짝이 맞아야 한다
const STEPS = [
  "alter table user_tools add column if not exists public boolean not null default false",
  "create index if not exists user_tools_public_idx on user_tools(public) where public",
];

const url = liveDatabaseUrl();
if (!url) {
  console.error("DATABASE_URL 을 찾지 못했어요. 서버가 돌고 있는지 보세요: pm2 list");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
try {
  for (const sql of STEPS) {
    await pool.query(sql);
    console.log("OK  " + sql.slice(0, 70));
  }
  console.log("\n스키마 적용 끝");
} catch (e) {
  console.error("실패: " + e.message);
  process.exit(1);
} finally {
  await pool.end();
}
