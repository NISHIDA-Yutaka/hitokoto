-- 本番: sudo -u postgres psql -d hitokoto -f migrations/001_init.sql
-- 開発: psql -d hitokoto_dev -f migrations/001_init.sql
CREATE TABLE rooms (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            text NOT NULL UNIQUE,          -- URL に入る推測しにくい文字列
  settings        jsonb NOT NULL DEFAULT '{}',   -- タイマー枚数、没収枚数、AI 表示など
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE players (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  seat        char(1) NOT NULL CHECK (seat IN ('A','B')),
  name        text NOT NULL,
  token_hash  text NOT NULL,                     -- 再接続用トークンのハッシュ
  UNIQUE (room_id, seat)
);

CREATE TABLE games (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  phase       text NOT NULL DEFAULT 'playing'
              CHECK (phase IN ('playing','sudden_death','won','lost')),
  timer_bank  smallint NOT NULL,
  outs        smallint NOT NULL DEFAULT 0,
  settings    jsonb NOT NULL,                    -- 開始時点の設定を固定して保存
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX games_room_started ON games (room_id, started_at DESC);

CREATE TABLE cells (
  game_id     uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  idx         smallint NOT NULL CHECK (idx BETWEEN 0 AND 24),
  word        text NOT NULL,
  key_a       text NOT NULL CHECK (key_a IN ('green','assassin','bystander')),
  key_b       text NOT NULL CHECK (key_b IN ('green','assassin','bystander')),
  covered     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (game_id, idx)
);

CREATE TABLE turns (
  id          bigserial PRIMARY KEY,
  game_id     uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  turn_no     smallint NOT NULL,
  giver       char(1) NOT NULL CHECK (giver IN ('A','B')),
  hint        text NOT NULL,                     -- サドンデスの手番は空文字
  number      smallint NOT NULL CHECK (number >= 0),
  intended    smallint[] NOT NULL,               -- 狙いカード（ゲーム終了まで外に出さない）
  end_reason  text CHECK (end_reason IN ('stop','bystander','assassin','gameover')),
  ai          jsonb,                             -- Jev の応答と計算済みの通じ度など
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, turn_no)
);

CREATE TABLE picks (
  id          bigserial PRIMARY KEY,
  turn_id     bigint NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  seq         smallint NOT NULL,
  picked_by   char(1) NOT NULL CHECK (picked_by IN ('A','B')),
  cell_idx    smallint NOT NULL,
  result      text NOT NULL CHECK (result IN ('green','assassin','bystander')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_id, seq)
);

CREATE TABLE words (
  id          serial PRIMARY KEY,
  word        text NOT NULL UNIQUE,
  inside_joke boolean NOT NULL DEFAULT false     -- 身内ネタの単語
);
