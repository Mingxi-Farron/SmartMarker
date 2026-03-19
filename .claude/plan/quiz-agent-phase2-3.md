# Implementation Plan: Quiz Agent Phase 2 (VLM Methods) + Phase 3 (Quiz Agent Core)

## Overview

Phase 2 给 ModelClient 加 3 个 VLM 方法 + 注册 quiz_grade intent。Phase 3 创建 QuizAgent，实现答案提取、逐学生 OCR 批改、代码比对、可选 VLM 验证、4-sheet Excel 生成。

---

## Phase 2: VLM Methods (model-client.js)

### Step 2.1: validIntents 加 quiz_grade
- line ~1154: `validIntents` Set 加 `'quiz_grade'`

### Step 2.2: planMainAction prompt 加 quiz_grade
- line ~1094-1095: intent 列表加 `"quiz_grade"`
- 加规则 5.5: `若用户要批改过关单/quiz/标准答案/答题卡 -> intent=quiz_grade`

### Step 2.3: extractAnswerKeyFromImages
- 签名: `async extractAnswerKeyFromImages({ imagePaths, hintText = '' })`
- 多模态调用 (text + images)，maxTokens: 6000，temperature: 0.1
- 输出: `{ page_count, questions: [{ number, correct_answer, knowledge_tag, confidence }] }`
- JSON 解析: parseJsonBlock → extractCodeBlocks → extractBalancedObjects 级联
- mockMode: 20 题 mock 数据，index 5 低置信

### Step 2.4: ocrStudentAnswers
- 签名: `async ocrStudentAnswers({ imagePaths })`
- 多模态调用，maxTokens: 2000，temperature: 0.1
- 输出: 紧凑文本 `"姓名|学号|1:answer|2:answer|..."`
- mockMode: 固定 mock 字符串

### Step 2.5: verifyOcrMismatches
- 签名: `async verifyOcrMismatches({ pairs })`
- 纯文本调用，maxTokens: 1000，temperature: 0.1
- 输出: `[{ question_number, student_answer, correct_answer, verdict, confidence }]`
- mockMode: 全部返回 `verdict: 'wrong'`

### Step 2.6: Phase 2 测试 (5 个)

---

## Phase 3: Quiz Agent Core (quiz-agent.js)

### Step 3.1: 类骨架 + constructor
- `{ db, storage, modelClient, publicBaseUrl }`
- `run(job)` → dispatch quiz_key / quiz_grade

### Step 3.2: processAnswerKey(job)
1. 获取 upload files
2. 调用 extractAnswerKeyFromImages
3. 创建 answer_key + bulk insert questions
4. 返回 `{ answer_key_id, page_count, question_count, questions_preview, low_confidence_questions }`

### Step 3.3: parseCompactOcr (纯函数)
- 解析 `"姓名|学号|1:answer|2:answer|..."` → `{ studentName, studentIdNumber, answers }`

### Step 3.4: compareAnswers (纯函数)
- 大小写不敏感精确匹配
- 返回 `{ results, mismatches }`
- `?` 标记为 definitively wrong (confidence 1.0)
- 其他不匹配项 confidence 0.5，加入 mismatches

### Step 3.5: groupPhotosByStudent (纯函数)
- 按 pageCount 分组连续照片

### Step 3.6: gradeStudentPapers(job) — 最复杂
1. 加载答案 + 上传文件
2. 创建/复用 quiz_result (支持 append_to_result_id)
3. 按 pageCount 分组照片
4. 逐学生: OCR → 解析 → 比对 → 可选验证 → 存 DB
5. 进度更新: `progress: '批改中 12/28'`
6. 生成 Excel + CSV
7. 部分成功: try/catch per student, failedStudents 列表

### Step 3.7: generateReport (Excel 4 sheets)
- Sheet 1: 成绩总览 (姓名/学号/正确/错误/未识别/得分率/排名)
- Sheet 2: 逐题矩阵 (姓名 vs Q1..Q100, ✓ 或错误答案)
- Sheet 3: 错题统计 + 知识点 (题号/正确答案/知识点/错误率/常见错误)
- Sheet 4: 逐人反馈卡 (可复制发家长)
- 同时生成 CSV (Sheet 1 内容)

### Step 3.8: Phase 3 测试 (16 个)
- 纯函数单元测试 (10 个)
- 集成测试 (6 个): 真实 DB + mockMode VLM

---

## 依赖关系

```
Phase 2:
  2.1 + 2.2 (intent) ─┐
  2.3 (extractAnswerKey)─┤
  2.4 (ocrStudentAnswers)├── 2.6 (tests)
  2.5 (verifyMismatches)─┘

Phase 3:
  3.1 (skeleton) ─┐
  3.3 (parser)    ├── 3.6 (gradeStudentPapers) ── 3.7 (report) ── 3.8 (tests)
  3.4 (compare)   │
  3.5 (grouping) ─┘
  3.2 (processAnswerKey) ── 3.8 (tests)

Cross-phase:
  2.3 → 3.2, 2.4 → 3.6, 2.5 → 3.6
```

---

## 风险评估

| 风险 | 等级 | 缓解 |
|------|------|------|
| VLM 返回 malformed JSON | HIGH | 多策略 JSON 解析级联 |
| OCR 紧凑格式变体 | MEDIUM | 兼容中英文冒号、多余空格 |
| 照片分组错误 | MEDIUM | 前端警告非整数倍 |
| verifyOcrMismatches 格式异常 | LOW | try/catch，回退到代码比对结果 |
| Excel 边界情况 (0 学生) | MEDIUM | 空数组保护 |
| 单学生 OCR 失败阻塞全批 | LOW | 已有 partial success 设计 |

---

## 成功标准

- [ ] 3 个 VLM 方法 mock/real 模式都返回正确结构
- [ ] planMainAction 接受 quiz_grade intent
- [ ] processAnswerKey 创建 answer_key + questions + job done
- [ ] gradeStudentPapers 批改多学生 + 存结果 + 生成 Excel/CSV
- [ ] 部分成功: 失败学生跳过并列出
- [ ] 增量追加模式正常
- [ ] 4-sheet Excel 正确命名
- [ ] 所有测试通过，覆盖率 ≥ 80%
