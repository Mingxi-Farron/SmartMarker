import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

function nowIso() {
  return new Date().toISOString();
}

function asJson(value) {
  if (value == null) {
    return null;
  }
  return JSON.stringify(value);
}

function fromJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class DB {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const dbPath = path.join(dataDir, 'orchestrator.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        user_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
      );

      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime TEXT,
        size INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS upload_items (
        id TEXT PRIMARY KEY,
        upload_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_name TEXT,
        device_platform TEXT,
        device_info_json TEXT,
        allowed_root TEXT,
        device_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS device_commands (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (device_id) REFERENCES devices(id)
      );

      CREATE TABLE IF NOT EXISTS answer_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        page_count INTEGER NOT NULL DEFAULT 0,
        source_job_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS answer_key_questions (
        id TEXT PRIMARY KEY,
        answer_key_id TEXT NOT NULL,
        question_number INTEGER NOT NULL,
        correct_answer TEXT NOT NULL DEFAULT '',
        knowledge_tag TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (answer_key_id) REFERENCES answer_keys(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS quiz_results (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        answer_key_id TEXT NOT NULL,
        source_job_id TEXT,
        student_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (answer_key_id) REFERENCES answer_keys(id)
      );

      CREATE TABLE IF NOT EXISTS quiz_result_answers (
        id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL,
        student_name TEXT NOT NULL DEFAULT '',
        student_id_number TEXT NOT NULL DEFAULT '',
        question_number INTEGER NOT NULL,
        student_answer TEXT NOT NULL DEFAULT '',
        is_correct INTEGER NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (result_id) REFERENCES quiz_results(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_last_message ON chat_sessions(user_id, last_message_at);
      CREATE INDEX IF NOT EXISTS idx_answer_keys_user ON answer_keys(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_answer_key_questions_key ON answer_key_questions(answer_key_id, question_number);
      CREATE INDEX IF NOT EXISTS idx_quiz_results_user ON quiz_results(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_quiz_result_answers_result ON quiz_result_answers(result_id, student_name, question_number);
    `);

    this.runMigrations();
  }

  runMigrations() {
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all();
    const hasSessionId = messageColumns.some((col) => col?.name === 'session_id');
    if (!hasSessionId) {
      this.db.prepare('ALTER TABLE messages ADD COLUMN session_id TEXT').run();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_message_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_user_session_created ON messages(user_id, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_last_message ON chat_sessions(user_id, last_message_at);
    `);

    this.backfillLegacySessions();
  }

  backfillLegacySessions() {
    const usersWithLegacyMessages = this.db
      .prepare(
        `
        SELECT user_id, MIN(created_at) AS first_message_at, MAX(created_at) AS last_message_at, COUNT(*) AS total
        FROM messages
        WHERE session_id IS NULL
        GROUP BY user_id
      `,
      )
      .all();

    if (!usersWithLegacyMessages.length) {
      return;
    }

    const txn = this.db.transaction((rows) => {
      for (const row of rows) {
        const userId = row.user_id;
        const firstAt = row.first_message_at || nowIso();
        const lastAt = row.last_message_at || firstAt;

        let session =
          this.db
            .prepare(
              'SELECT id FROM chat_sessions WHERE user_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1',
            )
            .get(userId, '历史会话') || null;

        if (!session) {
          const sessionId = randomUUID();
          this.db
            .prepare(
              'INSERT INTO chat_sessions(id, user_id, title, created_at, updated_at, last_message_at) VALUES(?, ?, ?, ?, ?, ?)',
            )
            .run(sessionId, userId, '历史会话', firstAt, lastAt, lastAt);
          session = { id: sessionId };
        }

        this.db
          .prepare('UPDATE messages SET session_id = ? WHERE user_id = ? AND session_id IS NULL')
          .run(session.id, userId);

        this.db
          .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ?')
          .run(lastAt, lastAt, session.id);
      }
    });

    txn(usersWithLegacyMessages);
  }

  ensureInvite({ code, maxUses = 1, expiresAt = null }) {
    const existing = this.db
      .prepare('SELECT code FROM invites WHERE code = ?')
      .get(code);
    if (existing) {
      return this.getInvite(code);
    }
    const createdAt = nowIso();
    this.db
      .prepare(
        'INSERT INTO invites(code, max_uses, used_count, expires_at, created_at) VALUES(?, ?, 0, ?, ?)',
      )
      .run(code, maxUses, expiresAt, createdAt);
    return this.getInvite(code);
  }

  getInvite(code) {
    return (
      this.db
        .prepare(
          'SELECT code, max_uses, used_count, expires_at, user_id, created_at FROM invites WHERE code = ?',
        )
        .get(code) || null
    );
  }

  redeemInvite(code) {
    const txn = this.db.transaction((inviteCode) => {
      const invite = this.getInvite(inviteCode);
      if (!invite) {
        throw new Error('邀请码不存在');
      }
      if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
        throw new Error('邀请码已过期');
      }

      if (invite.user_id) {
        return { user_id: invite.user_id, created: false };
      }

      if (invite.used_count >= invite.max_uses) {
        throw new Error('邀请码已用完');
      }

      const userId = randomUUID();
      const ts = nowIso();
      this.db.prepare('INSERT INTO users(id, created_at) VALUES(?, ?)').run(userId, ts);
      this.db
        .prepare('UPDATE invites SET used_count = used_count + 1, user_id = ? WHERE code = ?')
        .run(userId, inviteCode);
      return { user_id: userId, created: true };
    });

    return txn(code);
  }

  createChatSession({ userId, title = '新会话' }) {
    const id = randomUUID();
    const ts = nowIso();
    const safeTitle = String(title || '新会话').trim().slice(0, 120) || '新会话';
    this.db
      .prepare(
        'INSERT INTO chat_sessions(id, user_id, title, created_at, updated_at, last_message_at) VALUES(?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, safeTitle, ts, ts, ts);
    return this.getChatSessionForUser({ userId, sessionId: id });
  }

  getChatSessionForUser({ userId, sessionId }) {
    return (
      this.db
        .prepare(
          `
          SELECT id, user_id, title, created_at, updated_at, last_message_at
          FROM chat_sessions
          WHERE id = ? AND user_id = ?
        `,
        )
        .get(sessionId, userId) || null
    );
  }

  listChatSessionsForUser({ userId, limit = 100 }) {
    return this.db
      .prepare(
        `
        SELECT id, user_id, title, created_at, updated_at, last_message_at
        FROM chat_sessions
        WHERE user_id = ?
        ORDER BY last_message_at DESC, updated_at DESC
        LIMIT ?
      `,
      )
      .all(userId, Math.max(1, Number(limit || 100)));
  }

  listMessagesForSession({ userId, sessionId, limit = 300 }) {
    return this.db
      .prepare(
        `
        SELECT id, user_id, session_id, role, content, created_at
        FROM messages
        WHERE user_id = ? AND session_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `,
      )
      .all(userId, sessionId, Math.max(1, Number(limit || 300)));
  }

  getMessageForUser({ userId, messageId }) {
    return (
      this.db
        .prepare(
          `
          SELECT id, user_id, session_id, role, content, created_at
          FROM messages
          WHERE id = ? AND user_id = ?
        `,
        )
        .get(messageId, userId) || null
    );
  }

  getLatestMessageForSessionRole({ userId, sessionId, role }) {
    return (
      this.db
        .prepare(
          `
          SELECT id, user_id, session_id, role, content, created_at
          FROM messages
          WHERE user_id = ? AND session_id = ? AND role = ?
          ORDER BY created_at DESC
          LIMIT 1
        `,
        )
        .get(userId, sessionId, role) || null
    );
  }

  touchChatSession({ userId, sessionId, at = nowIso() }) {
    this.db
      .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ? AND user_id = ?')
      .run(at, at, sessionId, userId);
  }

  recomputeSessionLastMessageAt({ userId, sessionId }) {
    const session = this.getChatSessionForUser({ userId, sessionId });
    if (!session) {
      return null;
    }
    const latest = this.db
      .prepare(
        `
        SELECT created_at
        FROM messages
        WHERE user_id = ? AND session_id = ?
        ORDER BY created_at DESC
        LIMIT 1
      `,
      )
      .get(userId, sessionId);
    const nextTs = latest?.created_at || session.created_at || nowIso();
    this.db
      .prepare('UPDATE chat_sessions SET updated_at = ?, last_message_at = ? WHERE id = ? AND user_id = ?')
      .run(nextTs, nextTs, sessionId, userId);
    return this.getChatSessionForUser({ userId, sessionId });
  }

  createMessage({ userId, sessionId = null, role, content }) {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare('INSERT INTO messages(id, user_id, session_id, role, content, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, userId, sessionId, role, content, ts);
    if (sessionId) {
      this.touchChatSession({ userId, sessionId, at: ts });
    }
    return { id, created_at: ts, session_id: sessionId };
  }

  listRecentMessagesForSession({ userId, sessionId, limit = 12 }) {
    return this.db
      .prepare(
        `
        SELECT role, content, created_at
        FROM messages
        WHERE user_id = ? AND session_id = ? AND role IN ('user', 'assistant')
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(userId, sessionId, Math.max(1, Number(limit || 12)))
      .reverse();
  }

  deleteMessageForUser({ userId, messageId }) {
    const txn = this.db.transaction(() => {
      const target = this.getMessageForUser({ userId, messageId });
      if (!target) {
        return null;
      }
      this.db.prepare('DELETE FROM messages WHERE id = ? AND user_id = ?').run(messageId, userId);
      if (target.session_id) {
        this.recomputeSessionLastMessageAt({ userId, sessionId: target.session_id });
      }
      return target;
    });
    return txn();
  }

  deleteSessionForUser({ userId, sessionId }) {
    const txn = this.db.transaction(() => {
      const session = this.getChatSessionForUser({ userId, sessionId });
      if (!session) {
        return null;
      }
      const deletedMessages = this.db
        .prepare('DELETE FROM messages WHERE user_id = ? AND session_id = ?')
        .run(userId, sessionId).changes;
      this.db
        .prepare('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?')
        .run(sessionId, userId);
      return {
        session_id: sessionId,
        deleted_messages: deletedMessages,
      };
    });
    return txn();
  }

  clearAllSessionsForUser({ userId }) {
    const txn = this.db.transaction(() => {
      const deletedMessages = this.db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId).changes;
      const deletedSessions = this.db.prepare('DELETE FROM chat_sessions WHERE user_id = ?').run(userId).changes;
      return {
        deleted_messages: deletedMessages,
        deleted_sessions: deletedSessions,
      };
    });
    return txn();
  }

  createFile({ userId, kind, filename, mime, size, filePath }) {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO files(id, user_id, kind, filename, mime, size, path, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, kind, filename, mime || null, size, filePath, nowIso());
    return id;
  }

  getFileForUser({ userId, fileId }) {
    return (
      this.db
        .prepare(
          'SELECT id, user_id, kind, filename, mime, size, path, created_at FROM files WHERE id = ? AND user_id = ?',
        )
        .get(fileId, userId) || null
    );
  }

  createUpload({ userId, fileIds }) {
    const id = randomUUID();
    const ts = nowIso();
    const txn = this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO uploads(id, user_id, created_at) VALUES(?, ?, ?)')
        .run(id, userId, ts);
      for (const fileId of fileIds) {
        this.db
          .prepare('INSERT INTO upload_items(id, upload_id, file_id, created_at) VALUES(?, ?, ?, ?)')
          .run(randomUUID(), id, fileId, ts);
      }
    });
    txn();
    return id;
  }

  getUploadWithFiles({ userId, uploadId }) {
    const upload =
      this.db
        .prepare('SELECT id, user_id, created_at FROM uploads WHERE id = ? AND user_id = ?')
        .get(uploadId, userId) || null;
    if (!upload) {
      return null;
    }
    const files = this.db
      .prepare(
        `
        SELECT f.id, f.filename, f.mime, f.path, f.size
        FROM upload_items ui
        JOIN files f ON f.id = ui.file_id
        WHERE ui.upload_id = ? AND f.user_id = ?
        ORDER BY ui.created_at ASC
      `,
      )
      .all(uploadId, userId);
    return { upload, files };
  }

  createJob({ userId, type, input }) {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        'INSERT INTO jobs(id, user_id, type, status, input_json, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, type, 'queued', asJson(input), ts, ts);
    return id;
  }

  updateJob({ jobId, status, result = undefined, error = undefined }) {
    const existing = this.db.prepare('SELECT result_json, error FROM jobs WHERE id = ?').get(jobId);
    if (!existing) {
      return;
    }
    const nextResult = result === undefined ? existing.result_json : asJson(result);
    const nextError = error === undefined ? existing.error : error;
    this.db
      .prepare('UPDATE jobs SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?')
      .run(status, nextResult, nextError, nowIso(), jobId);
  }

  getJobForUser({ userId, jobId }) {
    const row = this.db
      .prepare(
        'SELECT id, user_id, type, status, input_json, result_json, error, created_at, updated_at FROM jobs WHERE id = ? AND user_id = ?',
      )
      .get(jobId, userId);
    if (!row) {
      return null;
    }
    return {
      ...row,
      input: fromJson(row.input_json, {}),
      result: fromJson(row.result_json, null)
    };
  }

  takeQueuedJob() {
    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `
          SELECT id, user_id, type, status, input_json
          FROM jobs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get();
      if (!row) {
        return null;
      }
      this.db
        .prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
        .run(row.type === 'ppt' ? 'extracting_text' : 'processing', nowIso(), row.id);
      return {
        ...row,
        input: fromJson(row.input_json, {})
      };
    });
    return txn();
  }

  listUserDevices(userId) {
    return this.db
      .prepare(
        'SELECT id, user_id, device_name, device_platform, allowed_root, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY created_at DESC',
      )
      .all(userId);
  }

  registerDevice({ userId, deviceInfo, allowedRoot = null, deviceToken }) {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO devices(id, user_id, device_name, device_platform, device_info_json, allowed_root, device_token, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        userId,
        deviceInfo?.name || null,
        deviceInfo?.platform || null,
        asJson(deviceInfo || {}),
        allowedRoot,
        deviceToken,
        nowIso(),
        nowIso(),
      );
    return id;
  }

  getDeviceByToken(deviceToken) {
    return (
      this.db
        .prepare(
          'SELECT id, user_id, device_name, device_platform, allowed_root, device_info_json, last_seen_at FROM devices WHERE device_token = ?',
        )
        .get(deviceToken) || null
    );
  }

  touchDevice(deviceId) {
    this.db
      .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(nowIso(), deviceId);
  }

  getDeviceForUser({ userId, deviceId }) {
    return (
      this.db
        .prepare(
          'SELECT id, user_id, device_name, device_platform, allowed_root, device_info_json, last_seen_at FROM devices WHERE id = ? AND user_id = ?',
        )
        .get(deviceId, userId) || null
    );
  }

  createDeviceCommand({ userId, deviceId, action, payload }) {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        'INSERT INTO device_commands(id, user_id, device_id, action, payload_json, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, deviceId, action, asJson(payload || {}), 'sent', ts, ts);
    return id;
  }

  finishDeviceCommand({ commandId, ok, result, error }) {
    this.db
      .prepare(
        'UPDATE device_commands SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE id = ?',
      )
      .run(ok ? 'done' : 'failed', asJson(result), error || null, nowIso(), commandId);
  }

  getDeviceCommandForUser({ userId, commandId }) {
    const row = this.db
      .prepare(
        'SELECT id, user_id, device_id, action, payload_json, status, result_json, error, created_at, updated_at FROM device_commands WHERE id = ? AND user_id = ?',
      )
      .get(commandId, userId);
    if (!row) {
      return null;
    }
    return {
      ...row,
      payload: fromJson(row.payload_json, {}),
      result: fromJson(row.result_json, null)
    };
  }

  // ─── answer_keys CRUD ───

  createAnswerKey({ userId, title = '', pageCount = 0, sourceJobId = null }) {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        'INSERT INTO answer_keys(id, user_id, title, page_count, source_job_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, userId, title, pageCount, sourceJobId, ts, ts);
    return id;
  }

  getAnswerKeyForUser({ userId, answerKeyId }) {
    return (
      this.db
        .prepare(
          'SELECT id, user_id, title, page_count, source_job_id, created_at, updated_at FROM answer_keys WHERE id = ? AND user_id = ?',
        )
        .get(answerKeyId, userId) || null
    );
  }

  listAnswerKeysForUser({ userId, limit = 50 }) {
    return this.db
      .prepare(
        'SELECT id, user_id, title, page_count, source_job_id, created_at, updated_at FROM answer_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(userId, limit);
  }

  updateAnswerKey({ userId, answerKeyId, title, pageCount }) {
    const existing = this.db
      .prepare('SELECT title, page_count FROM answer_keys WHERE id = ? AND user_id = ?')
      .get(answerKeyId, userId);
    if (!existing) {
      return null;
    }
    const nextTitle = title !== undefined ? title : existing.title;
    const nextPageCount = pageCount !== undefined ? pageCount : existing.page_count;
    this.db
      .prepare('UPDATE answer_keys SET title = ?, page_count = ?, updated_at = ? WHERE id = ?')
      .run(nextTitle, nextPageCount, nowIso(), answerKeyId);
  }

  deleteAnswerKeyForUser({ userId, answerKeyId }) {
    const existing = this.db
      .prepare('SELECT id FROM answer_keys WHERE id = ? AND user_id = ?')
      .get(answerKeyId, userId);
    if (!existing) {
      return null;
    }
    this.db.prepare('DELETE FROM answer_keys WHERE id = ?').run(answerKeyId);
    return { deleted: true };
  }

  // ─── answer_key_questions CRUD ───

  bulkInsertAnswerKeyQuestions({ answerKeyId, questions }) {
    if (!questions?.length) return;
    const insertStmt = this.db.prepare(
      'INSERT INTO answer_key_questions(id, answer_key_id, question_number, correct_answer, knowledge_tag, confidence, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    );
    const updateParent = this.db.prepare('UPDATE answer_keys SET updated_at = ? WHERE id = ?');
    const txn = this.db.transaction(() => {
      const ts = nowIso();
      for (const q of questions) {
        insertStmt.run(
          randomUUID(),
          answerKeyId,
          q.questionNumber,
          q.correctAnswer || '',
          q.knowledgeTag || '',
          q.confidence != null ? q.confidence : 1.0,
          ts,
        );
      }
      updateParent.run(ts, answerKeyId);
    });
    txn();
  }

  listQuestionsForAnswerKey({ answerKeyId }) {
    return this.db
      .prepare(
        'SELECT id, answer_key_id, question_number, correct_answer, knowledge_tag, confidence, created_at FROM answer_key_questions WHERE answer_key_id = ? ORDER BY question_number ASC',
      )
      .all(answerKeyId);
  }

  updateAnswerKeyQuestion({ userId, questionId, correctAnswer, knowledgeTag, confidence }) {
    const existing = this.db
      .prepare(
        `SELECT q.correct_answer, q.knowledge_tag, q.confidence
         FROM answer_key_questions q
         JOIN answer_keys ak ON ak.id = q.answer_key_id
         WHERE q.id = ? AND ak.user_id = ?`,
      )
      .get(questionId, userId);
    if (!existing) {
      return null;
    }
    const nextAnswer = correctAnswer !== undefined ? correctAnswer : existing.correct_answer;
    const nextTag = knowledgeTag !== undefined ? knowledgeTag : existing.knowledge_tag;
    const nextConf = confidence !== undefined ? confidence : existing.confidence;
    this.db
      .prepare('UPDATE answer_key_questions SET correct_answer = ?, knowledge_tag = ?, confidence = ? WHERE id = ?')
      .run(nextAnswer, nextTag, nextConf, questionId);
  }

  truncateAnswerKeyQuestions({ userId, answerKeyId, keepCount }) {
    const key = this.getAnswerKeyForUser({ userId, answerKeyId });
    if (!key) return 0;
    const result = this.db
      .prepare('DELETE FROM answer_key_questions WHERE answer_key_id = ? AND question_number > ?')
      .run(answerKeyId, keepCount);
    this.db.prepare('UPDATE answer_keys SET updated_at = ? WHERE id = ?').run(nowIso(), answerKeyId);
    return result.changes;
  }

  getAnswerKeyWithQuestions({ userId, answerKeyId }) {
    const answerKey = this.getAnswerKeyForUser({ userId, answerKeyId });
    if (!answerKey) {
      return null;
    }
    const questions = this.listQuestionsForAnswerKey({ answerKeyId });
    return { answerKey, questions };
  }

  // ─── quiz_results CRUD ───

  createQuizResult({ userId, answerKeyId, sourceJobId = null }) {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        'INSERT INTO quiz_results(id, user_id, answer_key_id, source_job_id, student_count, created_at, updated_at) VALUES(?, ?, ?, ?, 0, ?, ?)',
      )
      .run(id, userId, answerKeyId, sourceJobId, ts, ts);
    return id;
  }

  getQuizResultForUser({ userId, resultId }) {
    return (
      this.db
        .prepare(
          'SELECT id, user_id, answer_key_id, source_job_id, student_count, created_at, updated_at FROM quiz_results WHERE id = ? AND user_id = ?',
        )
        .get(resultId, userId) || null
    );
  }

  updateQuizResult({ userId, resultId, studentCount }) {
    const existing = this.db
      .prepare('SELECT id FROM quiz_results WHERE id = ? AND user_id = ?')
      .get(resultId, userId);
    if (!existing) {
      return null;
    }
    this.db
      .prepare('UPDATE quiz_results SET student_count = ?, updated_at = ? WHERE id = ?')
      .run(studentCount, nowIso(), resultId);
  }

  listQuizResultsForUser({ userId, limit = 50 }) {
    return this.db
      .prepare(
        'SELECT id, user_id, answer_key_id, source_job_id, student_count, created_at, updated_at FROM quiz_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(userId, limit);
  }

  deleteQuizResultForUser({ userId, resultId }) {
    const existing = this.db
      .prepare('SELECT id FROM quiz_results WHERE id = ? AND user_id = ?')
      .get(resultId, userId);
    if (!existing) {
      return null;
    }
    this.db.prepare('DELETE FROM quiz_results WHERE id = ?').run(resultId);
    return { deleted: true };
  }

  // ─── quiz_result_answers CRUD ───

  bulkInsertQuizResultAnswers({ resultId, answers }) {
    if (!answers?.length) return;
    const insertStmt = this.db.prepare(
      'INSERT INTO quiz_result_answers(id, result_id, student_name, student_id_number, question_number, student_answer, is_correct, confidence, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const txn = this.db.transaction(() => {
      const ts = nowIso();
      for (const a of answers) {
        insertStmt.run(
          randomUUID(),
          resultId,
          a.studentName || '',
          a.studentIdNumber || '',
          a.questionNumber,
          a.studentAnswer || '',
          a.isCorrect ? 1 : 0,
          a.confidence != null ? a.confidence : 1.0,
          ts,
        );
      }
      // Update parent student_count (use student_id_number when available, fall back to student_name)
      const countRow = this.db
        .prepare("SELECT COUNT(DISTINCT CASE WHEN student_id_number != '' THEN student_id_number ELSE student_name END) AS cnt FROM quiz_result_answers WHERE result_id = ?")
        .get(resultId);
      this.db
        .prepare('UPDATE quiz_results SET student_count = ?, updated_at = ? WHERE id = ?')
        .run(countRow.cnt, ts, resultId);
    });
    txn();
  }

  listAnswersForQuizResult({ resultId }) {
    return this.db
      .prepare(
        'SELECT id, result_id, student_name, student_id_number, question_number, student_answer, is_correct, confidence, created_at FROM quiz_result_answers WHERE result_id = ? ORDER BY student_name ASC, question_number ASC',
      )
      .all(resultId);
  }

  listAnswersForStudent({ resultId, studentName }) {
    return this.db
      .prepare(
        'SELECT id, result_id, student_name, student_id_number, question_number, student_answer, is_correct, confidence, created_at FROM quiz_result_answers WHERE result_id = ? AND student_name = ? ORDER BY question_number ASC',
      )
      .all(resultId, studentName);
  }

  updateQuizResultAnswer({ userId, answerId, isCorrect, confidence }) {
    const existing = this.db
      .prepare(
        `SELECT a.is_correct, a.confidence
         FROM quiz_result_answers a
         JOIN quiz_results qr ON qr.id = a.result_id
         WHERE a.id = ? AND qr.user_id = ?`,
      )
      .get(answerId, userId);
    if (!existing) {
      return null;
    }
    const nextCorrect = isCorrect !== undefined ? (isCorrect ? 1 : 0) : existing.is_correct;
    const nextConf = confidence !== undefined ? confidence : existing.confidence;
    this.db
      .prepare('UPDATE quiz_result_answers SET is_correct = ?, confidence = ? WHERE id = ?')
      .run(nextCorrect, nextConf, answerId);
  }

  getQuizResultSummary({ resultId }) {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(DISTINCT CASE WHEN student_id_number != '' THEN student_id_number ELSE student_name END) AS student_count,
          COUNT(DISTINCT question_number) AS question_count,
          ROUND(AVG(is_correct) * 100, 1) AS average_correct_rate
        FROM quiz_result_answers
        WHERE result_id = ?`,
      )
      .get(resultId);
    return {
      student_count: row?.student_count ?? 0,
      question_count: row?.question_count ?? 0,
      average_correct_rate: row?.average_correct_rate ?? null
    };
  }

  getHighErrorQuestions({ resultId, minErrorRate = 0.5 }) {
    return this.db
      .prepare(
        `SELECT
          question_number,
          ROUND((1.0 - AVG(is_correct)) * 100, 1) AS error_rate,
          COUNT(*) AS total_answers
        FROM quiz_result_answers
        WHERE result_id = ?
        GROUP BY question_number
        HAVING (1.0 - AVG(is_correct)) >= ?
        ORDER BY error_rate DESC`,
      )
      .all(resultId, minErrorRate);
  }

  getLowConfidenceAnswers({ resultId, maxConfidence = 0.5 }) {
    return this.db
      .prepare(
        'SELECT id, result_id, student_name, student_id_number, question_number, student_answer, is_correct, confidence, created_at FROM quiz_result_answers WHERE result_id = ? AND confidence <= ? ORDER BY confidence ASC',
      )
      .all(resultId, maxConfidence);
  }
}
