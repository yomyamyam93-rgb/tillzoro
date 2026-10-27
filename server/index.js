/* Till Zero 서버
 *
 * 규칙은 service-rules.md를 따른다. 특히:
 *   R-4.1  Count는 기기 시간이 아니라 서버 시간으로, lastResetAt에서 계산한다.
 *   R-4.2  마지막 Reset 이후 양쪽이 각각 한 번 이상 보냈을 때 Reset된다.
 *   R-4.3  한쪽만 보낸 것은 Reset이 아니다.
 *   R-7.1  대화는 1:1만.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

// 웹 푸시. 열쇠(.env 의 VAPID_*)가 없으면 알림만 꺼지고 나머지는 그대로 돈다.
let webpush = null;
try {
  webpush = require("web-push");
  if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE)
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || "https://yomyamyam93-rgb.github.io/tillzoro/",
      process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  else webpush = null;
} catch (e) { webpush = null; }

// 인증 문자(솔라피). 열쇠(.env 의 SOLAPI_*)가 없으면 문자를 보내지 않고 인증번호를 서버 기록에만 남긴다(준비 기간용)
let sms = null;
try {
  if (process.env.SOLAPI_KEY && process.env.SOLAPI_SECRET && process.env.SOLAPI_FROM) {
    const { SolapiMessageService } = require("solapi");
    sms = new SolapiMessageService(process.env.SOLAPI_KEY, process.env.SOLAPI_SECRET);
  }
} catch (e) { sms = null; }

const PORT = Number(process.env.PORT || 8790);
const CYCLE_DAYS = 30;
const DAY = 86400000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json({ limit: "1mb" }));

// 앱은 다른 주소(GitHub Pages)에서 열리므로 브라우저에 교차 요청을 허락한다.
// 인증은 쿠키가 아니라 Bearer 토큰이므로 출처를 좁힐 필요가 없다.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "authorization, content-type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- 도우미 ---------- */

const token = () => crypto.randomBytes(24).toString("base64url");

// R-4.1: 남은 일수는 저장하지 않고 볼 때마다 계산한다.
const ddayOf = (lastResetAt) =>
  Math.max(0, CYCLE_DAYS - Math.floor((Date.now() - new Date(lastResetAt)) / DAY));

const daysOf = (bondAt) =>
  Math.max(1, Math.floor((Date.now() - new Date(bondAt)) / DAY));

async function auth(req, res, next) {
  const t = (req.get("authorization") || "").replace(/^Bearer /, "");
  if (!t) return res.status(401).json({ error: "로그인이 필요해요" });
  const { rows } = await pool.query(
    "select u.id, u.nickname, u.dob, u.photo, u.phone_tail from sessions s join users u on u.id = s.user_id where s.token = $1",
    [t]
  );
  if (!rows[0]) return res.status(401).json({ error: "로그인이 필요해요" });
  req.user = rows[0];
  // R-8.1: 휴대폰 인증을 마치지 않은 계정은 아무것도 할 수 없다. 번호 잇기, 내 상태 보기, 계정 삭제·알림 끊기만 된다.
  // 문자가 실제로 나갈 때만 막는다(준비 전에는 연결할 방법이 없으므로)
  if (sms && !rows[0].phone_tail && !PHONE_FREE.has(req.path))
    return res.status(403).json({ error: "휴대폰 인증이 필요해요", need: "phone" });
  next();
}
const PHONE_FREE = new Set(["/api/till", "/api/phone/link", "/api/me/delete", "/api/push/unsub", "/api/kblog"]);

// Bond 한 건을 "내 쪽에서 본" 모양으로 바꾼다.
// 단체방의 참여자. 방 목록·메시지에서 이름과 안 읽음을 계산하는 데 쓴다
async function withMembers(rows) {
  const ids = rows.filter((r) => r.kind === "group").map((r) => r.id);
  if (!ids.length) return rows;
  const { rows: ms } = await pool.query(
    `select m.bond_id, u.id, u.nickname, u.photo, m.read_at, m.joined_at from bond_members m join users u on u.id = m.user_id
      where m.bond_id = any($1::bigint[]) order by m.joined_at`, [ids]);
  for (const r of rows) if (r.kind === "group") r.members = ms.filter((m) => String(m.bond_id) === String(r.id));
  return rows;
}
const memberIds = (b) => (b.kind === "group" ? (b.members || []).map((m) => String(m.id)) : [String(b.a_id), String(b.b_id)]);
// 이름이 없는 단체방은 사람 이름을 나열한다(보는 사람 자신은 뺀다)
const roomName = (b, meId) => b.name ||
  (b.members || []).filter((m) => String(m.id) !== String(meId)).map((m) => m.nickname).slice(0, 4).join(", ") || "새 방";

// 방(코드로 모이는 방). Count 는 방에 하나이고, 마지막 Reset 이후 두 사람 이상이 말하면 30 으로 돌아간다.
// 두 명이면 상대 이름·사진으로 보인다. 이전 대화 보이기가 꺼져 있으면 들어오기 전 대화는 미리보기에서도 감춘다
function shapeGroup(row, meId) {
  const ms = row.members || [];
  const mine = ms.find((m) => String(m.id) === String(meId));
  const others = ms.filter((m) => String(m.id) !== String(meId));
  const from = ms.find((m) => String(m.id) === String(row.last_sender));
  const seen = !!row.last_at && (row.show_history || !mine || new Date(row.last_at) >= new Date(mine.joined_at));
  const sp = (row.speakers || []).map(String);
  return {
    id: row.id, group: true, self: false,
    name: row.name || others.map((m) => m.nickname).slice(0, 4).join(", ") || "새 방", named: !!row.name,
    photo: others.length === 1 ? others[0].photo : null,
    members: ms.map((m) => ({ id: m.id, name: m.nickname, photo: m.photo, joined: m.joined_at })),
    history: !!row.show_history, created: row.bond_at,
    dday: ddayOf(row.last_reset_at), keep: row.keep, days: daysOf(row.bond_at),
    waiting: sp.length === 1 && sp[0] === String(meId),
    lastMessage: seen ? row.last_body : null, lastAt: seen ? row.last_at : null,
    lastFrom: seen && row.last_sender ? (String(row.last_sender) === String(meId) ? "나" : from?.nickname || "") : "",
    unread: seen && String(row.last_sender) !== String(meId) && (!mine || new Date(row.last_at) > new Date(mine.read_at)),
  };
}

function shape(row, meId) {
  if (row.kind === "group") return shapeGroup(row, meId);
  const self = String(row.a_id) === String(row.b_id);
  const iAmA = row.a_id === meId;
  return {
    id: row.id,
    self,                     // 나와의 대화방. 사라지지 않는다.
    name: iAmA ? row.b_nickname : row.a_nickname,
    photo: iAmA ? row.b_photo : row.a_photo,
    dday: self ? 0 : ddayOf(row.last_reset_at),   // 나는 나를 잃지 않는다
    keep: row.keep,
    days: daysOf(row.bond_at),
    // R-6.4: 내가 보내고 상대가 아직 안 보낸 상태
    waiting: iAmA ? row.a_sent && !row.b_sent : row.b_sent && !row.a_sent,
    lastMessage: row.last_body,
    lastAt: row.last_at,
    // 마지막 말이 상대 것이고 내가 읽은 시각보다 나중이면 안 읽은 것이다
    unread:
      !!row.last_at &&
      String(row.last_sender) !== String(meId) &&
      new Date(row.last_at) > new Date(iAmA ? row.a_read_at : row.b_read_at),
  };
}

