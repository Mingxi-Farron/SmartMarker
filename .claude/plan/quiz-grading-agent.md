# Implementation Plan: Quiz/Checkpoint Grading Agent (Final v5)

## Overview

新增"过关单批改"Agent，支持教师上传标准答案照片和学生答卷照片，系统自动 OCR + 比对 + 生成 Excel 成绩报告。

---

## 0. Prerequisites（架构审计发现，开写前必须解决）

### P1: `chatCompletion` 加 per-call maxTokens 支持
- **问题**：当前 `chatCompletion({ messages, temperature })` 写死用 `this.maxTokens`（全局 1200），100 题输出需要 6000
- **改动**：加可选参数 `maxTokens`，有则用，无则走 `this.maxTokens`
- **影响范围**：model-client.js chatCompletion 方法，~2 行改动，现有调用不传此参数 → 零影响
- **文件**：`orchestrator/src/agents/model-client.js` line 548

### P2: `POST /chat` body 扩展 answer_key_id + quiz_result_id
- **问题**：前端无法把 quiz 状态传给后端。当前 `POST /chat` 只接受 `message, upload_id, file_id, session_id, device_id`
- **改动**：
  1. `index.js` POST /chat handler：从 body 解构 `answer_key_id, quiz_result_id`，透传到 MainAgent context
  2. `main.mjs` chat:send IPC handler：透传新字段
  3. `preload.mjs` sendChat bridge：透传新字段
- **影响范围**：3 处各加 1-2 行。现有调用不传这两个字段 → 值为 undefined → 零影响
- **文件**：`orchestrator/src/index.js` line 576, `local-agent-mac/desktop/main.mjs` line 767, `local-agent-mac/desktop/preload.mjs` line 15

---

## 1. Design Principles

### Pattern-Aligned 扩展
- `inferIntent()` 加 `quiz_grade` regex（和 ppt/grades/essay 同级）
- `handleChat()` 加 `quiz_grade` 分支（和其他 intent 平级插入）
- 前端 `detectIntent()` 加 quiz 分支
- `planMainAction()` 加 quiz_grade intent + prompt
- `takeQueuedJob()` 可加 quiz 分支（或 agent 自行覆盖状态）
- 不改现有 intent 的 regex、不改现有 job 处理流程、不改现有 DB 表

### VLM/OCR 策略：图文分离
和 PPT Agent 同 pattern：**图片只做 OCR（VLM），推理/比对在纯文本上做（代码）**。

```
阶段 1（VLM OCR）: 答卷照片 → VLM → 紧凑文本 "1:deep|2:able|3:Asia|..."
阶段 2（代码比对）: OCR 文本 vs answer key → ✓/✗
阶段 3（VLM 验证，可选）: 不匹配项（纯文本，无图）→ VLM 判断是否 OCR 误读
低置信题 → 标记给老师复核
```

好处：
- prompt 简洁（OCR 阶段不需要塞 100 题答案）
- 输出紧凑（~400 tokens vs ~5000 tokens JSON）
- 比对确定性（代码精确匹配，非 VLM 概率判断）
- 成本 ≈ ¥3 / 60人（vs 一步到位 ¥6）

### 交互模式：收集阶段零 VLM + 批改阶段批量处理
- 上传阶段：纯文件存储，零 VLM 调用
- 老师说"开始批改"→ 创建 1 个 job → worker 批量处理
- 支持增量追加（再上传 → 再来一个 job → 合并结果）

---

## 2. Typical Userflow & Prompt Mapping

### 首次使用引导（UX F1）

当 `quiz_grade` intent 被识别但 session context 中没有 answer_key_id 时，系统主动输出：
```
"批改过关单需要两步：
 1️⃣ 先上传标准答案的照片（我来识别正确答案）
 2️⃣ 再上传学生答卷的照片（我来逐题批改）
请先上传标准答案。"
```

### Phase A: Answer Key

