/* Till Zero 서버
 *
 * 규칙은 service-rules.md를 따른다. 특히:
 *   R-4.1  Count는 기기 시간이 아니라 서버 시간으로, lastResetAt에서 계산한다.
 *   R-4.2  마지막 Reset 이후 양쪽이 각각 한 번 이상 보냈을 때 Reset된다.
 *   R-4.3  한쪽만 보낸 것은 Reset이 아니다.
 *   R-7.1  대화는 1:1만.
 */
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

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
const inviteCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();

// R-4.1: 남은 일수는 저장하지 않고 볼 때마다 계산한다.
const ddayOf = (lastResetAt) =>
  Math.max(0, CYCLE_DAYS - Math.floor((Date.now() - new Date(lastResetAt)) / DAY));

const daysOf = (bondAt) =>
  Math.max(1, Math.floor((Date.now() - new Date(bondAt)) / DAY));

async function auth(req, res, next) {
  const t = (req.get("authorization") || "").replace(/^Bearer /, "");
  if (!t) return res.status(401).json({ error: "로그인이 필요해요" });
  const { rows } = await pool.query(
    "select u.id, u.nickname, u.dob, u.photo from sessions s join users u on u.id = s.user_id where s.token = $1",
    [t]
  );
  if (!rows[0]) return res.status(401).json({ error: "로그인이 필요해요" });
  req.user = rows[0];
  next();
}

