-- Till Zero 서버 데이터베이스
-- 규칙 문서(service-rules.md)의 R-4.1, R-4.2, R-8.7을 따른다.

create table if not exists users (
  id         bigserial primary key,
  nickname   text unique not null,
  dob        date,
  pass_hash  text not null,
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
  check (a_id < b_id),
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

create table if not exists invites (
  code       text primary key,
  inviter_id bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by    bigint references users(id)
);