const BOND_SELECT = `
  select b.*,
         ua.nickname as a_nickname,
         ub.nickname as b_nickname,
         ua.photo    as a_photo,
         ub.photo    as b_photo,
         m.body      as last_body,
         m.created_at as last_at,
         m.sender_id  as last_sender
    from bonds b
    left join users ua on ua.id = b.a_id
    left join users ub on ub.id = b.b_id
    left join lateral (
      select body, created_at, sender_id from messages
       where bond_id = b.id order by id desc limit 1
    ) m on true`;

/* ---------- 계정 ---------- */

/* 휴대폰 인증 (R-8.1, 2026-10-27)
   번호 하나에 계정 하나. 같은 번호로 다시 오면 새 계정이 아니라 그 계정으로 들어간다. 비밀번호는 없다.
   서버에는 번호를 되돌릴 수 없게 바꾼 값(phone_hash)과 화면 표시용 끝 4자리만 둔다(R-8.4).
   문자 남용(남의 번호로 계속 보내 충전금을 태우는 것)을 막는 제한:
     같은 번호 60초에 1번·하루 5번 / 같은 접속지 1시간 10번 / 전체 하루 500번 / 국내 휴대폰 번호만
   인증번호는 6자리, 3분 안에, 5번까지 틀릴 수 있다. */
const PEPPER = process.env.PHONE_PEPPER || "";
const phoneDigits = (p) => String(p || "").replace(/\D/g, "");
const validPhone = (d) => /^01[016789]\d{7,8}$/.test(d);
const phoneHash = (d) => crypto.createHmac("sha256", PEPPER).update(d).digest("hex");
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const masked = (tail) => (tail ? `010-••••-${tail}` : null);

// 인증을 마친 번호에 주는 30분짜리 표. 서버 비밀값으로 서명해서 위조할 수 없다
function makeTicket(h, tail) {
  const body = Buffer.from(JSON.stringify({ h, t: tail, e: Date.now() + 30 * 60000 })).toString("base64url");
  return body + "." + crypto.createHmac("sha256", PEPPER).update("ticket." + body).digest("base64url");
}
function readTicket(tk) {
  const [body, sig] = String(tk || "").split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", PEPPER).update("ticket." + body).digest("base64url");
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try { const d = JSON.parse(Buffer.from(body, "base64url").toString()); return d.e > Date.now() ? d : null; } catch (e) { return null; }
}
const ipHits = new Map(); // 접속지 -> [시각]. 서버 메모리에만 잠깐 둔다
const clientIp = (req) => String(req.get("x-forwarded-for") || req.socket.remoteAddress || "").split(",")[0].trim();
async function newSession(uid) {
  const t = token();
  await pool.query("insert into sessions (token, user_id) values ($1, $2)", [t, uid]);
  return t;
}
const meOf = (u) => ({ id: u.id, nickname: u.nickname, dob: u.dob, phone: masked(u.phone_tail) });

app.post("/api/phone/send", async (req, res) => {
  if (!PEPPER) return res.status(503).json({ error: "인증 준비 중이에요" });
  const d = phoneDigits(req.body?.phone);
  if (!validPhone(d)) return res.status(400).json({ error: "휴대폰 번호를 확인해주세요" });
  const ip = clientIp(req), now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 10) return res.status(429).json({ error: "잠시 뒤에 다시 해주세요" });
  const total = await pool.query("select count(*)::int n from sms_sends where at > now() - interval '1 day'");
  if (total.rows[0].n >= 500) return res.status(503).json({ error: "잠시 뒤에 다시 해주세요" });

  const h = phoneHash(d);
  const cur = (await pool.query("select * from phone_codes where phone_hash = $1", [h])).rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const sendsToday = cur && cur.day && cur.day.toISOString().slice(0, 10) === today ? cur.sends : 0;
  if (cur && now - new Date(cur.last_sent).getTime() < 60000)
    return res.status(429).json({ error: "1분 뒤에 다시 받을 수 있어요" });
  if (sendsToday >= 5) return res.status(429).json({ error: "오늘은 더 받을 수 없어요. 내일 다시 해주세요" });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await pool.query(
    `insert into phone_codes (phone_hash, code_hash, expires_at, tries, sends, day, last_sent)
       values ($1, $2, now() + interval '3 minutes', 0, $3, current_date, now())
     on conflict (phone_hash) do update set code_hash = $2, expires_at = now() + interval '3 minutes',
       tries = 0, sends = $3, day = current_date, last_sent = now()`,
    [h, sha(h + code), sendsToday + 1]);
  hits.push(now); ipHits.set(ip, hits);
  await pool.query("insert into sms_sends default values");

  const text = `[Till Zero] 인증번호 ${code}`;
  if (sms) {
    try { await sms.send({ to: d, from: process.env.SOLAPI_FROM, text }); }
    catch (e) { console.error("sms", e.message); return res.status(502).json({ error: "문자를 보내지 못했어요. 잠시 뒤에 다시 해주세요" }); }
  } else {
    console.log(`[sms 준비 중] ${d.slice(0, 3)}-****-${d.slice(-4)} ${text}`);
  }
  res.json({ ok: true, wait: 60 });
});

app.post("/api/phone/verify", async (req, res) => {
  const d = phoneDigits(req.body?.phone), code = String(req.body?.code || "").replace(/\D/g, "");
  if (!validPhone(d) || code.length !== 6) return res.status(400).json({ error: "인증번호를 확인해주세요" });
  const h = phoneHash(d);
  const cur = (await pool.query("select * from phone_codes where phone_hash = $1", [h])).rows[0];
  if (!cur || new Date(cur.expires_at) < new Date()) return res.status(410).json({ error: "인증번호가 지났어요. 다시 받아주세요" });
  if (cur.tries >= 5) return res.status(429).json({ error: "여러 번 틀렸어요. 다시 받아주세요" });
  if (cur.code_hash !== sha(h + code)) {
    await pool.query("update phone_codes set tries = tries + 1 where phone_hash = $1", [h]);
    return res.status(400).json({ error: "인증번호가 맞지 않아요" });
  }
  await pool.query("update phone_codes set expires_at = now() where phone_hash = $1", [h]);   // 한 번 쓰면 끝
  const u = (await pool.query("select id from users where phone_hash = $1", [h])).rows[0];
  res.json({ ticket: makeTicket(h, d.slice(-4)), existing: !!u });
});

