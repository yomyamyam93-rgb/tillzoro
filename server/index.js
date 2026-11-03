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
const DAY = 86400000;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json({ limit: "1mb" }));

// 앱은 다른 주소(GitHub Pages)에서 열리므로 브라우저에 교차 요청을 허락한다.
// 인증은 쿠키가 아니라 Bearer 토큰이므로 출처를 좁힐 필요가 없다.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "authorization, content-type");
  res.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- 도우미 ---------- */

const token = () => crypto.randomBytes(24).toString("base64url");

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
  return {
    id: row.id, group: true, self: false,
    name: row.name || others.map((m) => m.nickname).slice(0, 4).join(", ") || "새 방", named: !!row.name,
    photo: others.length === 1 ? others[0].photo : null,
    members: ms.map((m) => ({ id: m.id, name: m.nickname, photo: m.photo, joined: m.joined_at })),
    history: !!row.show_history, created: row.bond_at,
    days: daysOf(row.bond_at),
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
    other: self ? null : String(iAmA ? row.b_id : row.a_id),   // 도구가 두 사람을 알 수 있게
    photo: iAmA ? row.b_photo : row.a_photo,
    days: daysOf(row.bond_at),
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
  // 안 읽은 수: 남이 보낸 것 중 내가 마지막으로 읽은 뒤의 것
  const un = new Map((await pool.query(
    `select b.id, count(m.id)::int n from bonds b join messages m on m.bond_id = b.id and m.sender_id <> $1 and m.kind <> 'bot'
       and m.created_at > coalesce(case when b.kind = 'group' then (select read_at from bond_members x where x.bond_id = b.id and x.user_id = $1)
                                        when b.a_id = $1 then b.a_read_at else b.b_read_at end, 'epoch')
      where ${IN_ROOM} group by b.id`, [req.user.id])).rows.map((r) => [String(r.id), r.n]));
  bonds.forEach((b) => { b.unreadN = un.get(String(b.id)) || 0 });
  const today = (await pool.query("select count(*)::int n from items where user_id = $1 and created_at >= ($2::date)::timestamp at time zone 'Asia/Seoul'", [req.user.id, kstDay()])).rows[0].n;
  // 마지막 대화가 최근인 순, 그다음 이름순
  bonds.sort((x, y) => new Date(y.lastAt || 0) - new Date(x.lastAt || 0) || x.name.localeCompare(y.name));
  // sms: 문자가 실제로 나가는지. 준비되기 전에는 옛 계정에 번호 연결을 요구하지 않는다
  res.json({ me: { ...meOf(req.user), photo: req.user.photo }, bonds, today, sms: !!sms, admin: isAdmin(req.user.id) });
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
    "select id, sender_id, body, kind, media, mime, w, h, reply_to, created_at from messages where bond_id = $1 and created_at >= $2 order by id",
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
      bot: m.kind === "bot" ? botMeta(m.mime) : undefined,
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
  const { rows } = await pool.query(
    "insert into messages (bond_id, sender_id, body, kind, media, mime, size, w, h, reply_to) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, created_at",
    [bond.id, req.user.id, body, m.kind || "text", m.media || null, m.mime || null, m.size || null, m.w || null, m.h || null, m.replyTo || null]
  );

  collect(bond, rows[0], m, req.user.id);
  if (isSelf) {
    const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null, replyTo: m.replyTo ? String(m.replyTo) : null };
    notify([req.user.id], { type: "message", ...msg }, req.user.id);
    return res.json(msg);
  }
  const iAmA = bond.a_id === req.user.id;
  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, from: String(req.user.id), kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null, replyTo: m.replyTo ? String(m.replyTo) : null };
  notify([bond.a_id, bond.b_id], { type: "message", ...msg }, req.user.id);
  push(iAmA ? bond.b_id : bond.a_id, "msg", { title: req.user.nickname, body: body.slice(0, 120), tag: "bond-" + bond.id });
  res.json(msg);
}

