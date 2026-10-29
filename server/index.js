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
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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
    "select u.id, u.nickname, u.dob, u.photo, u.phone_tail, u.banned_at from sessions s join users u on u.id = s.user_id where s.token = $1",
    [t]
  );
  if (!rows[0]) return res.status(401).json({ error: "로그인이 필요해요" });
  req.user = rows[0];
  if (rows[0].banned_at && req.path !== "/api/me/delete") return res.status(403).json({ error: "이용이 제한된 계정이에요", need: "banned" });
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
  if (process.env.REVIEW_PHONE && d === process.env.REVIEW_PHONE && /^[0-9]{6}$/.test(process.env.REVIEW_CODE || "")) {
    const rh = phoneHash(d);
    await pool.query(
      `insert into phone_codes (phone_hash, code_hash, expires_at, tries, sends, day, last_sent)
         values ($1, $2, now() + interval '30 minutes', 0, 0, current_date, now())
       on conflict (phone_hash) do update set code_hash = $2, expires_at = now() + interval '30 minutes', tries = 0`,
      [rh, sha(rh + process.env.REVIEW_CODE)]);
    return res.json({ ok: true });
  }
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
  res.json({ me: { ...meOf(req.user), photo: req.user.photo }, bonds, sms: !!sms, admin: isAdmin(req.user.id) });
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
  // 메시지를 길게 눌러 신고하면 그 메시지와 보낸 사람이 대상. 방 설정에서 신고하면 단체방은 방 전체(대상 칸은 비운다)
  const mid = Number(req.body?.messageId) || 0;
  const msg = mid ? (await pool.query("select id, sender_id, body, kind, media, created_at from messages where id = $1 and bond_id = $2", [mid, bond.id])).rows[0] : null;
  const { rows } = await pool.query(
    "select id, sender_id, body, created_at from messages where bond_id = $1 order by id desc limit 50", [bond.id]);
  const snap = rows.reverse();
  if (msg && !snap.some((r) => String(r.id) === String(msg.id))) snap.unshift(msg);
  await pool.query("insert into reports (reporter_id, target_id, reason, snapshot, message_id) values ($1, $2, $3, $4, $5)",
    [req.user.id, msg ? msg.sender_id : bond.kind === "group" ? null : otherOf(bond, req.user.id), reason, JSON.stringify(snap), msg ? msg.id : null]);
  for (const id of ADMINS) { push(id, "admin", { title: "Till Zero", body: `신고 · ${reason}`, tag: "report" }); notify([id], { type: "report" }); }
  res.json({ ok: true });
});

/* ---------- 운영자: 신고 처리 ----------
   운영자 계정(.env ADMIN_IDS, 쉼표로 여러 명)만 쓴다. 처리: 메시지 삭제(방 모두의 화면에서 사라짐) · 계정 정지(그 계정은 계정 삭제만 됨) · 넘기기.
   처리한 신고는 맨 아래로 내려가고, 무엇을 했는지 남는다 */
