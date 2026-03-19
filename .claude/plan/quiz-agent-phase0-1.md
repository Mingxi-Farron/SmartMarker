# Implementation Plan: Quiz Agent Phase 0 (Prerequisites) + Phase 1 (Database)

## Overview

为 Quiz Grading Agent 奠定基础：(1) VLM 客户端支持 per-call maxTokens，(2) chat 管道透传 quiz 上下文字段，(3) 创建四张新表 + CRUD 方法。

---

## Phase 0: Prerequisites

### Step 1: chatCompletion 加 per-call maxTokens

**文件**: `orchestrator/src/agents/model-client.js` line 548

- 方法签名：`async chatCompletion({ messages, temperature = 0.2 })` → 加 `maxTokens` 可选参数
- line 553：`max_tokens: this.maxTokens` → `max_tokens: maxTokens != null ? clampNumber(maxTokens, this.maxTokens, { min: 128, max: 8192 }) : this.maxTokens`
- 影响：零（现有调用不传 maxTokens → undefined → 走 fallback）
- 风险：Low

### Step 2: POST /chat handler 扩展

**文件**: `orchestrator/src/index.js` line 576

- 解构加 `answer_key_id, quiz_result_id`
- context 对象加这两个字段（line 599-603）
- 影响：零（不传时为 undefined）
- 风险：Low

### Step 3: Electron IPC 透传 -- main.mjs

**文件**: `local-agent-mac/desktop/main.mjs` line 778-784

- body 对象加：`answer_key_id: payload?.answer_key_id || null, quiz_result_id: payload?.quiz_result_id || null`
- 依赖：Step 2
- 风险：Low

### Step 4: preload.mjs 验证（无需改动）

**文件**: `local-agent-mac/desktop/preload.mjs` line 15

- `sendChat: (payload) => ipcRenderer.invoke('chat:send', payload)` 已是 passthrough
- 无需改动，仅验证确认

---

## Phase 1: Database Schema + CRUD

### Step 5: 四张新表 DDL

**文件**: `orchestrator/src/db.js` line 155 (runMigrations 内)

在 `backfillLegacySessions()` 之前追加：

```sql
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

CREATE INDEX IF NOT EXISTS idx_answer_keys_user ON answer_keys(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_answer_key_questions_key ON answer_key_questions(answer_key_id, question_number);
CREATE INDEX IF NOT EXISTS idx_quiz_results_user ON quiz_results(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_quiz_result_answers_result ON quiz_result_answers(result_id, student_name, question_number);
```

- 全部 `IF NOT EXISTS`，幂等安全
- 风险：Low

### Step 6: answer_keys CRUD

5 个方法：
1. `createAnswerKey({ userId, title, pageCount, sourceJobId })` → 返回 id
2. `getAnswerKeyForUser({ userId, answerKeyId })` → row 或 null
3. `listAnswerKeysForUser({ userId, limit })` → 数组
4. `updateAnswerKey({ answerKeyId, title, pageCount })` → 选择性更新
5. `deleteAnswerKeyForUser({ userId, answerKeyId })` → CASCADE 删除

### Step 7: answer_key_questions CRUD

4 个方法：
1. `bulkInsertAnswerKeyQuestions({ answerKeyId, questions })` → 事务批量插入
2. `listQuestionsForAnswerKey({ answerKeyId })` → 按 question_number 排序
3. `updateAnswerKeyQuestion({ questionId, correctAnswer, knowledgeTag, confidence })` → 单题修正
4. `getAnswerKeyWithQuestions({ userId, answerKeyId })` → 合并查询

### Step 8: quiz_results CRUD

5 个方法：
1. `createQuizResult({ userId, answerKeyId, sourceJobId })` → 返回 id
2. `getQuizResultForUser({ userId, resultId })` → row 或 null
3. `updateQuizResult({ resultId, studentCount })` → 更新计数
4. `listQuizResultsForUser({ userId, limit })` → 数组
5. `deleteQuizResultForUser({ userId, resultId })` → CASCADE 删除

### Step 9: quiz_result_answers CRUD

7 个方法：
1. `bulkInsertQuizResultAnswers({ resultId, answers })` → 事务批量插入 + 更新 parent student_count
2. `listAnswersForQuizResult({ resultId })` → 全部答案
3. `listAnswersForStudent({ resultId, studentName })` → 单学生
4. `updateQuizResultAnswer({ answerId, isCorrect, confidence })` → 复核修正
5. `getQuizResultSummary({ resultId })` → 聚合查询
6. `getHighErrorQuestions({ resultId, minErrorRate })` → 高频错题
7. `getLowConfidenceAnswers({ resultId, maxConfidence })` → 低置信答案

---

## 依赖关系

```
Step 1 (maxTokens) ──────────────────── 独立
Step 2 (index.js) ──────────────────── 独立
Step 3 (main.mjs) ── 依赖 Step 2
Step 4 (preload) ─── 验证 Step 3
Step 5 (DDL) ────────────────────────── 独立
Step 6 (answer_keys CRUD) ── 依赖 Step 5
Step 7 (questions CRUD) ──── 依赖 Step 5, 6
Step 8 (results CRUD) ────── 依赖 Step 5
Step 9 (answers CRUD) ────── 依赖 Step 5, 8
```

可并行：Step 1 / Step 2 / Step 5

---

## 测试策略

### Phase 0
- chatCompletion maxTokens：mock doChatRequest，验证 max_tokens 值
- POST /chat 扩展：发含 answer_key_id 的请求，验证到达 mainAgent context
- Electron IPC：验证 main.mjs 转发新字段

### Phase 1
- 表创建：`PRAGMA table_info()` 验证
- CRUD 冒烟测试：创建用户 → 插入 → 读取 → 更新 → 删除 → 验证 CASCADE
- 聚合查询：插入已知数据 → 验证计算结果
- 幂等迁移：两次 `new DB(sameDir)` 无报错

---

## 成功标准

- [ ] `chatCompletion({ maxTokens: 6000 })` → API payload `max_tokens: 6000`
- [ ] `chatCompletion({})` (无 maxTokens) → 不变行为
- [ ] POST /chat body 新字段透传到 mainAgent context
- [ ] Electron IPC 转发 answer_key_id / quiz_result_id
- [ ] 四张表存在
- [ ] 全部 CRUD 正常
- [ ] CASCADE 删除正常
- [ ] 聚合查询正确
- [ ] 现有功能无回归

---

## 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| 现有 chatCompletion 调用行为变化 | Low | maxTokens 默认 undefined → 走 fallback |
| FK 约束插入顺序 | Low | quiz agent 必须先创答案再创结果 |
| 6000 行 bulkInsert 性能 | Low | 单事务，SQLite 轻松承受 |
| 生产数据库 schema 变更 | Low | 全部 IF NOT EXISTS，不改现有表 |