// 방 메시지
async function groupMessage(req, res, bond, m) {
  const body = m.body;
  const { rows } = await pool.query(
    "insert into messages (bond_id, sender_id, body, kind, media, mime, size, w, h, reply_to) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, created_at",
    [bond.id, req.user.id, body, m.kind || "text", m.media || null, m.mime || null, m.size || null, m.w || null, m.h || null, m.replyTo || null]);
  collect(bond, rows[0], m, req.user.id);
  await pool.query("update bond_members set read_at = now() where bond_id = $1 and user_id = $2", [bond.id, req.user.id]);
  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id, from: String(req.user.id), kind: m.kind || "text", media: m.media || null, w: m.w || null, h: m.h || null, replyTo: m.replyTo ? String(m.replyTo) : null };
  const ids = memberIds(bond);
  notify(ids, { type: "message", ...msg }, req.user.id);
  for (const id of ids) if (id !== String(req.user.id))
    push(id, "msg", { title: roomName(bond, id), body: `${req.user.nickname}: ${body}`.slice(0, 120), tag: "bond-" + bond.id });
  res.json(msg);
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
  // 만든 도구는 늘 최신 판으로 보여 준다. 붙일 때의 번호를 그대로 쓰면 고쳐도 방은 옛 모습이다
  const ids = Object.keys(tools).filter((k) => /^u\d+$/.test(k)).map((k) => Number(k.slice(1)));
  if (ids.length) {
    const cur = await pool.query("select id, ver, name from user_tools where id = any($1::int[])", [ids]);
    cur.rows.forEach((t) => { const k = "u" + t.id; if (tools[k] && t.ver) { tools[k].ver = t.ver; tools[k].name = t.name } });
  }
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
const BOTS = require("./bot-playbooks");   // 봇별 교본(성격·원리·자주 오는 부탁·흔한 실수·펼침)
const MAKER_RULES = `너는 메신저 앱 Till Zero 안에서 사용자와 대화하며 "도구"를 만드는 봇이다. 사용자는 코드를 모른다. 한국어로, 짧고 쉽게 말한다.

[도구가 도는 곳]
- 대화방 맨 위의 작은 칸 하나. 안쪽 크기는 가로 약 300px(폰마다 280~360), 세로 64px. 여백은 앱이 칸 바깥에 이미 둘렀다.
  두 줄을 넘지 않게 그린다. 칸 밖으로 나간 것은 잘린다 — 글자·숫자·빛·흔들림 같은 연출까지 모두 칸 안에서 끝나야 한다.
- 만든 뒤 앱이 실제 칸에 그려 보고 버튼도 눌러 본다. 넘치거나 오류가 나면 그 내용을 받아 다시 고치게 된다.
- 격리된 iframe 안이다. 바깥 인터넷(fetch, WebSocket, 외부 이미지·폰트·스크립트)은 막혀 있다. alert/confirm/prompt 도 쓰지 않는다.
- 미리 들어 있는 것: 함수 esc(글) — HTML 에 넣을 글은 꼭 esc 로 감싼다. CSS 클래스 rt-row(가로 줄), rt-title(제목, 넘치면 …), rt-title none(흐린 안내), rt-big(큰 값), rt-sub(작은 흐린 정보), rt-pt(작은 숫자), rt-chip(작은 알약, .on 이면 검정), rt-sp(남는 폭 채우기), rt-btn(검은 알약 버튼), rt-btn ghost(회색 버튼), rt-score(작은 점수 줄), rt-in(입력칸). 색은 CSS 변수 --ink --ink-2 --ink-3 --paper --paper-2 --card --line --zero(빨강) 를 쓰면 밝은·어두운 화면 모두 맞는다. 필요하면 <style> 을 box.innerHTML 안에 넣어도 된다.

[코드 모양] 자바스크립트로 함수 하나를 만든다. 다른 전역 코드는 두지 않는다.
function render(box, c) { ... }
- 그릴 때마다 box.innerHTML 로 새로 그리고, box.querySelector 로 버튼을 찾아 onclick 을 단다.
- c.data: 이 방·이 도구의 저장 데이터(JSON 으로 저장 가능한 값만). 칸 이름은 마음대로. on, log, ver, name 은 앱이 쓰는 칸이라 건드리지 않는다.
- c.me: 내 아이디(문자열). c.members: 방 사람 [{id, name}] (나 포함). c.self: 나와의 대화면 true.
- c.ui: 저장하지 않는 화면 상태(입력 중인지 등). c.redraw(): c.ui 만 바꿨을 때 다시 그린다.
- c.save(글): c.data 를 바꾼 뒤 부른다. 저장되고 방 사람 모두의 화면이 다시 그려진다. 글을 주면 대화 사이에 기록으로 남는다(예: "'설거지' 완료 +2P"). 기록할 일만 글을 준다.
- c.toast(글): 화면 아래 잠깐 뜨는 알림.
- 무작위 결과는 누른 사람 쪽에서 한 번 정해 c.data 에 넣고 c.save 한다. 그래야 모두에게 같은 결과가 보인다.

[디자인] 무엇을 만들든 모양은 요청에 맞게 새로 짠다. 다만 아래 기준은 늘 지킨다 — 이 앱의 다른 화면과 한 몸처럼 보여야 한다.
- 글꼴은 칸이 하나로 정한다(font-family 를 쓰지 않는다). 글자 크기는 정해진 것만 쓴다 — 붙이기 전 검사에서 다른 크기는 걸린다:
  작은 정보 12px(rt-sub) · 보통 글 14px(rt-title) · 큰 값 22px(rt-big) · 입력칸 16px. 펼친 모습(keep)에서만 보통 15px, 큰 값 30px(rt-hero).
  굵기는 보통 400·강조 600·큰 값 800. 다른 크기·굵기를 새로 만들지 않는다.
- 버튼은 rt-btn(검정)·rt-btn ghost(회색)만. 한 줄에 검은 버튼은 하나(가장 중요한 행동). 버튼 글자는 2~4자.
- 간격은 4·8·12px 만. 줄 안의 것들은 rt-row 로 세로 가운데 맞춤. 남는 폭은 rt-sp 로 밀어서 버튼은 오른쪽 끝에 둔다.
- 시선이 갈 곳은 하나: 가장 중요한 값 하나만 크게, 나머지는 작고 흐리게(--ink-3). 비슷한 크기의 것을 여러 개 늘어놓지 않는다.
- 사람 이름·선택지는 rt-chip(작은 알약)으로 가로 나열. 많으면 앞의 몇 개와 "+3" 처럼 줄인다.
- 숫자: 금액은 늘 천 단위 쉼표(90,000). 칸이 좁으면 "9만", "1.2만" 처럼 줄인다. 숫자는 var(--font-num).
- 긴 글은 한 줄에서 … 로 줄인다(white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0). 줄이 넘어가 칸을 밀어내면 안 된다.
- 입력칸(rt-in)은 남는 폭만 차지하고 옆에 버튼 하나. 입력 중이 아닐 때는 입력칸을 늘 띄워 두지 않는다(버튼을 누르면 나온다).
- 연출(뽑기·강화 결과 등)은 짧고 또렷하게: 0.6~1.2초, 칸 안에서. 결과가 나오는 순간에 한 번. 늘 움직이는 장식은 두지 않는다.
- 인원은 c.members 수에 맞춘다(둘이면 둘, 여럿이면 여럿). 사람 수를 따로 묻거나 고정하지 않는다.
- 안 되는 부탁(실제 지도·인터넷 사진·외부 정보 등)은 reply 에서 한 문장으로 짧게 말하고, 칸 안에서 되는 가장 가까운 방법으로 만든다.
- 말은 보는 사람 쪽에서 자연스럽게. 이름 자리에 c.me 가 오면 "나"가 되니 문장을 미리 바꿔 둔다:
  "나에게"·"나 결제"·"나님" 같은 어색한 조합을 만들지 않는다(내가 받을 쪽이면 "받을 돈", 남이면 "OO에게").
  같은 정보를 두 번 쓰지 않는다(위 큰 값에 쓴 금액을 아래 작은 글에 또 쓰지 않는다).
- 펼친 모습(keep)의 공간: 칸은 가로 꽉, 세로는 도구 세 개 높이다. 위쪽에 몰아 두고 아래를 비우지 않는다.
  세로로 고루 나눠 쓴다: keep 이 그리는 맨 바깥 요소에 flex:1; display:flex; flex-direction:column; justify-content:space-between (height:100% 는 안 먹는다).
  펼친 모습에서는 글자를 한 단계 키운다(큰 값 30px rt-hero, 보통 15px). 막대·칩·목록은 가로 폭을 다 쓴다.
  구역은 2~3개(지금 / 사람별 / 지금까지)로 나누고 구역 사이는 12px 이상 띄우거나 가는 줄(1px var(--line)) 하나.
  자세히 볼 것이 적으면 억지로 채우지 말고 핵심 값을 크게, 가운데에 둔다 — 작은 글 두세 줄만 위에 붙어 있는 모습은 안 된다.

[지킬 것]
- 화면에 설명 문장을 넣지 않는다. 이름·숫자·짧은 버튼 글자(2~4자)·빈 상태 한 줄만. 사용법 안내 문구 금지.
- Count·D-day·Keep(앱의 30일 규칙)을 바꾸려 하지 않는다. 그런 기능은 없다.
- 오류 없이 돌아야 한다. 데이터가 비어 있을 때(처음)도 그려져야 한다.

[만드는 법] 사용자는 대화방에서 "@봇 할 일" 한 줄로 부른다. 되묻지 않는다 — 다시 물을 기회가 없다.
- 그 한 줄 뒤에 있는 진짜 목적을 생각한다. 그 목적에 꼭 필요한 것은 말하지 않았어도 넣고, 없어도 되는 기능은 넣지 않는다.
  (예: "회식비 정산" → 1인 금액과 각자 낸 표시는 필요, 영수증 사진·항목별 메모는 필요 없다)
- 빠진 것은 가장 흔하고 자연스러운 쪽으로 정한다: 인원은 c.members, 누가 누르나는 정산·체크는 각자 자기 것만 / 게임·뽑기는 누구나,
  대화에 기록(c.save 의 글)은 결과가 났을 때만.
- 지금 도구 코드가 함께 오면 그걸 고치는 부탁이다. 말한 것만 바꾸고 나머지(데이터 칸 이름 포함)는 그대로 둔다 — 방에 쌓인 데이터가 이어져야 한다.
- reply 는 한 문장: 무엇을 만들었고/바꿨고 어떻게 쓰는지 핵심만. 코드 이야기는 하지 않는다. options 는 빈 목록.
- 도구를 바꿨으면 changed=true, code 에 render 함수 전체(keep 이 있으면 함께), note 에 무엇을 바꿨는지 한 줄(예: "실패하면 한 단계 내려감"). 못 만드는 부탁이면 changed=false, code·note 는 빈 글, reply 에 짧게 이유.
- 펼침: keep(box, c) 함수를 두면 도구 아래에 꺾인 화살표가 생기고, 누르거나 도구를 아래로 쓸면 상자가 세 배 높이로 커지며
  render 대신 keep 이 그 상자 전체를 그린다(없으면 화살표도 없다). render 는 그동안 안 보인다 — 그러니 keep 은 "아래에 덧붙는 칸"이 아니라
  이 도구를 펼친 모습 하나다: 지금 상태를 크게 보여 주고 그 아래 자세한 것을 더한다. render 와 같은 줄을 위아래로 두 번 쓰지 않는다.
  keep 안의 버튼도 c.save 로 저장된다(필요하면 펼친 채로 조작). 내용이 길면 안에서 스크롤된다. 용도는 도구에 맞게 —
  공지·메모는 전체 글, 게임·뽑기는 지금 판 + 전적(사람별 횟수), 정산은 지금 정산 + 누가 얼마 냈나, 습관은 오늘 + 연속 일수·달력처럼.
  통계는 목록으로 쌓지 말고 수로 세어 둔다: d.games/d.wins 는 되고 d.history=[...] 는 안 된다(최근 몇 개만은 괜찮다).
  펼칠 만한 게 있으면 묻지 말고 알아서 만든다(교본의 [펼침] 참고). 없으면 만들지 않는다.
- 받아 가는 도구(나챗방에서만): 사용자가 무언가를 "모아", "정리", "기록"하길 원하면(가계부, 사진 모음, 강아지 사진만, 일정, 할 일, 링크, 읽을 책…)
  rule.on=true 로 조건을 붙인다. 그러면 나챗방에 던진 것(글·사진·영상·파일·링크) 중 맞는 것이 이 도구로 들어온다. 다른 방에서 오는 사진·영상·파일·링크도 들어온다.
  - rule.kinds: 받을 종류(text, link, photo, video, file). 가계부·일정·할 일은 text, 사진 모음은 photo.
  - rule.ai: 종류만으로 되면 false("사진 전부", "링크 전부"). 내용을 봐야 고를 수 있으면 true("강아지 사진만", "돈 쓴 글만", "약속이 있는 글만").
  - rule.ask: ai=true 일 때 고르는 조건. 받아 적는 쪽은 이 글만 보고 고르니 꼼꼼히 쓴다 — 넣을 것과 넣지 않을 것을 함께:
    예) 가계부 "실제로 돈을 쓰거나 받은 기록. 금액이 적혀 있어야 한다. 살 것·할 일·가격 문의·계획은 넣지 않는다"
        일정 "날짜나 요일·시각이 정해진 약속·예약·일정. 막연한 '나중에'·지난 일 이야기는 넣지 않는다"
        강아지 사진 "강아지가 주인공으로 보이는 사진. 강아지 그림·장난감·고양이는 넣지 않는다"
  - rule.fields: 항목에서 뽑아 둘 값 이름(예: amount, date, time, place, item). **첫째 값은 그 도구의 핵심 값**이다 —
    받아 적는 쪽은 첫째 값을 뽑을 수 없으면 그 항목을 넣지 않는다(가계부는 amount 먼저, 일정은 date 먼저). 핵심 값이 따로 없으면 빈 목록.
  - 이름(name)은 사용자가 부른 말 그대로 짧게(가계부라 하면 "가계부"). 꾸민 이름을 짓지 않는다.
  - 코드에서는 c.items 로 받는다: [{id, kind, text, src(사진·영상 작은 것), full(원본), at(밀리초), room(방 이름), data:{뽑은 값}}], 새것이 앞.
    data 의 숫자도 글이니 Number() 로 바꿔 쓴다. 사진은 <img src="\${it.src}"> 로 그린다(object-fit:cover). c.items 는 읽기만 한다.
  - 직접 적는 것(예: 가계부에 손으로 추가)이 필요하면 c.data 에 따로 쌓고 c.items 와 합쳐 보여 준다. 다 한 것 표시(할 일 체크 등)도 c.data 에 item id 로 둔다.
  - 보통 도구(누르는 것: 게임·정산·투표 등)이거나 나챗방이 아니면 rule.on=false, kinds·fields 빈 목록, ai=false, ask 빈 글.
- 칸은 바깥 인터넷과 끊겨 있다. 대신 앱에 부탁할 수 있다(모두 Promise):
    await c.ask("location")        -> {lat, lon, acc}   위치 한 번. 거절되면 예외
    await c.ask("share", {text})   -> 공유 시트
    await c.ask("copy", {text})    -> 복사
    await c.ask("buzz")            -> 짧은 진동
  거절·실패는 예외로 오니 try/catch 로 받고, 안 되면 그 자리에 짧은 상태만 적는다(예: "위치 꺼짐"). 문장으로 설명하지 않는다.
  위치는 누를 때만 묻는다(그릴 때마다 부르지 않는다). 좌표는 c.save 로 남겨 두고 쓴다.
- fresh: 지금 도구를 고치는 게 아니라 전혀 다른 새 도구를 원하면 true. 그때 code 는 처음부터 새로 만든다.
- name 은 열 글자 안쪽의 재미있는 이름. 기능 설명이 아니라 별명처럼 짓는다.
  하는 일이 짐작되면서 한 번 웃기거나 정감 있게(예: "오늘의 빚쟁이", "누가 더 멀리", "칼퇴 적금").
  밋밋한 기능명("회식 정산", "거리 계산")은 쓰지 않는다.`;