// 이미 이 번호로 쓰던 계정이 있으면 그 계정으로 들어간다
app.post("/api/phone/login", async (req, res) => {
  const t = readTicket(req.body?.ticket);
  if (!t) return res.status(400).json({ error: "인증이 지났어요. 다시 해주세요" });
  const u = (await pool.query("select * from users where phone_hash = $1", [t.h])).rows[0];
  if (!u) return res.status(404).json({ error: "이 번호로 쓰던 계정이 없어요" });
  res.json({ token: await newSession(u.id), me: meOf(u) });
});

// 새 계정. 번호 하나에 계정 하나
app.post("/api/signup", async (req, res) => {
  const t = readTicket(req.body?.ticket);
  if (!t) return res.status(400).json({ error: "인증이 지났어요. 다시 해주세요" });
  const nickname = String(req.body?.nickname || "").trim();
  if (!nickname) return res.status(400).json({ error: "이름을 입력해주세요" });
  if ((await pool.query("select 1 from users where phone_hash = $1", [t.h])).rowCount)
    return res.status(409).json({ error: "이 번호로 쓰던 계정이 있어요" });
  if ((await pool.query("select 1 from users where nickname = $1", [nickname])).rowCount)
    return res.status(409).json({ error: "이미 쓰는 이름이에요" });
  // pass_hash 는 옛 방식의 칸이라 아무도 알 수 없는 값으로 채운다
  const { rows } = await pool.query(
    "insert into users (nickname, dob, pass_hash, phone_hash, phone_tail) values ($1, $2, $3, $4, $5) returning *",
    [nickname, req.body?.dob || null, await bcrypt.hash(token(), 10), t.h, t.t]);
  res.json({ token: await newSession(rows[0].id), me: meOf(rows[0]) });
});

// 지금 로그인한 계정에 인증한 번호를 붙인다. 번호 없는 옛 계정은 처음 잇는 것이고,
// 번호가 있던 계정은 번호를 바꾸는 것이다. 예전 번호는 바로 풀려서, 그 번호를 나중에 받은 사람은 새 계정으로 들어온다
app.post("/api/phone/link", auth, async (req, res) => {
  const t = readTicket(req.body?.ticket);
  if (!t) return res.status(400).json({ error: "인증이 지났어요. 다시 해주세요" });
  const owner = (await pool.query("select id from users where phone_hash = $1", [t.h])).rows[0];
  if (owner && String(owner.id) !== String(req.user.id))
    return res.status(409).json({ error: "이 번호는 다른 계정에 연결돼 있어요" });
  await pool.query("update users set phone_hash = $2, phone_tail = $3 where id = $1", [req.user.id, t.h, t.t]);
  res.json({ ok: true, phone: masked(t.t) });
});

// 로그아웃한 상태에서 옛 닉네임·비밀번호 계정을 이 번호에 잇는다
app.post("/api/phone/legacy", async (req, res) => {
  const t = readTicket(req.body?.ticket);
  if (!t) return res.status(400).json({ error: "인증이 지났어요. 다시 해주세요" });
  const u = (await pool.query("select * from users where nickname = $1", [String(req.body?.nickname || "").trim()])).rows[0];
  if (!u || u.phone_hash || !(await bcrypt.compare(String(req.body?.password || ""), u.pass_hash)))
    return res.status(403).json({ error: "닉네임이나 비밀번호가 맞지 않아요" });
  if ((await pool.query("select 1 from users where phone_hash = $1", [t.h])).rowCount)
    return res.status(409).json({ error: "이 번호는 다른 계정에 연결돼 있어요" });
  await pool.query("update users set phone_hash = $2, phone_tail = $3 where id = $1", [u.id, t.h, t.t]);
  res.json({ token: await newSession(u.id), me: meOf({ ...u, phone_tail: t.t }) });
});

/* ---------- Till ---------- */

async function ensureSelfBond(userId) {
  await pool.query(
    "insert into bonds (a_id, b_id) values ($1, $1) on conflict (a_id, b_id) do nothing",
    [userId]
  );
}

const IN_ROOM = `(b.a_id = $1 or b.b_id = $1 or exists (select 1 from bond_members m where m.bond_id = b.id and m.user_id = $1))`;
app.get("/api/till", auth, async (req, res) => {
  await ensureSelfBond(req.user.id);
  const { rows } = await pool.query(`${BOND_SELECT} where ${IN_ROOM}`, [req.user.id]);
  const bonds = (await withMembers(rows)).map((r) => shape(r, req.user.id));
  // R-4.8: Count 높은 순, 같으면 마지막 대화가 최근인 순, 그다음 이름순
  bonds.sort(
    (x, y) =>
      y.dday - x.dday ||
      new Date(y.lastAt || 0) - new Date(x.lastAt || 0) ||
      x.name.localeCompare(y.name)
  );
  // sms: 문자가 실제로 나가는지. 준비되기 전에는 옛 계정에 번호 연결을 요구하지 않는다
  res.json({ me: { ...meOf(req.user), photo: req.user.photo }, bonds, sms: !!sms });
});

app.post("/api/profile", auth, async (req, res) => {
  const nickname = req.body?.nickname === undefined ? null : String(req.body.nickname).trim();
  if (nickname !== null && !nickname) return res.status(400).json({ error: "이름은 비울 수 없어요" });
  // photo: 문자열이면 새 사진, null이면 지우기, 없으면 그대로 둔다
  const photo = req.body?.photo === undefined ? req.user.photo : req.body.photo;
  if (typeof photo === "string" && photo.length > 400000)
    return res.status(413).json({ error: "사진이 너무 커요" });

  try {
    const { rows } = await pool.query(
      `update users set nickname = coalesce($2, nickname), photo = $3
        where id = $1 returning id, nickname, dob, photo`,
      [req.user.id, nickname, photo]
    );
    // 내 이름·사진은 상대 Till에도 보이므로 다시 그리게 알린다
    const { rows: bs } = await pool.query(
      "select a_id, b_id from bonds where a_id = $1 or b_id = $1",
      [req.user.id]
    );
    notify(
      bs.map((b) => (String(b.a_id) === String(req.user.id) ? b.b_id : b.a_id)),
      { type: "till" }
    );
    res.json({ me: rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "이미 쓰는 닉네임이에요" });
    res.status(500).json({ error: "저장하지 못했어요" });
  }
});

/* ---------- Bond 맺기 ---------- */