| # | Teacher Input | Action |
|---|---|---|
| 1 | "这是标准答案" + photos | → upload → POST /jobs/quiz-key → poll → 返回答案预览（含低置信标记）→ 老师确认 |
| 2 | "上传答案" + photos | Same |
| 3 | photos only, no text | 现有行为："图片已收到，请说明用途" |

**答案预览交互（UX F3）**：
```
✅ 答案已识别，共 100 题（3 页）。

第 1-38 题（第 1 页）：
  1. deep  2. desert  3. Asia  4. feel free to  5. tourist ...

第 39-96 题（第 2 页）：
  39. be known for  40. process  41. pack ...

第 97-100 题（第 3 页）：
  97. not only...but also...  98. admire  99. professional  100. almost

⚠️ 以下 2 题识别可能有误，请重点检查：
  #47: 当前识别为 "mobile"（置信度低）
  #63: 当前识别为 "complete"（置信度低）

确认无误请说"没问题"。如需修正，输入如 "47:movable" 即可。
```

**答案确认路由机制（审计 G1/G2）**：
`handleQuizGradeIntent` 通过检查 session history 上下文判断当前消息意图：
- 最近一条 assistant 消息包含答案预览标记（如"答案已识别"）→ 当前消息视为确认/修正
- 消息匹配 `/^\d+[:：]\s*\S+/` 格式 → 解析为 answer key 修正命令
- "没问题"/"确认"/"ok" → 确认答案锁定
- 其他文字 → 正常 quiz_grade 意图处理

### Phase B: Student Grading

| # | Teacher Input | Action |
|---|---|---|
| 4 | [上传照片] | 存储，显示"已收到 N 张照片（约 X 份答卷）"（UX F2） |
| 5 | [继续上传] | 累计显示 |
| 6 | "开始批改" / "批改" | → POST /jobs/quiz-grade（含 context.answer_key_id）→ worker 处理 → Excel |
| 7 | [上传更多照片] + "批改" / "追加" | session 中已有 quiz_result → **默认追加**（UX F6） |

**收集阶段提示（UX F2）**：
- 前端从 `pendingAnswerKeys` Map 读取 `page_count`
- 显示："已收到 9 张照片（约 3 份答卷，本过关单每份 3 页）"
- 如果张数不是页数的整数倍："当前 10 张照片，不是 3 的整数倍，可能有遗漏。"

**增量追加自动判断（UX F6）**：
- 前端检查 `pendingQuizResults` Map：session 中已有 quiz_result_id → sendChat 时自动带上 `quiz_result_id`
- 后端 `handleQuizGradeIntent` 收到 `context.quiz_result_id` → 创建 job 带 `append_to_result_id`
- 只有老师明确说"重新批改"时才新建 result（前端不传 quiz_result_id）
- 追加完成后："已追加 3 位学生，现共 31 位。[下载更新后的 Excel]"

**批改进度显示（审计 G4）**：
- Quiz agent 通过 `db.updateJob({ jobId, status: 'processing', result: { progress: '批改中 12/28' } })` 更新进度
- 前端 `pollJob` 增加 `result.progress` 变化检测，变化时用 `upsertPending()` 更新 pending bubble 文本
- 不新增 status 值，复用 `processing`

### Phase C: Results

**完成摘要（UX F5）**：
```
✅ 批改完成！共 28 位学生

📊 班级概况：平均 76.2% | 最高 98% 张三 | 最低 52% 王五
📌 高频错题：#7 take a taxi（错误率 60%）、#11 See you then（50%）
⚠️ 3 道题需要你确认（OCR 不确定）
  回复"查看确认题"可逐条复核，或说"全部按系统判定"跳过。

[下载 Excel]
```

| # | Teacher Input | Action |
|---|---|---|
| 8 | "导出结果" | → 下载 Excel |
| 9 | "哪些学生第3题错了" | → 查询 quiz_result_answers（需 context.quiz_result_id）→ 文本回复 |
| 10 | "换一套答案" + photos | → 新 answer key，session state 覆盖 |
| 11 | "查看张三的结果" | → 输出可复制的单人反馈文本 |
| 12 | "查看确认题" / "查看需确认的题" | → 低置信复核交互（见下） |

