CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    telegram_username TEXT COLLATE NOCASE,
    nickname TEXT,
    alias TEXT UNIQUE COLLATE NOCASE,
    bio TEXT NOT NULL DEFAULT '',
    prompt TEXT,
    theme TEXT NOT NULL DEFAULT 'classic',
    active_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_telegram_username ON users(telegram_username);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('store_open','1'), ('rewards_open','1');

CREATE TABLE IF NOT EXISTS queue (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    joined_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL CHECK (mode IN ('ranked','private','practice')),
    status TEXT NOT NULL CHECK (status IN ('waiting','active','ended','cancelled')),
    owner_id INTEGER REFERENCES users(id),
    code TEXT UNIQUE,
    state TEXT,
    due_at INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS games_status_due ON games(status,due_at);
CREATE TABLE IF NOT EXISTS seats (
    game_id INTEGER NOT NULL REFERENCES games(id),
    seat INTEGER NOT NULL CHECK (seat BETWEEN 0 AND 3),
    user_id INTEGER REFERENCES users(id),
    telegram_message INTEGER,
    PRIMARY KEY (game_id,seat),
    UNIQUE(game_id,user_id)
);
CREATE INDEX IF NOT EXISTS seats_user ON seats(user_id,game_id);
CREATE TABLE IF NOT EXISTS invites (
    game_id INTEGER NOT NULL REFERENCES games(id),
    from_id INTEGER NOT NULL REFERENCES users(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(game_id,user_id)
);
CREATE INDEX IF NOT EXISTS invites_from ON invites(from_id,created_at);
CREATE TABLE IF NOT EXISTS results (
    game_id INTEGER NOT NULL REFERENCES games(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    won INTEGER NOT NULL CHECK(won IN (0,1)),
    ranked INTEGER NOT NULL CHECK(ranked IN (0,1)),
    finished_at INTEGER NOT NULL,
    day INTEGER NOT NULL,
    week INTEGER NOT NULL,
    month INTEGER NOT NULL,
    PRIMARY KEY (game_id,user_id)
);
CREATE INDEX IF NOT EXISTS results_user ON results(user_id,finished_at);
CREATE INDEX IF NOT EXISTS results_day ON results(ranked,day,user_id);
CREATE INDEX IF NOT EXISTS results_week ON results(ranked,week,user_id);
CREATE INDEX IF NOT EXISTS results_month ON results(ranked,month,user_id);

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    sku TEXT NOT NULL,
    stars INTEGER NOT NULL,
    status TEXT NOT NULL,
    checkout_id TEXT UNIQUE,
    primary_charge TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invoices_user ON invoices(user_id,created_at);
CREATE TABLE IF NOT EXISTS charges (
    id TEXT PRIMARY KEY,
    invoice_id TEXT REFERENCES invoices(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    payload TEXT NOT NULL,
    currency TEXT NOT NULL,
    total INTEGER NOT NULL,
    status TEXT NOT NULL,
    before_refund TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS charges_user ON charges(user_id,created_at);
CREATE TABLE IF NOT EXISTS rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period TEXT NOT NULL,
    period_start INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    cost INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    gift_id TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(period,period_start,rank)
);
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    reply TEXT,
    answered_at INTEGER
);
CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    answer TEXT
);
CREATE INDEX IF NOT EXISTS updates_created ON updates(created_at);
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route TEXT UNIQUE,
    kind TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL,
    lock_until INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    dead_at INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(dead_at,available_at,lock_until,id);
CREATE TABLE IF NOT EXISTS login_attempts (
    fingerprint TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    since INTEGER NOT NULL
);