// 받아 가는 도구의 조건. on=false 면 보통 도구
const KINDS = ["text", "link", "photo", "video", "file"];
const RuleOut = z.object({ on: z.boolean(), kinds: z.array(z.enum(KINDS)), ai: z.boolean(), ask: z.string(), fields: z.array(z.string()) });
const MakerOut = z.object({
  rule: RuleOut,
  reply: z.string(),
  options: z.array(z.string()),
  changed: z.boolean(),
  name: z.string(),
  note: z.string(),
  code: z.string(),
  fresh: z.boolean(),
});
const botMeta = (s) => { try { return JSON.parse(s) } catch (e) { return {} } };
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

app.get("/api/tools/mine", auth, async (req, res) => {
  const { rows } = await pool.query("select id, name, bot, ver, public, updated_at from user_tools where owner_id = $1 order by updated_at desc", [req.user.id]);
  res.json({ tools: rows.map((r) => ({ id: "u" + r.id, name: r.name, bot: r.bot, ver: r.ver, public: r.public, at: r.updated_at })) });
});
// 탐색에 보이는 남의 도구. 공개한 것만, 코드가 있는 것만. :id 보다 먼저 와야 "public" 이 id 로 잡히지 않는다
app.get("/api/tools/public", auth, async (req, res) => {
  const { rows } = await pool.query(
    `select t.id, t.name, t.bot, t.ver, t.owner_id, u.nickname from user_tools t join users u on u.id = t.owner_id
      where t.public and t.ver > 0 order by t.updated_at desc limit 60`);
  res.json({ tools: rows.map((r) => ({ id: "u" + r.id, name: r.name, bot: r.bot, ver: r.ver, by: r.nickname, mine: r.owner_id === req.user.id })) });
});
// 내 방들에 붙어 있는 남의 도구. 공개 안 한 것은 그 방에서만 쓴다(탐색에서 다른 방으로 가져갈 수 없다)
app.get("/api/tools/rooms", auth, async (req, res) => {
  const { rows } = await pool.query(
    `select distinct t.id, t.name, t.bot, t.ver, t.public, u.nickname, t.updated_at from room_state rs
       join bonds b on b.id = rs.bond_id
       join user_tools t on rs.tool = 'u' || t.id
       join users u on u.id = t.owner_id
      where ${IN_ROOM} and t.owner_id <> $1 and t.ver > 0 order by t.updated_at desc limit 60`, [req.user.id]);
  res.json({ tools: rows.map((r) => ({ id: "u" + r.id, name: r.name, bot: r.bot, ver: r.ver, public: r.public, by: r.nickname })) });
});
// 이름 바꾸기·공개 여부. 내 도구만
app.patch("/api/tools/:id", auth, async (req, res) => {
  const tool = await myTool(String(req.params.id).replace(/^u/, ""), req.user.id);
  if (!tool) return res.sendStatus(404);
  const sets = [], vals = [];
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: "이름은 비울 수 없어요" });
    vals.push(name); sets.push("name = $" + (vals.length + 1));
  }
  if (req.body?.public !== undefined) { vals.push(!!req.body.public); sets.push("public = $" + (vals.length + 1)); }
  if (sets.length) await pool.query(`update user_tools set ${sets.join(", ")}, updated_at = now() where id = $1`, [tool.id, ...vals]);
  res.json({ ok: true });
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
  res.json({ id: "u" + tool.id, name: tool.name, bot: tool.bot, ver: tool.ver, public: tool.public, code: cur?.code || "",
    versions: vers.map((v) => ({ ver: v.ver, note: v.note, at: v.created_at })), chat });
});
// 방에서 도구를 그릴 때. 붙인 버전의 코드
app.get("/api/tools/:id/v/:ver", auth, async (req, res) => {
  const id = Number(String(req.params.id).replace(/^u/, "")) || 0;
  const tool = (await pool.query("select name, owner_id, public from user_tools where id = $1", [id])).rows[0];
  if (!tool) return res.sendStatus(404);
  // 내 것이거나, 공개했거나, 내가 들어가 있는 방에 붙어 있을 때만 코드를 준다.
  // 아니면 번호를 훑어 남이 만드는 중인 도구를 통째로 읽을 수 있다
  let ok = tool.owner_id === req.user.id || tool.public;
  if (!ok) ok = (await pool.query(
    `select 1 from room_state rs join bonds b on b.id = rs.bond_id where rs.tool = $2 and ${IN_ROOM} limit 1`,
    [req.user.id, "u" + id])).rowCount > 0;
  if (!ok) return res.sendStatus(404);
  const v = await toolCode(id, Number(req.params.ver) || 0);
  if (!v) return res.sendStatus(404);
  res.json({ name: tool.name, code: v.code });
});
// 도구 삭제: 버전·대화가 함께 지워지고, 붙여 둔 방에서도 내려간다(그 방의 도구 데이터도 지운다)
app.delete("/api/tools/:id", auth, async (req, res) => {
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
app.post("/api/tools/:id/revert", auth, async (req, res) => {
  const tool = await myTool(String(req.params.id).replace(/^u/, ""), req.user.id);
  const v = tool && (await toolCode(tool.id, Number(req.body?.ver) || 0));
  if (!v) return res.sendStatus(404);
  const ver = await addVersion(tool, v.code, `${req.body.ver}번으로 되돌림`);
  await roomsRedraw(tool.id);
  res.json({ ver, code: v.code });
});
async function roomsRedraw(toolId) {
  const rooms = (await pool.query("select bond_id from room_state where tool = $1", ["u" + toolId])).rows;
  for (const r of rooms) {
    const who = (await pool.query(
      "select user_id as id from bond_members where bond_id = $1 union select a_id from bonds where id = $1 union select b_id from bonds where id = $1", [r.bond_id])).rows;
    notify(who.map((x) => x.id), { type: "room", bondId: r.bond_id, tool: "u" + toolId });
  }
}
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

/* ---------- 대화방에서 @봇 부르기 ----------
   "@놀이 강화게임 만들어줘" → 새 도구를 만들어 이 방 위 칸에 붙인다.
   위 칸에 내 도구가 있으면(또는 봇 말풍선에 답장하면) 그 도구를 고친다. 고치기는 그 도구를 만든 사람만.
   봇이 만든 코드는 바로 붙이지 않는다. 부른 사람의 앱이 보이지 않는 칸에 그려 보고 버튼도 눌러 보며 검사한다
   (칸 밖으로 넘침·오류). 걸리면 무엇이 틀렸는지 봇에게 돌려보내 고치게 하고(최대 BOT_FIXES 번), 통과하면 붙인다.
   봇의 답은 kind "bot" 메시지로 남는다. 사람의 말이 아니라서 30일 Reset 에 세지 않는다.
   봇은 방 대화를 읽지 않는다. 부른 그 한 줄과 지금 도구 코드만 본다.
   모델: 새로 만들기·큰 고치기는 BOT_MODEL(기본 Sonnet). 이미 있는 도구를 고칠 때는 먼저 PATCH_MODEL(Haiku)이 "작은 고치기"인지 보고,
   작으면 코드 전체를 다시 쓰지 않고 바꿀 곳만 찾아 바꾼다(멀쩡한 곳을 건드리지 않아 정확하고 싸다). 크거나 바꿀 곳이 안 맞으면 BOT_MODEL 로 넘긴다.
   많이 부르기 막기: 사람마다 하루 BOT_USER_CALLS(기본 50, 운영자 제외), 방마다 하루 BOT_ROOM_CALLS(기본 100),
   방 하나에 한 번에 하나만, 같은 사람은 15초 간격, 그리고 하루 전체 예산 AI_DAILY_USD. 검사 뒤 고치기는 횟수에 세지 않는다 */
const BOT_USER_CALLS = Number(process.env.BOT_USER_CALLS || 50), BOT_ROOM_CALLS = Number(process.env.BOT_ROOM_CALLS || 100);
const BOT_MODEL = process.env.BOT_MODEL || "claude-sonnet-5-5", PATCH_MODEL = "claude-haiku-5-5", BOT_FIXES = 2;
const PRICES = { "claude-opus-5-5": AI_PRICE, "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } };
const usdOf = (model, u) => { const p = PRICES[model] || AI_PRICE;
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6 };
const spend = (userId, usd, count) => pool.query(
  `insert into ai_usage (day, user_id, calls, usd) values ($1, $2, $4, $3)
     on conflict (day, user_id) do update set calls = ai_usage.calls + $4, usd = ai_usage.usd + $3`, [kstDay(), userId, usd, count ? 1 : 0]);
// 작은 고치기: 바꿀 곳(find → replace)만 낸다. find 는 지금 코드에 딱 한 번 나오는 그대로의 글
const PatchOut = z.object({
  small: z.boolean(),
  reply: z.string(),
  note: z.string(),
  edits: z.array(z.object({ find: z.string(), replace: z.string() })),
});
const PATCH_RULES = `[작은 고치기] 너는 이미 만든 도구를 조금 고친다. 도구 전체를 다시 쓰지 않는다 — 바꿀 곳만 정확히 고른다.
먼저 부탁이 작은 고치기인지 판단한다.
- 작은 고치기(small=true): 글자·이름·버튼 글자, 숫자·확률·시간·금액 같은 값, 색·크기·간격, 순서, 보이던 것 숨기기/보이기,
  이미 있는 동작을 한두 군데 바꾸기(예: "실패하면 0으로", "3명까지만", "확률 더 낮게", "버튼 이름 바꿔줘").
- 큰 고치기(small=false, edits 는 빈 목록): 새 기능·새 버튼·새 화면 추가, 새 데이터 칸이 필요함, 연출을 새로 만듦, 구조를 바꿈,
  어디를 바꿔야 할지 코드에서 확실하지 않음, 전혀 다른 도구를 원함. 조금이라도 애매하면 큰 고치기다.
edits 를 쓰는 법(small=true 일 때):
- find: 지금 코드에서 바꿀 부분을 글자 하나, 띄어쓰기 하나까지 그대로 옮긴다. 코드 전체에서 딱 한 번만 나오도록 앞뒤를 조금 붙인다.
- replace: 그 자리에 들어갈 새 글. 바꿀 것만 바꾸고 나머지는 find 와 똑같이 둔다.
- 같은 값이 여러 곳에 쓰이면(예: 확률 숫자가 그림과 계산 두 곳) 빠짐없이 모두 바꾼다.
- 데이터 칸 이름(c.data.무엇)은 바꾸지 않는다 — 방에 쌓인 데이터가 이어져야 한다.
- 디자인 규칙(글자 세 단계, 금액 쉼표, 칸 밖으로 넘치지 않기, 설명 문장 금지)을 지킨다.
reply 는 무엇을 바꿨는지 한 문장, note 는 바뀐 것 한 줄(예: "성공 확률 5%씩 낮춤").`;
// 작은 고치기 시도. 작은 고치기가 아니거나, 바꿀 곳이 코드와 맞지 않으면 null(큰 모델로 넘긴다)
async function botPatch(userId, bot, code, text) {
  let r;
  try {
    r = await ai.beta.messages.parse({
      model: PATCH_MODEL, max_tokens: 8000,
      output_config: { effort: "medium", format: betaZodOutputFormat(PatchOut) },
      system: [{ type: "text", text: MAKER_RULES + "\n\n" + PATCH_RULES, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `[지금 도구 코드]\n${code}\n\n[사용자]\n${text}` }],
    });
  } catch (e) { console.error("patch", e.status || "", e.message); return null }
  await spend(userId, usdOf(PATCH_MODEL, r.usage || {}), true);
  const o = r.stop_reason === "refusal" ? null : r.parsed_output;
  if (!o || !o.small || !o.edits.length) return { counted: true };
  let next = code;
  for (const e of o.edits) {
    if (!e.find || next.split(e.find).length !== 2) return { counted: true };   // 없거나 여러 번 나오면 믿을 수 없다
    next = next.replace(e.find, () => e.replace);
  }
  if (next === code || !/function\s+render\s*\(/.test(next)) return { counted: true };
  console.log("patch ok", o.edits.length);
  return { counted: true, out: { reply: o.reply, note: o.note, code: next, changed: true, fresh: false, name: "" }, good: true };
}
const botBusy = new Map(), botLast = new Map(), botPending = new Map();   // 방 → 시각, 사람 → 시각, 표 → 만드는 중인 것
// "@할 일" 처럼 봇 이름 없이 부르면 말에서 맞는 봇(교본)을 고른다. AI 를 부르지 않는 단어 맞추기라 공짜다
const BOT_GUESS = [
  ["money", /(정산|n분|더치|회비|송금|갚|빌려|가계부|용돈|[0-9]+ ?(원|만원|천원))/i],
  ["pick", /(뽑기|뽑아|추첨|사다리|순서|당번|제비|룰렛|골라|정해 ?줘|메뉴 ?추천|랜덤)/],
  ["play", /(게임|내기|강화|퀴즈|맞히|빙고|점수|대결|가위바위보|주사위|타이머)/],
  ["meet", /(공지|투표|일정|약속|모임|참석|날짜|회의|예약)/],
  ["two", /(커플|연인|애인|둘이|우리 ?사이|기념일|디데이|d-?day|데이트)/i],
  ["memory", /(기록|습관|일기|체크|출석|연속|매일|목표|다이어트|운동|공부)/],
];
const guessBot = (text) => (BOT_GUESS.find(([, re]) => re.test(text)) || ["free"])[0];
async function botLeft(userId, bondId) {
  const day = kstDay();
  const mine = isAdmin(userId) ? 0 : (await pool.query("select calls from ai_usage where day = $1 and user_id = $2", [day, userId])).rows[0]?.calls || 0;
  const room = (await pool.query(
    "select count(*)::int n from messages where bond_id = $1 and kind = 'bot' and created_at >= ($2::date)::timestamp at time zone 'Asia/Seoul'", [bondId, day])).rows[0].n;
  return Math.max(0, Math.min(BOT_USER_CALLS - mine, BOT_ROOM_CALLS - room));
}
// 봇 한 번 부르기. count=false 면 하루 횟수에 세지 않는다(검사 뒤 고치기)
async function botAsk(userId, bot, content, count) {
  const r = await ai.beta.messages.parse({
    model: BOT_MODEL, max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(MakerOut) },
    system: [
      { type: "text", text: MAKER_RULES, cache_control: { type: "ephemeral" } },
      { type: "text", text: "[너의 교본]\n" + BOTS[bot], cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content }],
  });
  await spend(userId, usdOf(BOT_MODEL, r.usage || {}), count);
  const out = r.stop_reason === "refusal" ? null : r.parsed_output;
  const good = out && out.changed && out.code && out.code.length < 60000 && /function\s+render\s*\(/.test(out.code);
  return { out, good };
}
/* ---------- 받아 적기 ----------
   던진 것은 항목(items)으로 쌓인다: 나챗방의 모든 것, 다른 방의 사진·영상·파일·링크, "이 방도 정리"를 켠 방의 글.
   조건(rule)이 붙은 도구가 맞는 항목을 받아 간다(item_hits). 종류만 보면 되는 조건은 그냥 넣고,
   말·그림을 봐야 하는 조건은 Haiku 가 한 번에 여러 항목을 보고 고른다 */
const PHOTO_DAY = 200;   // 사람마다 하루에 AI 가 볼 사진 수
const itemKind = (m) => m.media ? (/^image\//.test(m.mime || "") ? "photo" : /^video\//.test(m.mime || "") ? "video" : "file")
  : /https?:\/\/\S+/.test(m.body || "") ? "link" : "text";
const ruleTools = async (uid) => (await pool.query(
  "select id, name, rule from user_tools where owner_id = $1 and rule is not null and (rule->>'on')::boolean", [uid])).rows;
async function collect(bond, row, m, senderId) {
  try {
    if (!m.body && !m.media) return;
    const kind = itemKind(m), self = bond.kind !== "group" && String(bond.a_id) === String(bond.b_id);
    const org = self ? [] : (await pool.query("select user_id from organize where bond_id = $1", [bond.id])).rows.map((r) => String(r.user_id));
    for (const uid of new Set(memberIds(bond))) {   // 나챗방은 a·b 가 같은 사람이라 한 번만
      if (kind === "text" && !self && !org.includes(uid)) continue;   // 글은 나챗방과 정리를 켠 방만
      const tools = await ruleTools(uid);
      if (!self && !tools.some((x) => x.rule.kinds.includes(kind))) continue;   // 받아 갈 도구가 없으면 남기지 않는다
      const it = (await pool.query(
        "insert into items (user_id, bond_id, msg_id, kind, body, media, mime) values ($1, $2, $3, $4, $5, $6, $7) returning *",
        [uid, bond.id, row.id, kind, m.body || "", m.media || null, m.mime || null])).rows[0];
      await fileItems(uid, [it], tools);
    }
  } catch (e) { console.error("collect", e.message) }
}
async function fileItems(uid, items, tools) {
  const hits = [], fit = (x, it) => x.rule.kinds.includes(it.kind);
  for (const x of tools) if (!x.rule.ai) for (const it of items) if (fit(x, it)) hits.push([it.id, x.id, {}]);
  const smart = tools.filter((x) => x.rule.ai);
  const want = items.filter((it) => smart.some((x) => fit(x, it)));
  for (let i = 0; i < want.length && ai; i += 20) hits.push(...await judge(uid, want.slice(i, i + 20), smart));
  for (const [i, x, d] of hits)
    await pool.query("insert into item_hits (item_id, tool_id, data) values ($1, $2, $3) on conflict (item_id, tool_id) do update set data = $3", [i, x, d]);
  const touched = [...new Set(hits.map((h) => h[1]))];
  if (touched.length) notify([String(uid)], { type: "items", tools: touched.map((x) => "u" + x) });
}
const JudgeOut = z.object({ hits: z.array(z.object({ item: z.number(), tool: z.number(), data: z.array(z.object({ k: z.string(), v: z.string() })) })) });
async function judge(uid, items, tools) {
  const day = kstDay();
  const seen = (await pool.query("select coalesce(sum(photos), 0)::int n from ai_usage where day = $1 and user_id = $2", [day, uid])).rows[0].n;
  let room = Math.max(0, PHOTO_DAY - seen), photos = 0;
  const content = [{ type: "text", text: "[도구]\n" + tools.map((x) => `#${x.id} ${x.name}: ${x.rule.ask} (받는 것: ${x.rule.kinds.join(",")}${x.rule.fields.length ? " · 뽑을 값: " + x.rule.fields.join(",") : ""})`).join("\n") + "\n\n[항목]" }];
  for (const it of items) {
    const head = `#${it.id} ${it.kind} ${new Date(it.created_at).toISOString().slice(0, 10)}`;
    if (it.kind === "photo") {
      const f = path.join(MEDIA_DIR, it.media + ".t.jpg");
      if (room <= 0 || !fs.existsSync(f)) continue;
      room--; photos++;
      content.push({ type: "text", text: head + " (사진)" + (it.body ? " " + it.body : "") });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(f).toString("base64") } });
    } else content.push({ type: "text", text: head + ": " + String(it.body || "").slice(0, 600) });
  }
  if (content.length < 2) return [];
  // 가끔 답이 깨져 온다(2026-11-02 재 봄). 그러면 그 묶음이 통째로 안 들어가니 한 번 더 묻는다
  for (let tries = 0; tries < 2; tries++) try {
    const r = await ai.beta.messages.parse({
      model: PATCH_MODEL, max_tokens: 4000,
      output_config: { format: betaZodOutputFormat(JudgeOut) },
      system: `너는 받아 적는다. 각 항목이 어느 도구의 조건에 맞는지 고른다. 조건을 글자 그대로 엄격하게 따른다 — 조건이 "넣지 않는다"고 한 것은 넣지 않고, 애매하면 넣지 않는다. 한 항목이 여러 도구에 맞을 수 있다.
뽑을 값이 있는 도구는 첫째 값이 핵심이다: 그 항목에서 첫째 값을 뽑을 수 없으면 그 도구에는 넣지 않는다(예: 금액이 없는 글은 가계부에 넣지 않는다).
뽑을 값이 있으면 항목에서 그 값만 짧게 뽑는다: 금액은 숫자만(원 단위, "1.2만"→12000), 날짜는 YYYY-MM-DD(오늘은 ${day}, "토요일"은 다가오는 토요일), 시각은 HH:MM, 나머지는 짧은 낱말. 없으면 그 값은 뺀다.`,
      messages: [{ role: "user", content }],
    });
    await spend(uid, usdOf(PATCH_MODEL, r.usage || {}), false);
    if (photos) await pool.query("update ai_usage set photos = photos + $3 where day = $1 and user_id = $2", [day, uid, photos]);
    const ids = new Set(items.map((x) => Number(x.id))), ts = new Set(tools.map((x) => Number(x.id)));
    return (r.parsed_output?.hits || []).filter((h) => ids.has(h.item) && ts.has(h.tool))
      .map((h) => [h.item, h.tool, Object.fromEntries(h.data.map((p) => [p.k.slice(0, 20), p.v.slice(0, 100)]))]);
  } catch (e) { console.error("judge", tries, e.status || "", e.message) }
  return [];
}
// 조건이 생기거나 바뀐 도구: 지난 항목을 다시 훑는다(최근 300개)
async function refill(uid, toolId) {
  try {
    const x = (await pool.query("select id, name, rule from user_tools where id = $1", [toolId])).rows[0];
    await pool.query("delete from item_hits where tool_id = $1", [toolId]);
    if (!x?.rule?.on) return notify([String(uid)], { type: "items", tools: ["u" + toolId] });
    const items = (await pool.query("select * from items where user_id = $1 order by id desc limit 300", [uid])).rows.reverse();
    await fileItems(uid, items, [x]);
    notify([String(uid)], { type: "items", tools: ["u" + toolId] });
  } catch (e) { console.error("refill", e.message) }
}

/* ---------- 틸봇의 판단 ----------
   @ 로 부르면 먼저 싼 모델이 이 방의 도구 목록·내용 요약·바로 앞 대화를 보고 넷 중 하나를 고른다.
   show(있는 도구 꺼내 보이기)·answer(내용으로 답하기)는 여기서 끝나고, edit·new 만 만드는 모델로 간다 */
const RouteOut = z.object({ action: z.enum(["show", "answer", "edit", "new"]), tool: z.number(), reply: z.string() });
async function botContext(bond, uid) {
  const rows = (await pool.query(
    `select r.tool, r.data, t.id, t.name, t.owner_id, t.rule from room_state r join user_tools t on 'u' || t.id = r.tool
      where r.bond_id = $1 order by t.id`, [bond.id])).rows;
  const tools = [];
  for (const r of rows) {
    const d = { ...(r.data || {}) }; const on = !!d.on; delete d.log; delete d.on; delete d.ver; delete d.name;
    let sum = JSON.stringify(d).slice(0, 300);
    if (r.rule && r.owner_id === uid) {
      const its = (await pool.query(
        `select i.body, h.data, i.created_at from item_hits h join items i on i.id = h.item_id where h.tool_id = $1 order by i.id desc limit 12`, [r.id])).rows;
      const n = (await pool.query("select count(*)::int n from item_hits where tool_id = $1", [r.id])).rows[0].n;
      sum = `항목 ${n}개. 최근: ` + its.map((x) => `${new Date(x.created_at).toISOString().slice(5, 10)} ${String(x.body).slice(0, 40)} ${JSON.stringify(x.data)}`).join(" / ") + (sum !== "{}" ? ` · 저장: ${sum}` : "");
    }
    tools.push({ id: Number(r.id), name: r.name, on, mine: r.owner_id === uid, ask: r.rule?.ask || "", sum });
  }
  const hist = (await pool.query(
    "select body, mime from messages where bond_id = $1 and kind = 'bot' order by id desc limit 6", [bond.id])).rows.reverse()
    .map((m) => { const b = botMeta(m.mime); return (b.ask ? `사용자: @${b.ask}\n` : "") + `틸봇: ${m.body}${b.name ? ` [${b.name}]` : ""}` }).join("\n");
  return { tools, history: hist };
}
async function botRoute(uid, ctx, text, ridTool, seen) {
  const ids = new Set(ctx.tools.map((x) => x.id));
  const fall = { action: ridTool && ids.has(ridTool) ? "edit" : "new", tool: ridTool || 0, reply: "" };
  if (!ctx.tools.length) return { action: "new", tool: 0, reply: "" };
  try {
    const r = await ai.beta.messages.parse({
      model: PATCH_MODEL, max_tokens: 1500,
      output_config: { format: betaZodOutputFormat(RouteOut) },
      system: `너는 틸봇이다. 사용자가 대화방에서 "@..." 로 한 말을 보고 할 일 하나를 고른다.
- show: 이미 있는 도구를 찾거나 보여 달라는 말("가계부 보여줘", "가계부 어딨어", "열어 줘", "찾아 줘", 도구 이름만 말함). tool = 그 도구.
- answer: 도구에 든 내용이나 앞 대화로 답할 수 있는 질문("이번 달 얼마 썼어?", "토요일에 뭐 있어?", "할 일 몇 개 남았어?", "아까 그거 뭐였지?").
  reply 에 한두 문장으로 답한다. 숫자는 도구 내용에서 직접 세고 더한다(금액은 쉼표, "원"). 모르면 모른다고 짧게. tool = 근거가 된 도구(없으면 0).
- edit: 있는 도구를 바꾸거나 더해 달라는 말("카페는 따로", "이름 바꿔", "버튼 키워", "합계 크게"). tool = 그 도구. 남의 도구(mine=false)는 고를 수 없다.
- new: 이 방에 같은 일을 하는 도구가 없을 때만. 이미 비슷한 도구가 있으면 new 가 아니라 show 나 edit 다(가계부가 있는데 "가계부" → show).
  사용자가 "하나 더", "새로", "따로 하나" 처럼 분명히 새 것을 원할 때만 비슷해도 new.
- 앞 대화를 이어서 이해한다: "그거", "아까 만든 거", "이름 바꿔 줘" 는 앞에서 말한 도구다. 답장한 도구·보고 있는 도구가 있으면 애매할 때 그것을 가리킨다.
show 의 reply 는 아주 짧게(예: "가계부예요"). edit·new 의 reply 는 빈 글. 말투는 짧고 친근하게, 설명 늘어놓지 않는다.`,
      messages: [{ role: "user", content:
        `[이 방의 도구]\n${ctx.tools.map((x) => `#${x.id} ${x.name}${x.mine ? "" : " (남의 것)"}${x.on ? "" : " (내려 둠)"}${x.ask ? " · 받는 것: " + x.ask : ""}\n  내용: ${x.sum}`).join("\n")}\n\n` +
        (ctx.history ? `[바로 앞 대화]\n${ctx.history}\n\n` : "") +
        (ridTool ? `[답장한 도구] #${ridTool}\n` : "") + (seen ? `[지금 보고 있는 도구] #${seen}\n` : "") +
        `\n[사용자]\n@${text}` }],
    });
    await spend(uid, usdOf(PATCH_MODEL, r.usage || {}), false);
    const o = r.parsed_output; if (!o) return fall;
    console.log("route", JSON.stringify({ text: text.slice(0, 40), action: o.action, tool: o.tool }));
    if (o.action !== "new" && o.tool && !ids.has(o.tool)) o.tool = 0;
    if ((o.action === "show" || o.action === "edit") && !o.tool) return fall;
    if (o.action === "edit" && !ctx.tools.find((x) => x.id === o.tool)?.mine) return { action: "answer", tool: o.tool, reply: "만든 사람만 고칠 수 있어요" };
    return o;
  } catch (e) { console.error("route", e.status || "", e.message); return fall }
}
// show·answer: 만들지 않고 말풍선 하나. show 는 그 도구를 위 칸에 꺼내 펼치게 한다(내려 둔 것이면 다시 띄운다)
async function botSay(bond, uid, route, rid, text, ctx) {
  const tl = ctx.tools.find((x) => x.id === route.tool);
  let ver = null;
  if (tl) {
    const st = (await pool.query("select data from room_state where bond_id = $1 and tool = $2", [bond.id, "u" + tl.id])).rows[0];
    ver = Number(st?.data?.ver) || null;
    if (route.action === "show" && !tl.on) {
      await pool.query("update room_state set data = data || '{\"on\":true}'::jsonb, updated_at = now() where bond_id = $1 and tool = $2", [bond.id, "u" + tl.id]);
      notify(memberIds(bond), { type: "room", bondId: bond.id, tool: "u" + tl.id });
    }
  }
  const reply = String(route.reply || (tl ? tl.name : "")).slice(0, 300) || "네";
  const meta = { bot: "free", tool: tl ? tl.id : null, ver, name: tl ? tl.name : "", note: "", made: false, owner: uid, show: route.action === "show", ask: String(text).slice(0, 200) };
  const { rows } = await pool.query(
    "insert into messages (bond_id, sender_id, body, kind, mime, reply_to) values ($1, $2, $3, 'bot', $4, $5) returning id, created_at",
    [bond.id, Number(uid), reply, JSON.stringify(meta), rid || null]);
  const msg = { id: rows[0].id, body: reply, at: rows[0].created_at, bondId: bond.id, from: uid, kind: "bot", bot: meta, replyTo: rid ? String(rid) : null };
  notify(memberIds(bond), { type: "message", ...msg }, uid);
  return msg;
}

const botFree = (bond, bot) => { botBusy.delete(bond.id); notify(memberIds(bond), { type: "botwork", bondId: bond.id, bot, on: false }) };
// 오래 응답이 없으면(앱을 닫음 등) 만들던 것을 버린다
setInterval(() => {
  for (const [k, p] of botPending) if (Date.now() - p.at > 180000) { botPending.delete(k); botFree(p.bond, p.bot) }
  for (const [k, t] of botBusy) if (Date.now() - t > 240000) botBusy.delete(k);
}, 30000);

app.post("/api/rooms/:bondId/bot", auth, async (req, res) => {
  if (!ai) return res.status(503).json({ error: "AI 준비 중이에요" });
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  let bot = BOTS[req.body?.bot] ? req.body.bot : null;   // 이름 없이 부르면 아래에서: 고치는 거면 그 도구의 봇, 새로면 말로 고른다
  const text = String(req.body?.text || "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: "무엇을 할지 적어주세요" });
  const uid = String(req.user.id);
  if (botBusy.has(bond.id)) return res.status(429).json({ error: "봇이 아직 만드는 중이에요" });
  if (Date.now() - (botLast.get(uid) || 0) < 15000) return res.status(429).json({ error: "잠시 뒤에 불러주세요" });
  const spent = (await pool.query("select coalesce(sum(usd), 0)::float usd from ai_usage where day = $1", [kstDay()])).rows[0].usd;
  if (spent >= AI_DAILY_USD || (await botLeft(req.user.id, bond.id)) <= 0) return res.status(429).json({ error: "오늘 사용 한도를 넘었어요" });

  // 틸봇이 먼저 판단한다: 있는 도구를 보여 줄지, 내용으로 답할지, 고칠지, 새로 만들지. 바로 앞 대화도 본다(2026-11-03)
  const rid = Number(req.body?.replyTo) || 0;
  let ridTool = null;
  if (rid) {
    const m = (await pool.query("select mime from messages where id = $1 and bond_id = $2 and kind = 'bot'", [rid, bond.id])).rows[0];
    if (m) ridTool = Number(botMeta(m.mime).tool) || null;
  }
  const seen = /^u\d+$/.test(String(req.body?.toolId || "")) ? Number(String(req.body.toolId).slice(1)) : null;
  const ctx = await botContext(bond, req.user.id);
  const route = await botRoute(req.user.id, ctx, text, ridTool, seen);
  if (route.action === "show" || route.action === "answer") return res.json(await botSay(bond, uid, route, rid, text, ctx));
  let tool = route.action === "edit" && route.tool ? (await pool.query("select * from user_tools where id = $1", [route.tool])).rows[0] : null;
  if (tool && tool.owner_id !== req.user.id) return res.status(403).json({ error: "만든 사람만 고칠 수 있어요" });
  if (!bot) bot = tool && BOTS[tool.bot] ? tool.bot : guessBot(text);
  botBusy.set(bond.id, Date.now()); botLast.set(uid, Date.now());
  notify(memberIds(bond), { type: "botwork", bondId: bond.id, bot, on: true });
  const cur = tool && tool.ver ? await toolCode(tool.id, tool.ver) : null;
  let r = null, counted = false;
  if (cur) {
    const pt = await botPatch(req.user.id, bot, cur.code, text);
    counted = !!pt?.counted;
    if (pt?.out) r = { ...pt, out: { ...pt.out, name: tool.name } };
  }
  if (!r) try {
    r = await botAsk(req.user.id, bot,
      (String(bond.a_id) === String(bond.b_id) && bond.kind !== "group" ? "[이 방: 나챗방(나와의 대화). 받아 가는 도구를 만들 수 있다]\n" : `[이 방: ${bond.kind === "group" ? (bond.members || []).length : 2}명 대화방. rule.on=false]\n`) +
      (cur ? `[지금 도구 코드 · ${tool.ver}번 버전 · 이름 "${tool.name}"]\n${tool.rule ? "[지금 조건] " + JSON.stringify(tool.rule) + "\n" : ""}${cur.code}\n\n` : "[아직 만든 코드 없음]\n\n") +
      (ctx.history ? `[바로 앞 대화]\n${ctx.history}\n\n` : "") +
      `[사용자]\n${text}\n\n(대화방에서 한 번에 부른 것이다. 되묻지 말고 알맞게 정해서 바로 만든다. reply 는 한 문장.)`, !counted);
  } catch (e) {
    console.error("roombot", e.status || "", e.message);
    botFree(bond, bot);
    return res.status(502).json({ error: "봇이 답하지 못했어요. 다시 불러주세요" });
  }
  if (!r.out) { botFree(bond, bot); return res.status(502).json({ error: "봇이 답하지 못했어요. 다시 불러주세요" }) }
  if (tool && r.out.fresh && r.good) tool = null;   // 새 도구를 원한 것
  const p = { at: Date.now(), bond, uid, bot, text, rid, tool, out: r.out, fixes: 0 };
  if (!r.good) return res.json(await botFinish(p, false));   // 말만 한 경우(못 만드는 부탁 등): 검사할 것 없이 바로 답
  const key = crypto.randomBytes(9).toString("base64url");
  botPending.set(key, p);
  res.json({ check: key, code: r.out.code });
});
// 앱의 검사 결과. issues 가 있으면 봇이 고친 새 코드를 돌려주고, 없으면(또는 고칠 만큼 고쳤으면) 방에 붙인다
app.post("/api/rooms/:bondId/bot/check", auth, async (req, res) => {
  const key = String(req.body?.check || ""), p = botPending.get(key);
  if (!p || p.uid !== String(req.user.id)) return res.status(404).json({ error: "만들던 도구가 없어요" });
  p.at = Date.now();
  const issues = (Array.isArray(req.body?.issues) ? req.body.issues : []).map((x) => String(x).slice(0, 200)).slice(0, 8);
  const broken = issues.some((x) => x.startsWith("오류"));
  if (issues.length && p.fixes < BOT_FIXES) {
    p.fixes++;
    let r;
    try {
      r = await botAsk(req.user.id, p.bot,
        `[방금 네가 만든 도구 코드]\n${p.out.code}\n\n[사용자가 처음 부탁한 것]\n${p.text}\n\n` +
        `[실제 칸에 그려 보고 버튼을 눌러 본 검사 결과 — 이것만 고친다]\n${issues.map((x) => "- " + x).join("\n")}\n\n` +
        `(같은 도구다. 하는 일·이름·모양은 그대로 두고 위 문제만 고친다. changed=true, code 에 고친 render 전체, reply 는 처음 만든 것처럼 한 문장.)`, false);
    } catch (e) { r = null }
    if (r && r.good) { p.out = { ...r.out, name: p.out.name, fresh: p.out.fresh }; return res.json({ check: key, code: p.out.code }) }
  }
  botPending.delete(key);
  if (broken) {   // 고쳐도 오류가 남으면 붙이지 않는다
    botFree(p.bond, p.bot);
    return res.status(422).json({ error: "봇이 제대로 만들지 못했어요. 다시 불러주세요" });
  }
  res.json(await botFinish(p, true));
});
// 버전을 남기고 위 칸에 붙인 뒤, 봇 말풍선을 방에 올린다
async function botFinish(p, made) {
  const { bond, out, uid, rid } = p;
  let tool = p.tool, ver = null, fresh = false;
  try {
    if (made) {
      if (!tool) {
        tool = (await pool.query("insert into user_tools (owner_id, name, bot) values ($1, $2, $3) returning *",
          [Number(uid), (out.name || "새 도구").slice(0, 30), p.bot])).rows[0];
        await pool.query("insert into tool_chats (tool_id, messages) values ($1, '[]')", [tool.id]);
        fresh = true;
      }
      ver = await addVersion(tool, out.code, out.note.slice(0, 80) || (fresh ? "처음" : "고침"));
      // 받아 가는 조건은 나챗방에서 만든 도구만. 작은 고치기(rule 없음)는 조건을 그대로 둔다
      const selfRoom = bond.kind !== "group" && String(bond.a_id) === String(bond.b_id);
      if (out.rule) {
        const rule = selfRoom && out.rule.on ? { on: true, kinds: out.rule.kinds, ai: out.rule.ai, ask: out.rule.ask.slice(0, 200), fields: out.rule.fields.slice(0, 8) } : null;
        if (JSON.stringify(rule) !== JSON.stringify(tool.rule || null)) {
          await pool.query("update user_tools set rule = $2 where id = $1", [tool.id, rule]);
          refill(Number(uid), tool.id);
        }
      }
      if (!fresh && out.name && out.name !== tool.name) await pool.query("update user_tools set name = $2 where id = $1", [tool.id, out.name.slice(0, 30)]);
      // 켜 둔 도구에 더한다(다른 도구는 그대로 켜 둔다. 위 칸에서 옆으로 넘겨 본다)
      const key = "u" + tool.id;
      await pool.query(
        `insert into room_state (bond_id, tool, data) values ($1, $2, $3)
           on conflict (bond_id, tool) do update set data = room_state.data || $3, updated_at = now()`,
        [bond.id, key, { on: true, ver, name: (out.name || tool.name).slice(0, 30) }]);
    }
    const reply = out.reply.slice(0, 300);
    const meta = { bot: p.bot, tool: tool ? tool.id : null, ver, name: tool ? (out.name || tool.name).slice(0, 30) : "", note: ver ? out.note.slice(0, 80) : "", made: fresh, owner: uid, ask: String(p.text || "").slice(0, 200) };
    const { rows } = await pool.query(
      "insert into messages (bond_id, sender_id, body, kind, mime, reply_to) values ($1, $2, $3, 'bot', $4, $5) returning id, created_at",
      [bond.id, Number(uid), reply, JSON.stringify(meta), rid || null]);
    const msg = { id: rows[0].id, body: reply, at: rows[0].created_at, bondId: bond.id, from: uid, kind: "bot", bot: meta, replyTo: rid ? String(rid) : null };
    notify(memberIds(bond), { type: "message", ...msg }, uid);
    if (ver) notify(memberIds(bond), { type: "room", bondId: bond.id, tool: "u" + tool.id });
    return msg;
  } finally { botFree(bond, p.bot) }
}

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
  // 만든 지 7일이 지나도록 아무도 들어오지 않은 방은 지운다
  await pool.query(
    `delete from bonds b where b.kind = 'group' and b.bond_at < now() - interval '7 days'
       and (select count(*) from bond_members m where m.bond_id = b.id) < 2`);
  await pool.query("delete from requests where created_at < now() - interval '7 days'");
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

// 받아 가는 도구의 항목(주인만)
app.get("/api/tools/:id/items", auth, async (req, res) => {
  const id = Number(String(req.params.id).replace(/^u/, "")) || 0;
  const x = (await pool.query("select owner_id from user_tools where id = $1", [id])).rows[0];
  if (!x || x.owner_id !== req.user.id) return res.json({ items: [] });
  const { rows } = await pool.query(
    `select i.id, i.kind, i.body, i.media, i.mime, i.created_at, i.msg_id, h.data, b.id bond_id, b.name bname, b.kind bkind, b.a_id, b.b_id, ua.nickname an, ub.nickname bn
       from item_hits h join items i on i.id = h.item_id left join bonds b on b.id = i.bond_id
       left join users ua on ua.id = b.a_id left join users ub on ub.id = b.b_id
      where h.tool_id = $1 order by i.id desc limit 300`, [id]);
  const me = req.user.id;
  res.json({ items: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.body, media: r.media, mime: r.mime, at: r.created_at, msg: r.msg_id, data: r.data || {},
    room: !r.bond_id ? "" : r.a_id === r.b_id && r.bkind !== "group" ? "" : r.bkind === "group" ? (r.bname || "") : (r.a_id === me ? r.bn : r.an) })) });
});
// 나챗방 말풍선 아래 작은 글씨: 그 글이 들어간 도구들
app.get("/api/self/tags", auth, async (req, res) => {
  const { rows } = await pool.query(
    `select i.msg_id, string_agg(t.name, ' · ' order by t.id) names from items i join item_hits h on h.item_id = i.id join user_tools t on t.id = h.tool_id
      where i.user_id = $1 and i.msg_id is not null group by i.msg_id order by i.msg_id desc limit 400`, [req.user.id]);
  res.json({ tags: Object.fromEntries(rows.map((r) => [String(r.msg_id), r.names])) });
});
// 나챗방 말풍선 하나가 들어간 도구들과, 넣을 수 있는 내 도구들
app.get("/api/self/item/:msgId", auth, async (req, res) => {
  const it = (await pool.query("select id from items where user_id = $1 and msg_id = $2", [req.user.id, Number(req.params.msgId) || 0])).rows[0];
  if (!it) return res.json({ tools: [] });
  const { rows } = await pool.query(
    `select t.id, t.name, exists (select 1 from item_hits h where h.item_id = $2 and h.tool_id = t.id) hit
       from user_tools t where t.owner_id = $1 and t.rule is not null and (t.rule->>'on')::boolean order by t.id`, [req.user.id, it.id]);
  res.json({ item: it.id, tools: rows.map((r) => ({ id: "u" + r.id, name: r.name, on: r.hit })) });
});
app.post("/api/self/item/:itemId", auth, async (req, res) => {
  const it = (await pool.query("select id from items where id = $1 and user_id = $2", [Number(req.params.itemId) || 0, req.user.id])).rows[0];
  const tool = Number(String(req.body?.tool || "").replace(/^u/, "")) || 0;
  if (!it || !(await pool.query("select 1 from user_tools where id = $1 and owner_id = $2", [tool, req.user.id])).rowCount) return res.sendStatus(404);
  if (req.body?.on) await pool.query("insert into item_hits (item_id, tool_id) values ($1, $2) on conflict do nothing", [it.id, tool]);
  else await pool.query("delete from item_hits where item_id = $1 and tool_id = $2", [it.id, tool]);
  notify([String(req.user.id)], { type: "items", tools: ["u" + tool] });
  res.json({ ok: true });
});
// 이 방도 정리(나에게만). 켜면 이 방의 글도 받아 적는다
app.post("/api/rooms/:bondId/organize", auth, async (req, res) => {
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  if (req.body?.on) await pool.query("insert into organize (user_id, bond_id) values ($1, $2) on conflict do nothing", [req.user.id, bond.id]);
  else await pool.query("delete from organize where user_id = $1 and bond_id = $2", [req.user.id, bond.id]);
  res.json({ on: !!req.body?.on });
});
app.get("/api/rooms/:bondId/organize", auth, async (req, res) => {
  res.json({ on: !!(await pool.query("select 1 from organize where user_id = $1 and bond_id = $2", [req.user.id, Number(req.params.bondId) || 0])).rowCount });
});
// 나챗방 처음 열 때 기본 도구(일정·할 일·링크·메모)를 깔아 둔다. 한 번만
const SELF_DEFAULTS = require("./self-defaults");
app.post("/api/self/setup", auth, async (req, res) => {
  await ensureSelfBond(req.user.id);
  const bond = (await pool.query("select id from bonds where a_id = $1 and b_id = $1 and kind <> 'group'", [req.user.id])).rows[0];
  if (!bond) return res.json({ ok: false });
  const done = await pool.query("insert into room_state (bond_id, tool, data) values ($1, '__setup', '{}') on conflict do nothing returning 1", [bond.id]);
  if (!done.rowCount) return res.json({ ok: true, made: 0 });
  for (const d of SELF_DEFAULTS) {
    const tool = (await pool.query("insert into user_tools (owner_id, name, bot, rule) values ($1, $2, 'free', $3) returning *", [req.user.id, d.name, d.rule])).rows[0];
    const ver = await addVersion(tool, d.code, "처음");
    await pool.query("insert into room_state (bond_id, tool, data) values ($1, $2, $3) on conflict do nothing", [bond.id, "u" + tool.id, { on: true, ver, name: d.name }]);
    refill(req.user.id, tool.id);
  }
  res.json({ ok: true, made: SELF_DEFAULTS.length });
});