**低置信复核交互（UX F4，纯文本方案，审计 B2 修正）**：

当前 UI 只支持纯文本气泡 + 下载链接按钮，不支持内联 action button。复核降级为文本数字交互：
```
⚠️ 以下答案 OCR 不太确定，请确认：

1. 张三 #47: OCR 读到 "achive" → 正确答案 "achieve"
2. 李四 #63: OCR 读到 "seperate" → 正确答案 "separate"
3. 王五 #91: OCR 读到 "goverment" → 正确答案 "government"

回复题号表示"其实写对了"（如 "1 3"），或说"全部错"/"跳过"。
```

老师回复 "1 3" → `handleQuizGradeIntent` 通过 session history 识别上下文（上条消息是复核列表）→ 解析数字 → 更新 quiz_result_answers → 重新生成 Excel。

### Ambiguity Resolution
- Session context 中无 answer_key_id → 图片当答案
- Session context 中有 answer_key_id → 图片当学生答卷
- Session context 中有 quiz_result_id + 新上传 → 默认追加（UX F6）
- 显式覆盖："这是答案" / "这是学生的" / "重新批改"

---

## 3. Excel Output（4 Sheet）

### Sheet 1: 成绩总览
| 姓名 | 学号 | 班级 | 正确 | 错误 | 未识别 | 得分率 | 排名 |

### Sheet 2: 逐题矩阵
| 姓名 | Q1 | Q2 | Q3 | ... | Q100 |
错题格子显示学生的错误答案，对的显示 ✓

### Sheet 3: 错题统计 + 知识点
| 题号 | 正确答案 | 知识点 | 错误率 | 常见错误（出现次数） |
按知识点汇总：| 知识点 | 涉及题数 | 全班平均正确率 |

### Sheet 4: 逐人反馈卡
每个学生一段，可复制发家长：
```
张三（240301）- 得分：92/100（92%）
错题：
  #3  你的答案：recieve    正确：receive
  #27 你的答案：walk in     正确：walk into
```

---

## 4. VLM Method Design

所有方法通过 `chatCompletion({ ..., maxTokens })` 传递 per-call maxTokens（依赖 Prerequisite P1）。

### `extractAnswerKeyFromImages({ imagePaths, hintText })`
- 输入：答案照片
- Prompt："读出每题的正确答案，输出 JSON"
- 输出：`{ page_count, questions: [{ number, correct_answer, knowledge_tag, confidence }] }`
- 同时推断知识点标签（零额外成本，同一次调用）
- 每题附带 confidence 字段（UX F3）
- `page_count` 用于前端粗估学生份数（UX F2，审计 G3）
- maxTokens: 6000

### `ocrStudentAnswers({ imagePaths })`
- 输入：一个学生的答卷照片（1-3 张）
- Prompt："逐题读出学生手写的英文答案，紧凑格式输出"
- 输出：`"张三|240301|1:deep|2:able|3:Asia|...|100:almost"`
- maxTokens: 2000（紧凑格式）
- **不传答案，纯 OCR**

### `verifyOcrMismatches({ pairs })`
- 输入：不匹配项的纯文本（无图片）
- Prompt："以下 OCR 结果和正确答案不匹配，判断是否 OCR 误读"
- 输出：每项的判定 + confidence
- maxTokens: 1000
- 仅对阶段 2 不匹配的题调用，每学生 0-1 次

---

## 5. Database Schema（Via runMigrations）

### answer_keys
id, user_id, title, page_count, source_job_id, created_at, updated_at
- FK: user_id → users(id)
- Index: (user_id, created_at)
- `page_count` 存 answer key 照片页数，用于前端粗估学生份数

### answer_key_questions
id, answer_key_id, question_number, correct_answer, knowledge_tag, confidence, created_at
- FK: answer_key_id → answer_keys(id) ON DELETE CASCADE
- Index: (answer_key_id, question_number)

### quiz_results
id, user_id, answer_key_id, source_job_id, student_count, created_at, updated_at
- FK: user_id → users(id), answer_key_id → answer_keys(id)
- Index: (user_id, created_at)

