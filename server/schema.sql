-- Till Zero 서버 데이터베이스
-- 규칙 문서(service-rules.md)의 R-4.1, R-4.2, R-8.7을 따른다.

create table if not exists users (
  id         bigserial primary key,
  nickname   text unique not null,
  dob        date,
  pass_hash  text not null,
  photo      text,          -- 프로필 사진 (data URL). 상대 Till에도 보이므로 서버가 갖는다.
  tools      jsonb  not null default '[]'::jsonb,   -- 설치한 도구 id 목록 (계정 단위)
  code       text unique,  -- 내 초대 코드 6자리. 새로 만들면 이전 코드는 무효
  noti       jsonb  not null default '{}'::jsonb,   -- 알림 설정 {msg, req, dday, dnd}
  phone_hash text unique,  -- 휴대폰 번호를 되돌릴 수 없게 바꾼 값. 번호 하나에 계정 하나(R-8.1, R-8.4)
  phone_tail text,         -- 화면 표시용 끝 4자리

  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token      text primary key,
  user_id    bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Bond는 두 사람 사이의 것이므로 (a_id < b_id)로 순서를 고정해 중복을 막는다.
create table if not exists bonds (
  id            bigserial primary key,
  a_id          bigint not null references users(id) on delete cascade,
  b_id          bigint not null references users(id) on delete cascade,
  keep          int    not null default 0,
  bond_at       timestamptz not null default now(),
  -- R-4.1: 남은 일수는 저장하지 않는다. 마지막 Reset 시각만 두고 볼 때마다 계산한다.
  last_reset_at timestamptz not null default now(),
  -- R-4.2: 마지막 Reset 이후 각자 한 번이라도 보냈는지
  a_sent        boolean not null default false,
  b_sent        boolean not null default false,
  -- 각자 이 Bond를 마지막으로 읽은 시각. 안 읽은 표시(동그라미)에 쓴다.
  a_read_at     timestamptz not null default now(),
  b_read_at     timestamptz not null default now(),
  -- 마지막으로 보낸 Count 경고(7 또는 1). Reset 되면 비운다(R-6.3)
  warned        int,
  -- a_id = b_id 이면 "나와의 대화방". 그 밖에는 순서를 고정해 중복을 막는다.
  check (a_id <= b_id),
  unique (a_id, b_id)
);

create table if not exists messages (
  id         bigserial primary key,
  bond_id    bigint not null references bonds(id) on delete cascade,
  sender_id  bigint not null references users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_bond_idx on messages(bond_id, id);

-- 받은 요청. 코드를 넣으면 생기고, 받은 사람이 수락하면 Bond 가 된다. 7일 뒤 사라진다
create table if not exists requests (
  from_id    bigint not null references users(id) on delete cascade,
  to_id      bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id)
);

-- 차단. 풀기 전까지 다시 맺을 수 없다(R-8.5)
create table if not exists blocks (
  blocker_id bigint not null references users(id) on delete cascade,
  blocked_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

-- Zero 기록. 누구와 언제였는지만. 7일 대기(R-3.8)와 신고 대응(R-8.6)용, 90일 뒤 삭제
create table if not exists zeros (
  a_id      bigint not null references users(id) on delete cascade,
  b_id      bigint not null references users(id) on delete cascade,
  zeroed_at timestamptz not null default now()
);
create index if not exists zeros_pair_idx on zeros(a_id, b_id);

-- 신고. 최근 대화 50개를 함께 남긴다. 운영자만 보고 90일 뒤 삭제
create table if not exists reports (
  id          bigserial primary key,
  reporter_id bigint references users(id) on delete set null,
  target_id   bigint references users(id) on delete set null,
  reason      text not null,
  snapshot    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now()
);

-- 웹 푸시 구독. 기기(브라우저)마다 하나
create table if not exists push_subs (
  endpoint   text primary key,
  user_id    bigint not null references users(id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now()
);

-- 도구가 쓰는 방 저장소. 도구 하나가 방 하나에 데이터 한 덩어리를 갖는다.
-- Bond가 사라지면(Zero) 여기 쌓인 것도 함께 사라진다.
create table if not exists room_state (
  bond_id    bigint not null references bonds(id) on delete cascade,
  tool       text   not null,
  data       jsonb  not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (bond_id, tool)
);

-- 휴대폰 인증번호. 번호마다 하나, 3분 유효, 하루 지나면 지운다
create table if not exists phone_codes (
  phone_hash text primary key,
  code_hash  text not null,
  expires_at timestamptz not null,
  tries      int not null default 0,
  sends      int not null default 0,
  day        date,
  last_sent  timestamptz not null default now()
);

-- 인증 문자를 보낸 시각. 하루 전체 발송량 제한용, 하루 지나면 지운다
create table if not exists sms_sends (
  at timestamptz not null default now()
);