app.get("/health", (_, res) => res.json({ ok: true, now: new Date().toISOString() }));

/* 칸이 늘어난 날 잊지 않도록, 켜질 때 스스로 맞춘다.
   모두 "없으면 만든다" 라 매번 돌아도 공짜다. schema.sql 의 같은 줄과 짝이 맞아야 한다 */
const SCHEMA_PATCHES = [
  "alter table user_tools add column if not exists public boolean not null default false",
  "create index if not exists user_tools_public_idx on user_tools(public) where public",
  "alter table user_tools add column if not exists rule jsonb",
  `create table if not exists items (id bigserial primary key, user_id bigint not null references users(id) on delete cascade,
     bond_id bigint references bonds(id) on delete set null, msg_id bigint, kind text not null, body text not null default '',
     media text, mime text, created_at timestamptz not null default now())`,
  "create index if not exists items_user_idx on items(user_id, id desc)",
  `create table if not exists item_hits (item_id bigint not null references items(id) on delete cascade,
     tool_id bigint not null references user_tools(id) on delete cascade, data jsonb not null default '{}'::jsonb, primary key (item_id, tool_id))`,
  "create index if not exists item_hits_tool_idx on item_hits(tool_id, item_id desc)",
  `create table if not exists organize (user_id bigint not null references users(id) on delete cascade,
     bond_id bigint not null references bonds(id) on delete cascade, primary key (user_id, bond_id))`,
  "alter table ai_usage add column if not exists photos int not null default 0",
];
async function ensureSchema() {
  for (const sql of SCHEMA_PATCHES) {
    try { await pool.query(sql); }
    catch (e) { console.error("schema: " + e.message); }
  }
}

ensureSchema().then(() =>
  server.listen(PORT, "127.0.0.1", () =>
    console.log(`till zero server on 127.0.0.1:${PORT}`)
  )
);