const ADMINS = new Set(String(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const isAdmin = (id) => ADMINS.has(String(id));
const adminOnly = (req, res, next) => (isAdmin(req.user.id) ? next() : res.sendStatus(404));
app.get("/api/admin/reports", auth, adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    `select r.id, r.reason, r.created_at, r.resolved_at, r.action, r.message_id, r.snapshot, r.target_id,
            a.nickname as reporter, t.nickname as target, t.banned_at, m.body as msg_body, m.kind as msg_kind
       from reports r left join users a on a.id = r.reporter_id left join users t on t.id = r.target_id
       left join messages m on m.id = r.message_id
      order by r.resolved_at is not null, r.id desc limit 100`);
  const ids = new Set(); rows.forEach((r) => (r.snapshot || []).forEach((x) => ids.add(String(x.sender_id))));
  const names = new Map((await pool.query("select id, nickname from users where id = any($1::bigint[])", [[...ids]])).rows.map((u) => [String(u.id), u.nickname]));
  res.json({ reports: rows.map((r) => ({
    id: String(r.id), reason: r.reason, at: r.created_at, resolved: !!r.resolved_at, action: r.action,
    reporter: r.reporter || "-", target: r.target || null, targetId: r.target_id ? String(r.target_id) : null, banned: !!r.banned_at,
    messageId: r.message_id ? String(r.message_id) : null,
    message: r.message_id ? (r.msg_kind === "image" ? "사진" : r.msg_kind === "video" ? "동영상" : r.msg_body ?? null) : null,
    context: (r.snapshot || []).slice(-6).map((x) => `${names.get(String(x.sender_id)) || "?"}: ${x.body}`),
  })) });
});
app.post("/api/admin/reports/:id", auth, adminOnly, async (req, res) => {
  const r = (await pool.query("select * from reports where id = $1", [Number(req.params.id) || 0])).rows[0];
  if (!r) return res.sendStatus(404);
  const act = ["delmsg", "ban", "dismiss"].includes(req.body?.action) ? req.body.action : null;
  if (!act) return res.status(400).json({ error: "처리할 수 없어요" });
  if (act === "delmsg" && r.message_id) {
    const m = (await pool.query("delete from messages where id = $1 returning id, bond_id", [r.message_id])).rows[0];
    if (m) {
      const who = (await pool.query(
        "select user_id as id from bond_members where bond_id = $1 union select a_id from bonds where id = $1 union select b_id from bonds where id = $1", [m.bond_id])).rows;
      notify(who.map((x) => x.id), { type: "deleted", bondId: String(m.bond_id), id: String(m.id) });
    }
  }
  if (act === "ban" && r.target_id) {
    await pool.query("update users set banned_at = now() where id = $1", [r.target_id]);
    for (const ws of sockets.get(String(r.target_id)) || []) ws.close(4001, "banned");
  }
  await pool.query("update reports set resolved_at = now(), action = $2 where id = $1", [r.id, act]);
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
    "select id, sender_id, body, kind, media, w, h, reply_to, created_at from messages where bond_id = $1 and created_at >= $2 order by id",
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
      replyTo: m.reply_to ? String(m.reply_to) : null,
      at: m.created_at,
    })),
  });
});

app.post("/api/messages", auth, async (req, res) => {
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ error: "빈 메시지는 보낼 수 없어요" });
  const bond = await myBond(req.body?.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  sendMessage(req, res, bond, { body, kind: "text", replyTo: await replyOf(bond.id, req.body?.replyTo) });
});
// 답장 대상은 같은 방에 있는 메시지만. 아니면 답장 없이 보낸다
async function replyOf(bondId, v) {
  const id = Number(v) || 0;
  if (!id) return null;
  return (await pool.query("select 1 from messages where id = $1 and bond_id = $2", [id, bondId])).rowCount ? id : null;
}

// 보낸 글 고치기: 보낸 사람만, 글만. "수정됨" 표시 없이 방 모두의 화면에서 글이 바뀐다
app.post("/api/messages/:id/edit", auth, async (req, res) => {
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ error: "빈 메시지는 보낼 수 없어요" });
  const { rows } = await pool.query(
    "update messages set body = $3 where id = $1 and sender_id = $2 and kind = 'text' returning id, bond_id",
    [Number(req.params.id) || 0, req.user.id, body]);
  if (!rows[0]) return res.status(404).json({ error: "고칠 수 없는 메시지예요" });
  const bond = await myBond(rows[0].bond_id, req.user.id);
  if (bond) notify(memberIds(bond), { type: "edited", bondId: bond.id, id: String(rows[0].id), body }, req.user.id);
  res.json({ ok: true });
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
  sendMessage(req, res, bond, { body: kind === "video" ? "동영상" : "사진", kind, media: id, mime, size, w: dim(req.query.w), h: dim(req.query.h), replyTo: await replyOf(bond.id, req.query.replyTo) });
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
    "insert into messages (bond_id, sender_id, body, kind, media, mime, size, w, h, reply_to) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, created_at",
    [bond.id, req.user.id, body, m.kind || "text", m.media || null, m.mime || null, m.size || null, m.w || null, m.h || null, m.replyTo || null]
  );

  // R-4.2 / R-4.3: 양쪽이 각각 한 번 이상 보냈을 때만 Reset한다. 나와의 방은 셈하지 않는다.
  if (isSelf) {
    const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null, replyTo: m.replyTo ? String(m.replyTo) : null };
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

  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, from: String(req.user.id), kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null, replyTo: m.replyTo ? String(m.replyTo) : null };
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
    "insert into messages (bond_id, sender_id, body, kind, media, mime, size, w, h, reply_to) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, created_at",
    [bond.id, req.user.id, body, m.kind || "text", m.media || null, m.mime || null, m.size || null, m.w || null, m.h || null, m.replyTo || null]);
  const sp = new Set((bond.speakers || []).map(String)); sp.add(String(req.user.id));
  const reset = sp.size >= 2;
  await pool.query(
    reset ? "update bonds set last_reset_at = now(), keep = keep + 1, speakers = '[]'::jsonb, warned = null where id = $1"
          : "update bonds set speakers = $2::jsonb where id = $1",
    reset ? [bond.id] : [bond.id, JSON.stringify([...sp])]);
  await pool.query("update bond_members set read_at = now() where bond_id = $1 and user_id = $2", [bond.id, req.user.id]);
  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, from: String(req.user.id), kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null, replyTo: m.replyTo ? String(m.replyTo) : null };
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