/* ---------- 방 코드 (2026-10-27) ----------
   초대 수단은 방 코드 하나다. 방마다 코드가 있고, 코드를 넣고 "들어가기"를 누르면 그 방에 들어간다(누른 것이 곧 동의).
   두 명이면 둘만의 방, 더 들어오면 단체방. 최대 10명. 방 안의 누구나 코드를 보내 사람을 부를 수 있고,
   새 코드로 바꾸면 이전 코드와 보낸 링크는 즉시 무효가 된다. 헷갈리는 글자(I·O·0·1)는 쓰지 않는다.
   차단 관계가 있는 사람이 있는 방에는 들어갈 수 없다. 나가면 나에게서만 사라지고, 둘보다 적어지면 방이 사라진다.
   새로 들어온 사람은 들어온 뒤의 대화만 본다. 방 설정에서 "이전 대화 보이기"를 켜면 처음부터 본다. */
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 6 }, () => CODE_ABC[crypto.randomInt(CODE_ABC.length)]).join("");
const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const GROUP_MAX = 10;
const cleanName = (n) => String(n || "").trim().slice(0, 20) || null;
const pairOf = (x, y) => [x, y].sort((p, q) => p - q);
async function bonded(x, y) {
  const [a, b] = pairOf(x, y);
  return (await pool.query("select 1 from bonds where kind = 'pair' and a_id = $1 and b_id = $2", [a, b])).rowCount > 0;
}
async function roomCode(bondId, renew) {
  if (!renew) {
    const r = await pool.query("select code from bonds where id = $1", [bondId]);
    if (r.rows[0]?.code) return r.rows[0].code;
  }
  for (let i = 0; i < 5; i++) {
    try { const c = newCode(); await pool.query("update bonds set code = $2 where id = $1", [bondId, c]); return c; }
    catch (e) { if (e.code !== "23505") throw e; }   // 겹치면 다시 뽑는다
  }
  throw new Error("코드를 만들지 못했어요");
}
// 남의 코드를 찍어 맞히지 못하게, 없는 코드를 10분에 10번 넘게 넣으면 잠시 막는다
const misses = new Map(); // userId -> [시각]
const tooMany = (uid) => {
  const now = Date.now(), a = (misses.get(uid) || []).filter((t) => now - t < 600000);
  misses.set(uid, a);
  return a.length >= 10;
};
async function roomByCode(req, res, code) {
  const uid = req.user.id;
  if (tooMany(uid)) { res.status(429).json({ error: "잠시 뒤에 다시 해주세요" }); return null; }
  const c = normCode(code);
  const row = c.length === 6 && (await pool.query(`${BOND_SELECT} where b.kind = 'group' and b.code = $1`, [c])).rows[0];
  if (!row) { misses.get(uid).push(Date.now()); res.status(404).json({ error: "없는 코드예요" }); return null; }
  return (await withMembers([row]))[0];
}
async function blockedWithAny(uid, ids) {
  if (!ids.length) return false;
  return (await pool.query(
    `select 1 from blocks where (blocker_id = $1 and blocked_id = any($2::bigint[])) or (blocked_id = $1 and blocker_id = any($2::bigint[]))`,
    [uid, ids])).rowCount > 0;
}
async function groupOf(id, me) { const b = await myBond(id, me); return b && b.kind === "group" ? b : null; }
// 나가기. 남은 사람이 둘보다 적으면 방을 지운다
async function leaveGroup(bondId, uid) {
  const before = (await pool.query("select user_id from bond_members where bond_id = $1", [bondId])).rows.map((r) => String(r.user_id));
  await pool.query("delete from bond_members where bond_id = $1 and user_id = $2", [bondId, uid]);
  if (before.filter((id) => id !== String(uid)).length < 2) await pool.query("delete from bonds where id = $1", [bondId]);
  notify(before, { type: "till" });
}