// Bond 한 건을 "내 쪽에서 본" 모양으로 바꾼다.
function shape(row, meId) {
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
    join users ua on ua.id = b.a_id
    join users ub on ub.id = b.b_id
    left join lateral (
      select body, created_at, sender_id from messages
       where bond_id = b.id order by id desc limit 1
    ) m on true`;

/* ---------- 계정 ---------- */

app.post("/api/signup", async (req, res) => {
  const { nickname, password, dob } = req.body || {};
  if (!nickname || !password) return res.status(400).json({ error: "닉네임과 비밀번호를 입력해주세요" });
  const exists = await pool.query("select 1 from users where nickname = $1", [nickname]);
  if (exists.rowCount) return res.status(409).json({ error: "이미 쓰는 닉네임이에요" });

  const { rows } = await pool.query(
    "insert into users (nickname, dob, pass_hash) values ($1, $2, $3) returning id, nickname, dob",
    [nickname, dob || null, await bcrypt.hash(password, 10)]
  );
  const t = token();
  await pool.query("insert into sessions (token, user_id) values ($1, $2)", [t, rows[0].id]);
  res.json({ token: t, me: rows[0] });
});

app.post("/api/login", async (req, res) => {
  const { nickname, password } = req.body || {};
  const { rows } = await pool.query("select * from users where nickname = $1", [nickname || ""]);
  if (!rows[0] || !(await bcrypt.compare(password || "", rows[0].pass_hash)))
    return res.status(401).json({ error: "닉네임이나 비밀번호가 맞지 않아요" });

  const t = token();
  await pool.query("insert into sessions (token, user_id) values ($1, $2)", [t, rows[0].id]);
  res.json({ token: t, me: { id: rows[0].id, nickname: rows[0].nickname, dob: rows[0].dob } });
});

/* ---------- Till ---------- */

async function ensureSelfBond(userId) {
  await pool.query(
    "insert into bonds (a_id, b_id) values ($1, $1) on conflict (a_id, b_id) do nothing",
    [userId]
  );
}

app.get("/api/till", auth, async (req, res) => {
  await ensureSelfBond(req.user.id);
  const { rows } = await pool.query(
    `${BOND_SELECT} where b.a_id = $1 or b.b_id = $1`,
    [req.user.id]
  );
  const bonds = rows.map((r) => shape(r, req.user.id));
  // R-4.8: Count 높은 순, 같으면 마지막 대화가 최근인 순, 그다음 이름순
  bonds.sort(
    (x, y) =>
      y.dday - x.dday ||
      new Date(y.lastAt || 0) - new Date(x.lastAt || 0) ||
      x.name.localeCompare(y.name)
  );
  res.json({ me: req.user, bonds });
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

app.post("/api/invite", auth, async (req, res) => {
  const code = inviteCode();
  // R-3.3: 초대 링크는 7일 뒤 만료된다.
  await pool.query(
    "insert into invites (code, inviter_id, expires_at) values ($1, $2, now() + interval '7 days')",
    [code, req.user.id]
  );
  res.json({ code });
});

app.post("/api/invite/accept", auth, async (req, res) => {
  const code = String(req.body?.code || "").trim().toUpperCase();
  const { rows } = await pool.query(
    "select * from invites where code = $1 and used_by is null and expires_at > now()",
    [code]
  );
  if (!rows[0]) return res.status(404).json({ error: "이 초대는 지났어요" });
  if (rows[0].inviter_id === req.user.id)
    return res.status(400).json({ error: "내 초대예요" });

  const [a, b] = [rows[0].inviter_id, req.user.id].sort((x, y) => x - y);
  const dup = await pool.query("select 1 from bonds where a_id = $1 and b_id = $2", [a, b]);
  if (dup.rowCount) return res.status(409).json({ error: "이미 Till에 있어요" });

  // R-3.4: Bond가 맺어지는 순간 Count는 30에서 시작한다.
  const bond = await pool.query(
    "insert into bonds (a_id, b_id) values ($1, $2) returning id",
    [a, b]
  );
  await pool.query("update invites set used_by = $1 where code = $2", [req.user.id, code]);
  notify([rows[0].inviter_id, req.user.id], { type: "till" });
  res.json({ bondId: bond.rows[0].id });
});

/* ---------- 대화 ---------- */

app.get("/api/messages/:bondId", auth, async (req, res) => {
  const bond = await myBond(req.params.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const { rows } = await pool.query(
    "select id, sender_id, body, created_at from messages where bond_id = $1 order by id",
    [bond.id]
  );
  // 여는 순간 읽은 것으로 친다 (R-7.4에 따라 상대에게는 알리지 않는다)
  const iAmA = String(bond.a_id) === String(req.user.id);
  await pool.query(
    `update bonds set ${iAmA ? "a_read_at" : "b_read_at"} = now() where id = $1`,
    [bond.id]
  );
  res.json({
    bond: shape(bond, req.user.id),
    messages: rows.map((m) => ({
      id: m.id,
      mine: m.sender_id === req.user.id,
      body: m.body,
      at: m.created_at,
    })),
  });
});

app.post("/api/messages", auth, async (req, res) => {
  const body = String(req.body?.body || "").trim();
  if (!body) return res.status(400).json({ error: "빈 메시지는 보낼 수 없어요" });

  const bond = await myBond(req.body?.bondId, req.user.id);
  if (!bond) return res.status(404).json({ error: "없는 대화예요" });
  const isSelf = String(bond.a_id) === String(bond.b_id);
  // R-11: Zero 처리가 먼저면 메시지는 거부된다. 나와의 방은 Zero가 없다.
  if (!isSelf && ddayOf(bond.last_reset_at) <= 0)
    return res.status(410).json({ error: "이 대화는 끝났어요" });

  const { rows } = await pool.query(
    "insert into messages (bond_id, sender_id, body) values ($1, $2, $3) returning id, created_at",
    [bond.id, req.user.id, body]
  );

  // R-4.2 / R-4.3: 양쪽이 각각 한 번 이상 보냈을 때만 Reset한다. 나와의 방은 셈하지 않는다.
  if (isSelf) {
    const m = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id };
    notify([req.user.id], { type: "message", ...m }, req.user.id);
    return res.json({ ...m, reset: false });
  }
  const iAmA = bond.a_id === req.user.id;
  const aSent = bond.a_sent || iAmA;
  const bSent = bond.b_sent || !iAmA;
  const reset = aSent && bSent;
  await pool.query(
    reset
      ? `update bonds set keep = keep + 1, last_reset_at = now(),
                          a_sent = false, b_sent = false where id = $1`
      : "update bonds set a_sent = $2, b_sent = $3 where id = $1",
    reset ? [bond.id] : [bond.id, aSent, bSent]
  );

  const msg = { id: rows[0].id, body, at: rows[0].created_at, bondId: bond.id };
  notify([bond.a_id, bond.b_id], { type: "message", ...msg }, req.user.id);
  res.json({ ...msg, reset });
});

async function myBond(bondId, meId) {
  const { rows } = await pool.query(
    `${BOND_SELECT} where b.id = $1 and (b.a_id = $2 or b.b_id = $2)`,
    [Number(bondId) || 0, meId]
  );
  return rows[0];
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
      where r.tool = $2 and (b.a_id = $1 or b.b_id = $1)`,
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
  notify([bond.a_id, bond.b_id], { type: "room", bondId: bond.id, tool: req.params.tool }, req.user.id);
  res.json({ ok: true });
});

/* ---------- 실시간 알림 ---------- */

const sockets = new Map(); // userId -> Set<ws>

function notify(userIds, payload, exceptUserId) {
  for (const id of userIds) {
    if (id === exceptUserId) continue;
    for (const ws of sockets.get(id) || []) {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    }
  }
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const t = new URL(req.url, "http://x").searchParams.get("token") || "";
  const { rows } = await pool.query("select user_id from sessions where token = $1", [t]);
  if (!rows[0]) return ws.close(4001, "unauthorized");

  const uid = rows[0].user_id;
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(ws);
  ws.on("close", () => sockets.get(uid)?.delete(ws));
});

/* ---------- 시작 ---------- */

app.get("/health", (_, res) => res.json({ ok: true, now: new Date().toISOString() }));

server.listen(PORT, "127.0.0.1", () =>
  console.log(`till zero server on 127.0.0.1:${PORT}`)
);