### quiz_result_answers
id, result_id, student_name, student_id_number, question_number, student_answer, is_correct, confidence, created_at
- FK: result_id → quiz_results(id) ON DELETE CASCADE
- Index: (result_id, student_name, question_number)

---

## 6. Backend Changes

### New: quiz-agent.js
- Constructor: `{ db, storage, modelClient, publicBaseUrl }`
- `run(job)`: dispatch quiz_key → processAnswerKey(), quiz_grade → gradeStudentPapers()
- `processAnswerKey()`: VLM extract → save answer_keys + questions（含 confidence, page_count）→ done
  - job result 包含：`{ answer_key_id, page_count, question_count, questions_preview, low_confidence_questions }`
- `gradeStudentPapers()`:
  1. 按学生分组照片（OCR 提取姓名/学号来分组）
  2. 每学生: ocrStudentAnswers() → 本地比对 → 可选 verifyOcrMismatches()
  3. 保存 quiz_results + quiz_result_answers
  4. 生成 4-sheet Excel + CSV
  5. 进度更新：`db.updateJob({ status: 'processing', result: { progress: '批改中 12/28' } })`
  6. **部分成功处理（UX F7）**：单学生 OCR 失败 → 跳过，继续其余。Job 最终 status = `done`（不用 `partial_done`，审计 B3 修正），result 中标记失败项。
- 支持 `input.append_to_result_id`（增量追加）
- **完成 result**：
  ```
  {
    result_id,
    summary: { student_count, average, max_student, min_student, high_error_questions },
    low_confidence_items: [{ student_name, question_number, student_answer, correct_answer }],
    failed_students: [{ photo_index, reason }],
    partial: true/false,       // 是否有失败学生
    csv_download_url,
    xlsx_download_url
  }
  ```

### Modified: model-client.js
- `chatCompletion` 加可选 `maxTokens` 参数（Prerequisite P1）
- validIntents 加 `'quiz_grade'`
- planMainAction prompt 加 quiz_grade 描述 + quiz_role 字段
- 新增 3 个方法（见 §4）

### Modified: main-agent.js
- `inferIntent()` 加 quiz_grade regex（在 grades 之前）：
  ```js
  if (/(过关单|过关|批改过关|标准答案|答案录入|答题卡|批改试卷)/.test(text)) {
    return 'quiz_grade';
  }
  ```
  不与现有 grades regex（`成绩|分数|平均分|csv|xlsx`）冲突（审计 G7）
- 新增 `handleQuizGradeIntent({ userId, message, context, history, sessionId })`
  - 无 context.answer_key_id 且无 upload → **首次引导文案**（UX F1）
  - 有 upload + 无 answer_key_id → 创建 quiz_key job（答案提取）
  - 有 upload + 有 answer_key_id → 创建 quiz_grade job（批改）
  - 有 context.quiz_result_id + 有 upload → 创建 quiz_grade job with append_to_result_id（追加）
  - 无 upload + 有 quiz_result_id → 查询/复核模式
  - **Session history 上下文检测**（审计 G1/G2）：
    - 上条 assistant 消息含"答案已识别" → 当前消息 = 确认/修正
    - 消息匹配 `/^\d+[:：]\s*\S+/` → answer key 修正
    - 上条消息含"需要你确认" + 消息匹配 `/^\d[\d\s]*$/` → 复核判定
- `handleChat()` 加 quiz_grade 分支（和其他 intent 平级）

### Modified: worker.js
- Constructor 加 quizAgent
- tick() 加 quiz_key / quiz_grade dispatch

### Modified: index.js
- Import + instantiate QuizAgent
- Pass to worker
- `POST /chat` handler 扩展 context（Prerequisite P2）：
  ```js
  context: { upload_id, file_id, device_id, answer_key_id, quiz_result_id }
  ```
- 注册 5 个新 endpoint

---

## 7. API Endpoints