// 새 방. 나 혼자 있는 방이 생기고 코드가 붙는다. 7일 안에 아무도 안 들어오면 저절로 사라진다
app.post("/api/groups", auth, async (req, res) => {
  const b = await pool.query("insert into bonds (kind, name) values ('group', $1) returning id", [cleanName(req.body?.name)]);
  const id = b.rows[0].id;
  await pool.query("insert into bond_members (bond_id, user_id) values ($1, $2)", [id, req.user.id]);
  const code = await roomCode(id, false);
  notify([String(req.user.id)], { type: "till" });
  res.json({ bondId: id, code });
});
app.get("/api/groups/:id/code", auth, async (req, res) => {
  const bond = await groupOf(req.params.id, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 방이에요" });
  res.json({ code: await roomCode(bond.id, false) });
});
app.post("/api/groups/:id/code/renew", auth, async (req, res) => {
  const bond = await groupOf(req.params.id, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 방이에요" });
  res.json({ code: await roomCode(bond.id, true) });
});
// 코드로 방 미리 보기. 들어가기 전에 어떤 방인지 보여준다
app.get("/api/join/:code", auth, async (req, res) => {
  const b = await roomByCode(req, res, req.params.code);
  if (!b) return;
  const me = String(req.user.id);
  res.json({ bondId: b.id, name: b.name || (b.members || []).map((m) => m.nickname).slice(0, 4).join(", "),
    count: (b.members || []).length, already: memberIds(b).includes(me) });
});
app.post("/api/join", auth, async (req, res) => {
  const b = await roomByCode(req, res, req.body?.code);
  if (!b) return;
  const me = String(req.user.id), members = memberIds(b);
  if (members.includes(me)) return res.json({ bondId: b.id });
  if (members.length >= GROUP_MAX) return res.status(409).json({ error: "방이 다 찼어요" });
  // 차단 관계가 있는 사람이 있으면 들어갈 수 없다. 누구 때문인지는 말하지 않는다
  if (await blockedWithAny(me, members)) return res.status(403).json({ error: "들어갈 수 없는 방이에요" });
  await pool.query("insert into bond_members (bond_id, user_id) values ($1, $2) on conflict do nothing", [b.id, me]);
  notify([...members, me], { type: "till" });
  for (const id of members) push(id, "req", { title: roomName(b, id), body: `${req.user.nickname}님이 들어왔어요` });   // R-6.1
  res.json({ bondId: b.id });
});
app.post("/api/groups/:id/leave", auth, async (req, res) => {
  const bond = await groupOf(req.params.id, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 방이에요" });
  await leaveGroup(bond.id, req.user.id);
  res.json({ ok: true });
});
app.post("/api/groups/:id/name", auth, async (req, res) => {
  const bond = await groupOf(req.params.id, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 방이에요" });
  await pool.query("update bonds set name = $2 where id = $1", [bond.id, cleanName(req.body?.name)]);
  notify(memberIds(bond), { type: "till" });
  res.json({ ok: true });
});
// 이전 대화 보이기. 방 안의 누구나 바꿀 수 있고, 지금 있는 사람과 앞으로 올 사람 모두에게 적용된다
app.post("/api/groups/:id/history", auth, async (req, res) => {
  const bond = await groupOf(req.params.id, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 방이에요" });
  await pool.query("update bonds set show_history = $2 where id = $1", [bond.id, !!req.body?.on]);
  notify(memberIds(bond), { type: "till" });
  res.json({ ok: true });
});

/* ---------- 차단과 신고 (R-8.5) ---------- */

// Zero 와 똑같이 지운다. 7일 대기(R-3.8)와 신고 대응(R-8.6)을 위해 누구와 언제였는지만 남긴다
async function zeroBond(bond) {
  await pool.query("delete from bonds where id = $1", [bond.id]);
  await pool.query("insert into zeros (a_id, b_id) values ($1, $2)", [bond.a_id, bond.b_id]);
  notify([String(bond.a_id), String(bond.b_id)], { type: "till" });
}
const otherOf = (bond, me) => (String(bond.a_id) === String(me) ? bond.b_id : bond.a_id);

// 1:1 방이면 bondId, 단체방의 한 사람이면 userId. 같은 방에 있는 사람만 차단할 수 있다.
// 1:1 은 Zero 와 똑같이 사라지고(R-8.5), 그 사람과 함께 있는 단체방에서는 내가 조용히 빠진다(D-2).
app.post("/api/block", auth, async (req, res) => {
  const me = String(req.user.id);
  let other = null;
  if (req.body?.bondId) {
    const bond = await myBond(req.body.bondId, me);
    if (!bond || bond.kind === "group") return res.status(404).json({ error: "없는 대화예요" });
    if (String(bond.a_id) === String(bond.b_id)) return res.status(400).json({ error: "나와의 대화는 차단할 수 없어요" });
    other = String(otherOf(bond, me));
  } else {
    other = String(Number(req.body?.userId) || "");
    const shared = (await pool.query(
      `select 1 from bond_members a join bond_members b on a.bond_id = b.bond_id where a.user_id = $1 and b.user_id = $2`, [me, other])).rowCount;
    if (!other || other === me || (!shared && !(await bonded(me, other)))) return res.status(404).json({ error: "없는 사람이에요" });
  }
  await pool.query("insert into blocks (blocker_id, blocked_id) values ($1, $2) on conflict do nothing", [me, other]);
  await pool.query("delete from requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)", [me, other]);
  const [a, b] = pairOf(me, other);
  const pair = (await pool.query("select * from bonds where kind = 'pair' and a_id = $1 and b_id = $2", [a, b])).rows[0];
  if (pair) await zeroBond(pair);
  const shared = (await pool.query(
    `select a.bond_id from bond_members a join bond_members b on a.bond_id = b.bond_id where a.user_id = $1 and b.user_id = $2`, [me, other])).rows;
  for (const r of shared) await leaveGroup(r.bond_id, me);
  res.json({ ok: true });
});
app.get("/api/blocks", auth, async (req, res) => {
  const { rows } = await pool.query(
    `select u.id, u.nickname from blocks k join users u on u.id = k.blocked_id
      where k.blocker_id = $1 order by k.created_at desc`, [req.user.id]);
  res.json({ blocks: rows.map((r) => ({ id: r.id, name: r.nickname })) });
});
app.post("/api/blocks/:id/remove", auth, async (req, res) => {
  await pool.query("delete from blocks where blocker_id = $1 and blocked_id = $2", [req.user.id, Number(req.params.id) || 0]);
  res.json({ ok: true });
});

// 신고는 최근 대화 50개를 함께 남긴다. 운영자만 보고 90일 뒤 지운다(R-8.6)
const REASONS = ["스팸·광고", "욕설·괴롭힘", "음란물", "사칭", "기타"];
app.post("/api/report", auth, async (req, res) => {
  const bond = await myBond(req.body?.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  if (String(bond.a_id) === String(bond.b_id) && bond.kind !== "group") return res.status(400).json({ error: "나와의 대화는 신고할 수 없어요" });
  const reason = REASONS.includes(req.body?.reason) ? req.body.reason : "기타";
  // 단체방은 방 전체를 신고한다(대상 칸은 비운다)
  const { rows } = await pool.query(
    "select id, sender_id, body, created_at from messages where bond_id = $1 order by id desc limit 50", [bond.id]);
  await pool.query("insert into reports (reporter_id, target_id, reason, snapshot) values ($1, $2, $3, $4)",
    [req.user.id, bond.kind === "group" ? null : otherOf(bond, req.user.id), reason, JSON.stringify(rows.reverse())]);
  res.json({ ok: true });
});

/* ---------- 계정 삭제 (R-8.4) ----------
   잘못 누르는 일이 없게 "삭제"를 직접 입력해야 한다(비밀번호는 휴대폰 인증으로 바뀌며 없어졌다). 지우면 세션·Bond·대화·도구 데이터·차단·요청·알림 구독·Zero 기록이 함께 지워진다.
   신고 기록에는 보낸 사람 칸만 비운 채 90일까지 남는다(R-8.6). */
app.post("/api/me/delete", auth, async (req, res) => {
  if (req.body?.confirm !== "삭제") return res.status(400).json({ error: "삭제라고 입력해주세요" });
  const partners = (await pool.query("select a_id, b_id from bonds where a_id = $1 or b_id = $1", [req.user.id])).rows
    .flatMap((r) => [String(r.a_id), String(r.b_id)]).filter((id) => id !== String(req.user.id));
  const groups = (await pool.query("select bond_id from bond_members where user_id = $1", [req.user.id])).rows;
  for (const g of groups) await leaveGroup(g.bond_id, req.user.id);
  await pool.query("delete from users where id = $1", [req.user.id]);
  notify(partners, { type: "till" });
  for (const w of sockets.get(String(req.user.id)) || []) w.close();
  res.json({ ok: true });
});

/* ---------- 알림 (R-6) ---------- */

app.get("/api/push/key", (req, res) => res.json({ key: webpush ? process.env.VAPID_PUBLIC : null }));
app.post("/api/push/sub", auth, async (req, res) => {
  const sub = req.body?.sub;
  if (!sub?.endpoint || !sub?.keys) return res.status(400).json({ error: "알림을 켜지 못했어요" });
  await pool.query(
    `insert into push_subs (endpoint, user_id, data) values ($1, $2, $3)
       on conflict (endpoint) do update set user_id = $2, data = $3`, [sub.endpoint, req.user.id, sub]);
  res.json({ ok: true });
});
app.post("/api/push/unsub", auth, async (req, res) => {
  await pool.query("delete from push_subs where endpoint = $1 and user_id = $2", [String(req.body?.endpoint || ""), req.user.id]);
  res.json({ ok: true });
});
const NOTI_KEYS = ["msg", "req", "dday", "dnd"];
app.get("/api/me/noti", auth, async (req, res) => {
  const { rows } = await pool.query("select noti from users where id = $1", [req.user.id]);
  res.json({ noti: { msg: true, req: true, dday: true, dnd: false, ...rows[0].noti } });
});
app.post("/api/me/noti", auth, async (req, res) => {
  const n = {};
  for (const k of NOTI_KEYS) if (typeof req.body?.[k] === "boolean") n[k] = req.body[k];
  await pool.query("update users set noti = noti || $2::jsonb where id = $1", [req.user.id, JSON.stringify(n)]);
  res.json({ ok: true });
});

// 알림은 세 종류뿐이다(R-6.1): msg 메시지, req 요청·수락, dday Count 경고.
// 사용자가 끈 종류, 방해 금지 시간(한국 시간 23–08시), 지금 앱을 보고 있을 때는 보내지 않는다.
async function push(uid, kind, payload) {
  if (!webpush) return;
  try {
    if ([...(sockets.get(String(uid)) || [])].some((w) => w.visible)) return;
    const u = (await pool.query("select noti from users where id = $1", [uid])).rows[0];
    if (!u) return;
    const n = { msg: true, req: true, dday: true, dnd: false, ...u.noti };
    if (n[kind] === false) return;
    if (n.dnd) {
      const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", hour: "numeric", hourCycle: "h23" }).format(new Date()));
      if (h >= 23 || h < 8) return;
    }
    const subs = (await pool.query("select endpoint, data from push_subs where user_id = $1", [uid])).rows;
    for (const s of subs)
      webpush.sendNotification(s.data, JSON.stringify(payload), { TTL: 86400 }).catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) pool.query("delete from push_subs where endpoint = $1", [s.endpoint]);
      });
  } catch (e) { console.error("push", e.message); }
}

/* ---------- 대화 ---------- */

app.get("/api/messages/:bondId", auth, async (req, res) => {
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const mine = bond.kind === "group" && (bond.members || []).find((m) => String(m.id) === String(req.user.id));
  const since = mine && !bond.show_history ? mine.joined_at : new Date(0);
  const { rows } = await pool.query(
    "select id, sender_id, body, kind, media, w, h, created_at from messages where bond_id = $1 and created_at >= $2 order by id",
    [bond.id, since]
  );
  // 여는 순간 읽은 것으로 친다 (R-7.4에 따라 상대에게는 알리지 않는다)
  if (bond.kind === "group") {
    await pool.query("update bond_members set read_at = now() where bond_id = $1 and user_id = $2", [bond.id, req.user.id]);
  } else {
    const iAmA = String(bond.a_id) === String(req.user.id);
    await pool.query(`update bonds set ${iAmA ? "a_read_at" : "b_read_at"} = now() where id = $1`, [bond.id]);
  }
  res.json({
    bond: shape(bond, req.user.id),
    messages: rows.map((m) => ({
      id: m.id,
      mine: m.sender_id === req.user.id,
      from: String(m.sender_id),
      body: m.body,
      kind: m.kind || "text",
      media: m.media,
      w: m.w, h: m.h,
      at: m.created_at,
    })),
  });
});

app.post("/api/messages", auth, async (req, res) => {
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ error: "빈 메시지는 보낼 수 없어요" });
  const bond = await myBond(req.body?.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  sendMessage(req, res, bond, { body, kind: "text" });
});

/* ---------- 사진·동영상 ----------
   사진은 앱이 1600px 로 줄여서 보내고(약 0.3MB), 동영상은 500MB 까지 그대로 받는다.
   메모리에 통째로 올리지 않고 받는 대로 디스크에 쓴다.
   파일은 서버 디스크(MEDIA_DIR)에 두고, 방이 사라지거나 메시지가 지워지면 한 시간 안에 함께 지운다.
   같은 서버에 다른 서비스가 돌고 있으므로, 미디어 전체가 8GB 를 넘거나 디스크 여유가 4GB 아래면 받지 않는다(서버 디스크 24GB).
   보기는 그 방에 있는 사람만 된다(로그인 토큰을 주소에 붙여 확인). 동영상은 구간 요청(Range)을 받아 바로 재생된다. */
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, "media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_CAP = 8 * 1024 ** 3, DISK_FLOOR = 4 * 1024 ** 3;
const VIDEO_MAX = 500 * 1024 ** 2, IMAGE_MAX = 10 * 1024 ** 2;
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
let mediaBytes = 0;
try { for (const f of fs.readdirSync(MEDIA_DIR)) mediaBytes += fs.statSync(path.join(MEDIA_DIR, f)).size; } catch (e) {}
const diskFree = () => { try { const st = fs.statfsSync(MEDIA_DIR); return st.bavail * st.bsize; } catch (e) { return Infinity; } };

app.post("/api/messages/media", auth, async (req, res) => {
  const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ext = EXT[mime];
  const kind = mime.startsWith("video/") ? "video" : "image";
  const max = kind === "video" ? VIDEO_MAX : IMAGE_MAX, big = kind === "video" ? "동영상이 너무 커요" : "사진이 너무 커요";
  const len = Number(req.get("content-length")) || 0;
  if (!ext) return res.status(400).json({ error: "보낼 수 없는 파일이에요" });
  if (len > max) return res.status(413).json({ error: big });
  if (mediaBytes + len > MEDIA_CAP || diskFree() - len < DISK_FLOOR)
    return res.status(507).json({ error: "지금은 사진·동영상을 보낼 수 없어요" });
  const bond = await myBond(req.query.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const id = crypto.randomBytes(16).toString("hex") + "." + ext, fp = path.join(MEDIA_DIR, id);
  // 받는 대로 파일에 쓴다. 한도를 넘거나 중간에 끊기면 쓰던 파일을 지운다
  let size = 0;
  const cap = new Transform({ transform(c, e, cb) { size += c.length; cb(size > max ? Object.assign(new Error(big), { big: true }) : null, c); } });
  try { await pipeline(req, cap, fs.createWriteStream(fp)); }
  catch (e) {
    fs.rm(fp, { force: true }, () => {});
    if (!res.headersSent && !res.destroyed) res.status(e.big ? 413 : 400).json({ error: e.big ? big : "보내지 못했어요" });
    return;
  }
  if (!size) { fs.rm(fp, { force: true }, () => {}); return res.status(400).json({ error: "보낼 수 없는 파일이에요" }); }
  mediaBytes += size;
  const dim = (v) => Math.max(0, Math.min(20000, Number(v) || 0)) || null;
  sendMessage(req, res, bond, { body: kind === "video" ? "동영상" : "사진", kind, media: id, mime, size, w: dim(req.query.w), h: dim(req.query.h) });
});

// 보낸 메시지 지우기(R-7.6): 보낸 사람만, 방 모두의 화면에서 사라진다. 이미 일어난 Reset 은 되돌리지 않는다.
// 사진·동영상 파일은 메시지가 없어지는 즉시 아무도 못 받고(받기는 메시지 행을 확인한다), 한 시간 안에 정리된다
app.delete("/api/messages/:id", auth, async (req, res) => {
  const { rows } = await pool.query("delete from messages where id = $1 and sender_id = $2 returning id, bond_id",
    [Number(req.params.id) || 0, req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "지울 수 없는 메시지예요" });
  const bond = await myBond(rows[0].bond_id, req.user.id);
  if (bond) notify(memberIds(bond), { type: "deleted", bondId: bond.id, id: String(rows[0].id) }, req.user.id);
  res.json({ ok: true });
});

// 미리보기 올리기: 보낸 사람이 원본을 올린 뒤 곧바로 보낸다. 파일 이름은 원본이름.t.jpg
app.post("/api/media/:id/thumb", auth, express.raw({ type: () => true, limit: "2mb" }), async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(id) || !Buffer.isBuffer(req.body) || !req.body.length) return res.sendStatus(400);
  const own = (await pool.query("select 1 from messages where media = $1 and sender_id = $2", [id, req.user.id])).rowCount;
  if (!own) return res.sendStatus(404);
  fs.writeFileSync(path.join(MEDIA_DIR, id + ".t.jpg"), req.body);
  mediaBytes += req.body.length;
  res.json({ ok: true });
});

app.get("/api/media/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-f0-9]{32}\.[a-z0-9]{2,5}$/.test(id)) return res.sendStatus(404);
  const s = (await pool.query("select user_id from sessions where token = $1", [String(req.query.t || "")])).rows[0];
  if (!s) return res.sendStatus(401);
  const m = (await pool.query(
    `select m.mime, m.bond_id from messages m join bonds b on b.id = m.bond_id
      where m.media = $1 and (b.a_id = $2 or b.b_id = $2 or exists (select 1 from bond_members x where x.bond_id = b.id and x.user_id = $2))`,
    [id, s.user_id])).rows[0];
  if (!m) return res.sendStatus(404);
  // ?s=t 이면 미리보기. 아직 없으면(올리는 중) 사진은 원본을 주고, 동영상은 없다고 한다(원본이 크다)
  const thumb = req.query.s === "t" && fs.existsSync(path.join(MEDIA_DIR, id + ".t.jpg"));
  if (req.query.s === "t" && !thumb && m.mime.startsWith("video/")) return res.set("Cache-Control", "no-store").sendStatus(404);
  res.sendFile(path.join(MEDIA_DIR, thumb ? id + ".t.jpg" : id),
    { headers: { "Content-Type": thumb ? "image/jpeg" : m.mime, "Cache-Control": "private, max-age=2592000, immutable" } },
    (e) => { if (e && !res.headersSent) res.sendStatus(404); });
});

