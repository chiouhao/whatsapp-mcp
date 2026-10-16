// Shared SQLite store. The bridge writes messages; the MCP server reads them
// and records tasks. Both processes open the same file.
import Database from 'better-sqlite3';

export function openDb(path = process.env.DB_PATH || './data/messages.db') {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid        TEXT PRIMARY KEY,
      name       TEXT,
      is_group   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT NOT NULL,
      chat_jid    TEXT NOT NULL REFERENCES chats(jid),
      sender      TEXT,
      sender_name TEXT,
      from_me     INTEGER NOT NULL DEFAULT 0,
      body        TEXT,
      timestamp   INTEGER NOT NULL,
      PRIMARY KEY (id, chat_jid)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source_jid   TEXT,
      source_msg   TEXT,
      title        TEXT NOT NULL,
      todoist_id   TEXT,
      status       TEXT NOT NULL DEFAULT 'open',
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return {
    raw: db,

    upsertChat({ jid, name, isGroup }) {
      db.prepare(`
        INSERT INTO chats (jid, name, is_group, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = COALESCE(excluded.name, chats.name),
          updated_at = excluded.updated_at
      `).run(jid, name ?? null, isGroup ? 1 : 0, Date.now());
    },

    insertMessage(m) {
      this.upsertChat({ jid: m.chatJid, name: m.chatName, isGroup: m.chatJid.endsWith('@g.us') });
      db.prepare(`
        INSERT OR IGNORE INTO messages
          (id, chat_jid, sender, sender_name, from_me, body, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(m.id, m.chatJid, m.sender ?? null, m.senderName ?? null,
             m.fromMe ? 1 : 0, m.body ?? null, m.timestamp);
    },

    listChats(limit = 30) {
      return db.prepare(`
        SELECT c.jid, c.name, c.is_group,
               (SELECT MAX(timestamp) FROM messages m WHERE m.chat_jid = c.jid) AS last_ts
        FROM chats c ORDER BY last_ts DESC NULLS LAST LIMIT ?
      `).all(limit);
    },

    getMessages({ chatJid, since, limit = 50 }) {
      return db.prepare(`
        SELECT id, chat_jid, sender_name, from_me, body, timestamp
        FROM messages
        WHERE chat_jid = ? AND timestamp >= ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(chatJid, since ?? 0, limit);
    },

    searchMessages({ query, limit = 25 }) {
      return db.prepare(`
        SELECT id, chat_jid, sender_name, from_me, body, timestamp
        FROM messages WHERE body LIKE ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(`%${query}%`, limit);
    },

    // Incoming messages from the last `hours` hours that you have not replied to
    // in the same chat (a reply here is any later message with from_me = 1).
    unanswered({ hours = 48, limit = 50 }) {
      const since = Date.now() - hours * 3600 * 1000;
      return db.prepare(`
        SELECT m.id, m.chat_jid, m.sender_name, m.body, m.timestamp
        FROM messages m
        WHERE m.from_me = 0 AND m.timestamp >= ?
          AND NOT EXISTS (
            SELECT 1 FROM messages r
            WHERE r.chat_jid = m.chat_jid AND r.from_me = 1 AND r.timestamp > m.timestamp
          )
        ORDER BY m.timestamp DESC LIMIT ?
      `).all(since, limit);
    },

    addTask({ sourceJid, sourceMsg, title, todoistId }) {
      const info = db.prepare(`
        INSERT INTO tasks (source_jid, source_msg, title, todoist_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sourceJid ?? null, sourceMsg ?? null, title, todoistId ?? null, Date.now());
      return info.lastInsertRowid;
    },

    getState(key) {
      return db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
    },

    setState(key, value) {
      db.prepare(`
        INSERT INTO sync_state (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    },
  };
}