| Method | Path | Behavior |
|--------|------|----------|
| POST | `/jobs/quiz-key` | Answer key extraction job（JSON: { upload_id, hint_text }） |
| POST | `/jobs/quiz-grade` | Student grading job（JSON: { upload_id, answer_key_id, append_to_result_id }） |
| GET | `/answer-keys` | List user's answer keys |
| GET | `/answer-keys/:id` | Get key with questions |
| DELETE | `/answer-keys/:id` | Delete (CASCADE) |

REST endpoints 和 chat-driven 流程并存（审计 G5）：chat 是主入口，REST 供 programmatic 调用。Chat 流程内部直接调 `db.createJob`，不经过 REST endpoint。

---

## 8. Frontend Changes (app.js)

All additive:
- `detectIntent()` 加 quiz 关键词分支
- state 加 `pendingAnswerKeys: new Map()` + `pendingQuizResults: new Map()`
  - pendingAnswerKeys 值：`{ answer_key_id, page_count, question_count }`
  - pendingQuizResults 值：`{ result_id, job_id }`
  - **清理策略（审计 G8）**：persistCaches 时只保留最近 20 条，evict 不在 session 列表中的条目
- `sendMessage()` 加 quiz_answer_key / quiz_grade_papers 分支
  - quiz_grade_papers：从 pendingAnswerKeys 读 answer_key_id，从 pendingQuizResults 读 quiz_result_id，透传到 sendChat（依赖 Prerequisite P2）
- `pollJob()` 增强：
  - quiz_key done：提取 answer_key_id + page_count + low_confidence_questions → 存入 pendingAnswerKeys → 显示答案预览
  - quiz_grade done：显示丰富摘要 + 低置信入口 + 失败学生提示 → 存入 pendingQuizResults
  - **progress 变化检测（审计 G4）**：如果 `job.result?.progress` 与上次不同，调用 `upsertPending(progress)` 更新 pending bubble
- **收集阶段照片计数提示**（UX F2）：从 pendingAnswerKeys 读 page_count，显示 `张数 ÷ page_count` 粗估
- Session state 持久化到 localStorage（cache key: `teacher-ai-quiz-keys-v1`, `teacher-ai-quiz-results-v1`）

---

## 9. Batch/Incremental Modes

| Condition | Mode |
|---|---|
| context 无 quiz_result_id | Batch（新建 result） |
| context 有 quiz_result_id + 老师说"批改"/"追加" | **Incremental（自动追加）**（UX F6） |
| context 有 quiz_result_id + 老师说"重新批改" | Batch（前端清除 pendingQuizResults → 不传 quiz_result_id） |

---

## 10. Error Handling（UX F7）

### 部分成功策略
- 单个学生 OCR 失败 → 跳过，继续其余学生
- Job 最终 status = `done`（**不使用 `partial_done`**，审计 B3 修正），result 中 `partial: true` + `failed_students` 列表
- 前端 pollJob 的 `done` handler 检查 `result.partial`：
  ```
  ✅ 28 位学生批改完成
  ⚠️ 2 位学生识别失败：
    - 第 15 张照片：无法识别学生姓名（照片可能模糊）
    - 第 22 张照片：只识别到 38 题（可能只拍了第 1 页）
  [下载已完成的 28 人结果]
  ```
- 已成功的结果永远保留，不因个别失败回滚

---

## 11. Implementation Phases

```
Phase 0 (Prerequisites) ── P1: chatCompletion maxTokens + P2: POST /chat 扩展
       │
Phase 1 (DB) ─────┐
                   ├── Phase 3 (Quiz Agent) ── Phase 4 (Wiring) ── Phase 5 (Main Agent) ── Phase 6 (Frontend)
Phase 2 (VLM) ────┘
```