// 글·사진·동영상 공통: 메시지를 남기고 Count 규칙을 적용하고 알린다
async function sendMessage(req, res, bond, m) {
  const body = m.body;
  if (bond.kind === "group") return groupMessage(req, res, bond, m);
  const isSelf = String(bond.a_id) === String(bond.b_id);
  // R-11: Zero 처리가 먼저면 메시지는 거부된다. 나와의 방은 Zero가 없다.
  if (!isSelf && ddayOf(bond.last_reset_at) <= 0)
    return res.status(410).json({ error: "이 대화는 끝났어요" });

  const { rows } = await pool.query(
    "insert into messages (bond_id, sender_id, body, kind, media, mime, size, w, h) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, created_at",
    [bond.id, req.user.id, body, m.kind || "text", m.media || null, m.mime || null, m.size || null, m.w || null, m.h || null]
  );

  // R-4.2 / R-4.3: 양쪽이 각각 한 번 이상 보냈을 때만 Reset한다. 나와의 방은 셈하지 않는다.
  if (isSelf) {
    const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null };
    notify([req.user.id], { type: "message", ...msg }, req.user.id);
    return res.json({ ...msg, reset: false });
  }
  const iAmA = bond.a_id === req.user.id;
  const aSent = bond.a_sent || iAmA;
  const bSent = bond.b_sent || !iAmA;
  const reset = aSent && bSent;
  await pool.query(
    reset
      ? `update bonds set keep = keep + 1, last_reset_at = now(),
                          a_sent = false, b_sent = false, warned = null where id = $1`
      : "update bonds set a_sent = $2, b_sent = $3 where id = $1",
    reset ? [bond.id] : [bond.id, aSent, bSent]
  );

  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, from: String(req.user.id), kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null };
  notify([bond.a_id, bond.b_id], { type: "message", ...msg }, req.user.id);
  push(iAmA ? bond.b_id : bond.a_id, "msg", { title: req.user.nickname, body: body.slice(0, 120), tag: "bond-" + bond.id });
  res.json({ ...msg, reset });
}