app.get("/api/room/:bondId", auth, async (req, res) => {
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const { rows } = await pool.query("select tool, data from room_state where bond_id = $1", [bond.id]);
  const tools = {};
  rows.forEach((r) => (tools[r.tool] = r.data));
  res.json({ tools });
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

/* ---------- 도구 만들기 (tools-maker-plan.md) ----------
   사용자가 AI 봇과 대화하며 도구를 만든다. 지금은 운영자만(계획 3단계).
   - 도구 하나 = user_tools 한 줄. 고칠 때마다 tool_versions 에 버전이 하나씩 쌓이고, 지워지는 버전은 없다
   - 되돌리기도 "예전 코드로 새 버전 만들기"라서 되돌린 걸 다시 되돌릴 수 있다
   - 방에 붙일 때는 그 순간의 버전 번호를 방 데이터(room_state)에 적어 둔다. 고쳐도 방은 그대로, 다시 붙여야 바뀐다
   - 도구 코드는 앱 안의 격리된 칸(iframe sandbox)에서만 돈다. 서버는 코드를 실행하지 않는다
   - AI 비용: 하루 전체 상한(.env AI_DAILY_USD, 기본 3달러)과 사람마다 하루 횟수(AI_USER_CALLS, 기본 40) */
const Anthropic = require("@anthropic-ai/sdk");
const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
const { z } = require("zod/v4");   // SDK 의 출력 모양 도우미는 zod 4 문법을 쓴다
const ai = process.env.ANTHROPIC_API_KEY ? new (Anthropic.default || Anthropic)() : null;
const AI_MODEL = "claude-opus-5-5";
const AI_PRICE = { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 };   // 달러 / 백만 토큰 (2026-10 공식 가격)
const AI_DAILY_USD = Number(process.env.AI_DAILY_USD || 3), AI_USER_CALLS = Number(process.env.AI_USER_CALLS || 40);
const BOTS = {
  play: "놀이: 장난기 있고 연출을 좋아한다. 강화·퀴즈·끝말잇기·빙고·내기·키우기 같은 놀이를 잘 만든다. 확률·차례·점수·순위·짧은 연출을 즐겨 쓴다.",
  pick: "결정: 빠르고 공정하다. 메뉴 룰렛·사다리·제비뽑기·순서 정하기·팀 나누기를 잘 만든다. 무작위 결과는 한 번 정해서 c.data 에 저장해 모두에게 같게 보이게 한다.",
  money: "돈: 꼼꼼하다. 정산·더치페이·회비·공동 가계부를 잘 만든다. 금액은 정수 원 단위, 천 단위 쉼표, 각자 자기 줄만 체크.",
  meet: "모임: 정리를 잘한다. 공지·투표·일정 잡기·출석·역할 나누기·준비물을 잘 만든다. 만든 사람만 고치는 칸과 모두가 누르는 칸을 나눈다.",
  two: "둘이서: 다정하다. 기념일·안부 확인·교환 일기·버킷리스트 같은 두 사람(친구·가족·연인) 도구를 잘 만든다.",
  memory: "기억: 차분하다. 타임캡슐·하루 한 줄·연속 기록·습관 챌린지를 잘 만든다. 날짜는 한국 시간 기준.",
  free: "자유 제작자: 무엇이든 만든다.",
};
const MAKER_RULES = `너는 메신저 앱 Till Zero 안에서 사용자와 대화하며 "도구"를 만드는 봇이다. 사용자는 코드를 모른다. 한국어로, 짧고 쉽게 말한다.

[도구가 도는 곳]
- 대화방 맨 위의 작은 칸 하나. 안쪽 크기는 가로 약 300px, 세로 64px. 두 줄을 넘지 않게 그린다. 넘치면 잘린다.
- 격리된 iframe 안이다. 바깥 인터넷(fetch, WebSocket, 외부 이미지·폰트·스크립트)은 막혀 있다. alert/confirm/prompt 도 쓰지 않는다.
- 미리 들어 있는 것: 함수 esc(글) — HTML 에 넣을 글은 꼭 esc 로 감싼다. CSS 클래스 rt-row(가로 줄), rt-title(굵은 제목, 넘치면 …), rt-title none(흐린 안내), rt-pt(작은 숫자), rt-btn(검은 알약 버튼), rt-btn ghost(회색 버튼), rt-score(작은 점수 줄), rt-in(입력칸). 색은 CSS 변수 --ink --ink-2 --ink-3 --paper --paper-2 --card --line --zero(빨강) 를 쓰면 밝은·어두운 화면 모두 맞는다. 필요하면 <style> 을 box.innerHTML 안에 넣어도 된다.

[코드 모양] 자바스크립트로 함수 하나를 만든다. 다른 전역 코드는 두지 않는다.
function render(box, c) { ... }
- 그릴 때마다 box.innerHTML 로 새로 그리고, box.querySelector 로 버튼을 찾아 onclick 을 단다.
- c.data: 이 방·이 도구의 저장 데이터(JSON 으로 저장 가능한 값만). 칸 이름은 마음대로. on, log, ver, name 은 앱이 쓰는 칸이라 건드리지 않는다.
- c.me: 내 아이디(문자열). c.members: 방 사람 [{id, name}] (나 포함). c.self: 나와의 대화면 true.
- c.ui: 저장하지 않는 화면 상태(입력 중인지 등). c.redraw(): c.ui 만 바꿨을 때 다시 그린다.
- c.save(글): c.data 를 바꾼 뒤 부른다. 저장되고 방 사람 모두의 화면이 다시 그려진다. 글을 주면 대화 사이에 기록으로 남는다(예: "'설거지' 완료 +2P"). 기록할 일만 글을 준다.
- c.toast(글): 화면 아래 잠깐 뜨는 알림.
- 무작위 결과는 누른 사람 쪽에서 한 번 정해 c.data 에 넣고 c.save 한다. 그래야 모두에게 같은 결과가 보인다.

[지킬 것]
- 화면에 설명 문장을 넣지 않는다. 이름·숫자·짧은 버튼 글자(2~4자)·빈 상태 한 줄만. 사용법 안내 문구 금지.
- Count·D-day·Keep(앱의 30일 규칙)을 바꾸려 하지 않는다. 그런 기능은 없다.
- 오류 없이 돌아야 한다. 데이터가 비어 있을 때(처음)도 그려져야 한다.

[대화하는 법]
- 사용자가 원하는 게 분명하면 바로 만들고, 정할 게 남았으면 그 자리에서 묻는다. 한 번에 하나만 묻는다.
- 꼭 정해야 하는 것만 묻는다: 몇 명이서(둘·여럿·혼자), 누가 조작하는지(모두·각자 자기 것만·만든 사람만·차례대로), 대화에 기록을 남길지. 분명하면 묻지 않는다.
- 물을 때는 options 에 고를 답 2~4개(짧게)를 준다. 묻지 않을 때도 다음에 해 볼 만한 고치기 2~3개를 options 로 줄 수 있다.
- reply 는 두 문장 이내. 코드 이야기는 하지 않는다.
- 도구를 바꿨으면 changed=true, code 에 render 함수 전체, note 에 무엇을 바꿨는지 한 줄(예: "실패하면 한 단계 내려감"). 안 바꿨으면 changed=false, code 와 note 는 빈 글.
- name 은 하는 일이 보이는 짧은 이름(예: "무기 강화", "회식 정산").`;
const MakerOut = z.object({
  reply: z.string(),
  options: z.array(z.string()),
  changed: z.boolean(),
  name: z.string(),
  note: z.string(),
  code: z.string(),
});
const kstDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
async function myTool(id, userId) {
  return (await pool.query("select * from user_tools where id = $1 and owner_id = $2", [Number(id) || 0, userId])).rows[0];
}
async function toolCode(id, ver) {
  return (await pool.query("select code, note from tool_versions where tool_id = $1 and ver = $2", [id, ver])).rows[0];
}
async function addVersion(tool, code, note) {
  const ver = tool.ver + 1;
  await pool.query("insert into tool_versions (tool_id, ver, code, note) values ($1, $2, $3, $4)", [tool.id, ver, code, note]);
  await pool.query("update user_tools set ver = $2, updated_at = now() where id = $1", [tool.id, ver]);
  return ver;
}
const makerOnly = (req, res, next) => (isAdmin(req.user.id) ? next() : res.sendStatus(404));

app.get("/api/tools/mine", auth, makerOnly, async (req, res) => {
  const { rows } = await pool.query("select id, name, bot, ver, updated_at from user_tools where owner_id = $1 order by updated_at desc", [req.user.id]);
  res.json({ tools: rows.map((r) => ({ id: "u" + r.id, name: r.name, bot: r.bot, ver: r.ver, at: r.updated_at })) });
});
// 새로 만들기. from 을 주면(기본 도구 "고쳐 만들기") 그 코드가 1번 버전이 된다
app.post("/api/tools", auth, makerOnly, async (req, res) => {
  const bot = BOTS[req.body?.bot] ? req.body.bot : "free";
  const from = req.body?.from;
  const name = String(from?.name || "새 도구").slice(0, 30);
  const tool = (await pool.query("insert into user_tools (owner_id, name, bot) values ($1, $2, $3) returning *", [req.user.id, name, bot])).rows[0];
  await pool.query("insert into tool_chats (tool_id, messages) values ($1, '[]')", [tool.id]);
  if (from?.code && String(from.code).length < 60000) await addVersion(tool, String(from.code), "원본");
  res.json({ id: "u" + tool.id });
});
app.get("/api/tools/:id", auth, makerOnly, async (req, res) => {
  const tool = await myTool(String(req.params.id).replace(/^u/, ""), req.user.id);
  if (!tool) return res.sendStatus(404);
  const vers = (await pool.query("select ver, note, created_at from tool_versions where tool_id = $1 order by ver desc", [tool.id])).rows;
  const chat = (await pool.query("select messages from tool_chats where tool_id = $1", [tool.id])).rows[0]?.messages || [];
  const cur = tool.ver ? await toolCode(tool.id, tool.ver) : null;
  res.json({ id: "u" + tool.id, name: tool.name, bot: tool.bot, ver: tool.ver, code: cur?.code || "",
    versions: vers.map((v) => ({ ver: v.ver, note: v.note, at: v.created_at })), chat });
});
// 방에서 도구를 그릴 때. 붙인 버전의 코드
app.get("/api/tools/:id/v/:ver", auth, async (req, res) => {
  const id = Number(String(req.params.id).replace(/^u/, "")) || 0;
  const tool = (await pool.query("select name from user_tools where id = $1", [id])).rows[0];
  const v = tool && (await toolCode(id, Number(req.params.ver) || 0));
  if (!v) return res.sendStatus(404);
  res.json({ name: tool.name, code: v.code });
});
// 도구 삭제: 버전·대화가 함께 지워지고, 붙여 둔 방에서도 내려간다(그 방의 도구 데이터도 지운다)
app.delete("/api/tools/:id", auth, makerOnly, async (req, res) => {
  const tool = await myTool(String(req.params.id).replace(/^u/, ""), req.user.id);
  if (!tool) return res.sendStatus(404);
  const rooms = (await pool.query("delete from room_state where tool = $1 returning bond_id", ["u" + tool.id])).rows;
  await pool.query("delete from user_tools where id = $1", [tool.id]);
  for (const r of rooms) {
    const who = (await pool.query(
      "select user_id as id from bond_members where bond_id = $1 union select a_id from bonds where id = $1 union select b_id from bonds where id = $1", [r.bond_id])).rows;
    notify(who.map((x) => x.id), { type: "room", bondId: r.bond_id, tool: "u" + tool.id });
  }
  res.json({ ok: true });
});
// 예전 버전으로: 그 코드로 새 버전을 만든다(기록은 지워지지 않는다)
app.post("/api/tools/:id/revert", auth, makerOnly, async (req, res) => {
  const tool = await myTool(String(req.params.id).replace(/^u/, ""), req.user.id);
  const v = tool && (await toolCode(tool.id, Number(req.body?.ver) || 0));
  if (!v) return res.sendStatus(404);
  const ver = await addVersion(tool, v.code, `${req.body.ver}번으로 되돌림`);
  res.json({ ver, code: v.code });
});
// 봇과 대화: 한 번 말할 때마다 AI 를 한 번 부른다
app.post("/api/tools/:id/chat", auth, makerOnly, async (req, res) => {
  if (!ai) return res.status(503).json({ error: "AI 준비 중이에요" });
  const tool = await myTool(String(req.params.id).replace(/^u/, ""), req.user.id);
  if (!tool) return res.sendStatus(404);
  const text = String(req.body?.text || "").trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: "내용을 적어주세요" });
  const day = kstDay();
  const spent = (await pool.query("select coalesce(sum(usd), 0)::float usd from ai_usage where day = $1", [day])).rows[0].usd;
  const mine = (await pool.query("select calls from ai_usage where day = $1 and user_id = $2", [day, req.user.id])).rows[0]?.calls || 0;
  if (spent >= AI_DAILY_USD || mine >= AI_USER_CALLS) return res.status(429).json({ error: "오늘은 더 만들 수 없어요" });

  const chat = (await pool.query("select messages from tool_chats where tool_id = $1", [tool.id])).rows[0]?.messages || [];
  const cur = tool.ver ? await toolCode(tool.id, tool.ver) : null;
  // 지난 대화는 말만 보낸다. 지금 코드는 이번 요청에 한 번만 붙인다(대화가 길어져도 비용이 덜 는다)
  const history = chat.slice(-20).map((m) => ({ role: m.role, content: m.text + (m.ver ? `\n(→ ${m.ver}번 버전)` : "") }));
  const now = (cur ? `[지금 도구 코드 · ${tool.ver}번 버전 · 이름 "${tool.name}"]\n${cur.code}\n\n` : "[아직 만든 코드 없음]\n\n") + `[사용자]\n${text}`;
  let r;
  try {
    r = await ai.beta.messages.parse({
      model: AI_MODEL, max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(MakerOut) },
      system: [{ type: "text", text: MAKER_RULES + "\n\n[너의 성격과 전문]\n" + BOTS[tool.bot], cache_control: { type: "ephemeral" } }],
      messages: [...history, { role: "user", content: now }],
    });
  } catch (e) {
    console.error("maker", e.status || "", e.message);
    return res.status(502).json({ error: "봇이 답하지 못했어요. 다시 해주세요" });
  }
  const u = r.usage || {};
  const usd = ((u.input_tokens || 0) * AI_PRICE.in + (u.output_tokens || 0) * AI_PRICE.out +
    (u.cache_read_input_tokens || 0) * AI_PRICE.cacheRead + (u.cache_creation_input_tokens || 0) * AI_PRICE.cacheWrite) / 1e6;
  await pool.query(
    `insert into ai_usage (day, user_id, calls, usd) values ($1, $2, 1, $3)
       on conflict (day, user_id) do update set calls = ai_usage.calls + 1, usd = ai_usage.usd + $3`, [day, req.user.id, usd]);
  const out = r.stop_reason === "refusal" ? null : r.parsed_output;
  if (!out) return res.status(502).json({ error: "봇이 답하지 못했어요. 다시 해주세요" });
  let ver = null;
  if (out.changed && out.code && out.code.length < 60000 && /function\s+render\s*\(/.test(out.code)) {
    ver = await addVersion(tool, out.code, out.note.slice(0, 80) || "고침");
  }
  if (out.name && out.name !== tool.name) await pool.query("update user_tools set name = $2 where id = $1", [tool.id, out.name.slice(0, 30)]);
  const options = out.options.slice(0, 4).map((o) => o.slice(0, 20));
  const next = chat.concat({ role: "user", text }, { role: "assistant", text: out.reply, options, ver }).slice(-60);
  await pool.query("update tool_chats set messages = $2 where tool_id = $1", [tool.id, JSON.stringify(next)]);
  res.json({ reply: out.reply, options, ver, name: out.name || tool.name, code: ver ? out.code : null, note: ver ? out.note : null,
    usd: Math.round(usd * 1e4) / 1e4 });
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
    "select s.user_id, u.phone_tail, u.banned_at from sessions s join users u on u.id = s.user_id where s.token = $1", [t]);
  if (!rows[0] || rows[0].banned_at) return ws.close(4001, "unauthorized");
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