| Phase | Files | Deliverable | Risk |
|-------|-------|-------------|------|
| 0 | model-client.js, index.js, main.mjs, preload.mjs | chatCompletion maxTokens + chat body 扩展 | Low |
| 1 | db.js | 4 new tables + CRUD methods | Low |
| 2 | model-client.js | 3 new VLM methods + quiz_grade intent | Medium |
| 3 | quiz-agent.js (new) | Core grading logic + Excel export | High |
| 4 | worker.js + index.js | Job dispatch + 5 REST endpoints | Low |
| 5 | main-agent.js | Intent regex + handleQuizGradeIntent + handleChat dispatch | Medium |
| 6 | app.js + main.mjs + preload.mjs | Frontend quiz flow + session state | Medium |

---

## 12. Risks

| Risk | Level | Mitigation |
|------|-------|------------|
| 手写英文 OCR 准确率 | HIGH | 图文分离 + 二次验证 + 老师纯文本复核（UX F4） |
| 学生姓名/学号识别 | HIGH | confidence 标记 + "未识别"fallback |
| 100 题输出 token 上限 | MEDIUM | 紧凑格式 + per-call maxTokens 6000（P1） |
| Worker 单锁阻塞 | MEDIUM | 已知限制，MVP 不解决 |
| 现有功能回归 | LOW | Pattern-aligned 扩展 |
| 首次用户不知道两步流程 | LOW | 首次引导文案（UX F1） |
| 确认/修正消息路由 | LOW | Session history 上下文检测（G1/G2） |

---

## 13. Cost Estimate

| Item | Cost |
|------|------|
| Answer key extraction | ¥0.06 (1-2 calls) |
| Student OCR (60 人) | ¥2.5 (60 calls) |
| Mismatch verification | ¥0.3 (60 calls, text only) |
| **Total per batch** | **≈ ¥3** |

---

## 14. Architecture Audit Resolution

### Blockers（已解决）

| # | Blocker | Resolution | Where |
|---|---------|------------|-------|
| B1 | chatCompletion 无 per-call maxTokens | 加可选参数 | §0 P1, §4 |
| B2 | UI 无 action button | 降级为纯文本数字回复 | §2 Phase C 低置信复核 |
| B3 | pollJob 不认识 partial_done | 不用 partial_done，用 done + result.partial | §10 |
| B4 | 前端无法传 answer_key_id/quiz_result_id | 扩展 POST /chat body | §0 P2, §6, §8 |

### Gaps（已明确）

| # | Gap | Resolution | Where |
|---|-----|------------|-------|
| G1 | 答案确认路由 | Session history 上下文检测 | §2 Phase A 路由机制 |
| G2 | "47:movable" 修正路由 | Regex + history 上下文 | §2 Phase A 路由机制 |
| G3 | 前端需要 page_count | quiz_key job result 含 page_count | §4 extractAnswerKey, §5 schema, §8 |
| G4 | 批改进度显示 | result.progress 字段 + pollJob upsertPending | §2 Phase B, §6, §8 |
| G5 | REST vs chat-driven | 并存，chat 为主入口 | §7 |
| G6 | 查询 vs 批改区分 | 检查 upload_id 和 quiz_result_id 组合 | §6 handleQuizGradeIntent |
| G7 | inferIntent regex 定义 | 明确的关键词列表，不与 grades 冲突 | §6 |
| G8 | localStorage 清理 | 保留最近 20 条，evict 过期 session | §8 |

---

## 15. UX Audit Findings（已合并）

| # | Finding | Where Addressed | Priority |
|---|---------|-----------------|----------|
| F1 | 首次使用无引导 | §2 首次使用引导 + §6 handleQuizGradeIntent | P0 |
| F2 | "N张照片"无意义，应粗估学生数 | §2 Phase B + §4 page_count + §5 schema + §8 | P0 |
| F3 | 答案预览缺少低置信标记 | §2 Phase A + §4 confidence + §5 schema | P1 |
| F4 | 低置信复核无具体交互 | §2 Phase C 纯文本方案（B2 修正）+ §6 | P1 |
| F5 | 完成摘要太简略 | §2 Phase C + §6 result structure | P1 |
| F6 | 追加 vs 新建应自动判断 | §2 Phase B + §8 pendingQuizResults + §0 P2 | P1 |
| F7 | 部分失败不应全部重来 | §10 + §6 partial flag（B3 修正） | P1 |