// 방 메시지. 마지막 Reset 이후 두 사람 이상이 말하면 Count 가 30 으로 돌아가고 Keep 이 오른다.
// 두 명 방에서는 R-4.2 그대로(둘 다 한 번씩). Reset 을 만든 메시지는 다음 회차에 세지 않는다(R-4.4)
async function groupMessage(req, res, bond, m) {
  const body = m.body;
  if (ddayOf(bond.last_reset_at) <= 0) return res.status(410).json({ error: "이 대화는 끝났어요" });
  const { rows } = await pool.query(
    "insert into messages (bond_id, sender_id, body, kind, media, mime, size, w, h) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, created_at",
    [bond.id, req.user.id, body, m.kind || "text", m.media || null, m.mime || null, m.size || null, m.w || null, m.h || null]);
  const sp = new Set((bond.speakers || []).map(String)); sp.add(String(req.user.id));
  const reset = sp.size >= 2;
  await pool.query(
    reset ? "update bonds set last_reset_at = now(), keep = keep + 1, speakers = '[]'::jsonb, warned = null where id = $1"
          : "update bonds set speakers = $2::jsonb where id = $1",
    reset ? [bond.id] : [bond.id, JSON.stringify([...sp])]);
  await pool.query("update bond_members set read_at = now() where bond_id = $1 and user_id = $2", [bond.id, req.user.id]);
  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, from: String(req.user.id), kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null };
  const ids = memberIds(bond);
  notify(ids, { type: "message", ...msg }, req.user.id);
  for (const id of ids) if (id !== String(req.user.id))
    push(id, "msg", { title: roomName(bond, id), body: `${req.user.nickname}: ${body}`.slice(0, 120), tag: "bond-" + bond.id });
  res.json({ ...msg, reset });
}

async function myBond(bondId, meId) {
  const { rows } = await pool.query(
    `${BOND_SELECT} where b.id = $2 and ${IN_ROOM}`,
    [meId, Number(bondId) || 0]
  );
  return (await withMembers(rows))[0];
}

/* ---------- 내가 설치한 도구 ----------
   설치는 계정 단위다. 어느 방에서 실제로 쓸지는 방 안에서 따로 정한다. */

app.get("/api/me/tools", auth, async (req, res) => {
  const { rows } = await pool.query("select tools from users where id = $1", [req.user.id]);
  res.json({ tools: rows[0]?.tools || [] });
});

app.post("/api/me/tools", auth, async (req, res) => {
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ error: "도구를 지정해주세요" });
  const { rows } = await pool.query("select tools from users where id = $1", [req.user.id]);
  const set = new Set(rows[0]?.tools || []);
  req.body?.on ? set.add(id) : set.delete(id);
  const tools = [...set];
  await pool.query("update users set tools = $2 where id = $1", [req.user.id, JSON.stringify(tools)]);
  res.json({ tools });
});

/* ---------- 도구가 쓰는 방 저장소 ----------
   도구 하나가 방 하나에 데이터 한 덩어리를 갖는다. 둘이 같이 본다.
   Bond가 지워지면(Zero) 함께 지워진다 — 테이블의 on delete cascade가 보장한다. */

// 내 방들에서 이 도구가 어떤 상태인지 한 번에
app.get("/api/rooms/:tool", auth, async (req, res) => {
  const { rows } = await pool.query(
    `select r.bond_id, r.data from room_state r
       join bonds b on b.id = r.bond_id
      where r.tool = $2 and ${IN_ROOM}`,
    [req.user.id, req.params.tool]
  );
  const rooms = {};
  rows.forEach((r) => (rooms[r.bond_id] = r.data));
  res.json({ rooms });
});

app.get("/api/room/:bondId/:tool", auth, async (req, res) => {
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const { rows } = await pool.query(
    "select data from room_state where bond_id = $1 and tool = $2",
    [bond.id, req.params.tool]
  );
  res.json({ data: rows[0]?.data ?? null });
});

app.post("/api/room/:bondId/:tool", auth, async (req, res) => {
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const data = req.body?.data;
  if (data === undefined || typeof data !== "object" || data === null)
    return res.status(400).json({ error: "저장할 내용이 없어요" });
  if (JSON.stringify(data).length > 100000)
    return res.status(413).json({ error: "내용이 너무 커요" });

  await pool.query(
    `insert into room_state (bond_id, tool, data) values ($1, $2, $3)
       on conflict (bond_id, tool) do update set data = $3, updated_at = now()`,
    [bond.id, req.params.tool, data]
  );
  // 상대에게 바뀐 것을 알린다
  notify(memberIds(bond), { type: "room", bondId: bond.id, tool: req.params.tool }, req.user.id);
  res.json({ ok: true });
});

/* ---------- 실시간 알림 ---------- */

const sockets = new Map(); // userId -> Set<ws>

function notify(userIds, payload, exceptUserId) {
  for (const raw of userIds) {
    const id = String(raw);
    if (exceptUserId !== undefined && id === String(exceptUserId)) continue;
    for (const ws of sockets.get(id) || []) {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    }
  }
}

const server = http.createServer(app);
server.requestTimeout = 30 * 60 * 1000;   // 큰 동영상은 느린 망에서 몇 분씩 걸린다(기본 5분이면 중간에 끊긴다)
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const t = new URL(req.url, "http://x").searchParams.get("token") || "";
  const { rows } = await pool.query(
    "select s.user_id, u.phone_tail from sessions s join users u on u.id = s.user_id where s.token = $1", [t]);
  if (!rows[0]) return ws.close(4001, "unauthorized");
  if (sms && !rows[0].phone_tail) return ws.close(4003, "phone required");   // R-8.1

  const uid = String(rows[0].user_id);
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(ws);
  ws.visible = true;
  ws.on("message", (m) => { try { const d = JSON.parse(m); if (d.type === "vis") ws.visible = !!d.v; } catch (e) {} });
  ws.on("close", () => sockets.get(uid)?.delete(ws));
});

/* ---------- 시작 ---------- */

// 키보드 기록. 아이폰에서만 보이는 움직임을 PC에서 읽기 위한 임시 창구 — kb.log 에 덧붙인다.
app.post("/api/kblog", auth, (req, res) => {
  const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 80) : [];
  const head = `--- ${new Date().toISOString()} ${req.user.nickname} ${String(req.body?.ua || "").slice(0, 160)} standalone=${req.body?.standalone}`;
  require("fs").appendFile("/opt/tillzero/kb.log", [head, ...lines.map((l) => String(l).slice(0, 200)), ""].join("\n"), () => {});
  res.json({ ok: true });
});

/* ---------- 한 시간마다 ---------- */
async function sweep() {
  // R-5.1 / R-5.6: Count 가 0 이 된 Bond 는 대화·도구 데이터와 함께 서버에서도 지운다. 알리지 않는다(R-5.3)
  const z = await pool.query(
    "delete from bonds where kind = 'pair' and a_id <> b_id and last_reset_at <= now() - interval '30 days' returning id, a_id, b_id");
  for (const b of z.rows) {
    await pool.query("insert into zeros (a_id, b_id) values ($1, $2)", [b.a_id, b.b_id]);
    notify([String(b.a_id), String(b.b_id)], { type: "till" });
  }
  // 30일 안에 두 사람 이상이 말하지 않은 방은 사라진다. 알리지 않는다
  const gz = await withMembers((await pool.query(
    `${BOND_SELECT} where b.kind = 'group' and b.last_reset_at <= now() - interval '30 days'`)).rows);
  for (const b of gz) { await pool.query("delete from bonds where id = $1", [b.id]); notify(memberIds(b), { type: "till" }); }
  // 만든 지 7일이 지나도록 아무도 들어오지 않은 방은 지운다
  await pool.query(
    `delete from bonds b where b.kind = 'group' and b.bond_at < now() - interval '7 days'
       and (select count(*) from bond_members m where m.bond_id = b.id) < 2`);
  // R-6.2: 7일, 1일 남았을 때 한 번씩. Reset 되면 다시(R-6.3)
  const w = await pool.query(
    `select b.id, b.a_id, b.b_id, b.last_reset_at, b.warned, ua.nickname an, ub.nickname bn
       from bonds b join users ua on ua.id = b.a_id join users ub on ub.id = b.b_id where b.kind = 'pair' and b.a_id <> b.b_id`);
  for (const b of w.rows) {
    const d = ddayOf(b.last_reset_at), lvl = d <= 1 ? 1 : d <= 7 ? 7 : null;
    if (!lvl || (b.warned && b.warned <= lvl)) continue;
    await pool.query("update bonds set warned = $2 where id = $1", [b.id, lvl]);
    push(b.a_id, "dday", { title: "Till Zero", body: `${b.bn} · ${d}일 남았어요`, tag: "bond-" + b.id });
    push(b.b_id, "dday", { title: "Till Zero", body: `${b.an} · ${d}일 남았어요`, tag: "bond-" + b.id });
  }
  const gw = await withMembers((await pool.query(`${BOND_SELECT} where b.kind = 'group'`)).rows);
  for (const b of gw) {
    const d = ddayOf(b.last_reset_at), lvl = d <= 1 ? 1 : d <= 7 ? 7 : null;
    if (!lvl || (b.warned && b.warned <= lvl)) continue;
    await pool.query("update bonds set warned = $2 where id = $1", [b.id, lvl]);
    for (const id of memberIds(b)) push(id, "dday", { title: "Till Zero", body: `${roomName(b, id)} · ${d}일 남았어요`, tag: "bond-" + b.id });
  }
  await pool.query("delete from requests where created_at < now() - interval '7 days'");
  await pool.query("delete from zeros where zeroed_at < now() - interval '90 days'");
  await pool.query("delete from reports where created_at < now() - interval '90 days'");
  // 주인 없는 사진·동영상 파일 정리. 올리는 중인 파일을 건드리지 않게 한 시간 지난 것만
  const used = new Set((await pool.query("select media from messages where media is not null")).rows.map((r) => r.media));
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    const fp = path.join(MEDIA_DIR, f), st = fs.statSync(fp);
    if (!used.has(f.replace(/\.t\.jpg$/, "")) && Date.now() - st.mtimeMs > 3600000) { fs.unlinkSync(fp); mediaBytes = Math.max(0, mediaBytes - st.size); }
  }
  // 인증 문자 기록은 하루만
  await pool.query("delete from sms_sends where at < now() - interval '1 day'");
  await pool.query("delete from phone_codes where last_sent < now() - interval '1 day'");
}
setTimeout(() => sweep().catch((e) => console.error("sweep", e.message)), 10000);
setInterval(() => sweep().catch((e) => console.error("sweep", e.message)), 3600000);

app.get("/health", (_, res) => res.json({ ok: true, now: new Date().toISOString() }));

server.listen(PORT, "127.0.0.1", () =>
  console.log(`till zero server on 127.0.0.1:${PORT}`)
);
