# Implementation Plan: Quiz Agent Phase 6 (Frontend)

## Overview

给 Web SPA (index.html) 和 Electron renderer (app.js) 加 quiz 批改的前端支持。

---

## Web SPA (index.html) — 11 步

### 状态管理
1. state 加 `pendingAnswerKeys` + `pendingQuizResults` Maps
2. localStorage cache keys
3. `persistQuizCaches()` + `hydrateQuizCaches()` helpers (20 条上限 eviction)
4. 页面加载时 hydrate

### Intent 检测
5. `detectIntent()` 加 quiz 分支（quiz_answer_key / quiz_grade_papers）

### API 调用
6. `callMainAgent()` 扩展 answer_key_id + quiz_result_id

### 发送消息
7. `sendMessage()` 加 `quiz_answer_key` 分支（上传答案照片 → quiz_key job）
8. `sendMessage()` 加 `quiz_grade_papers` 分支（上传学生卷 → quiz_grade job + 照片计数提示 UX F2）

### Job 轮询
9. `pollJob()` progress 变化检测（更新 pending bubble）
10. `renderJobDone()` quiz_key 处理（答案预览 + 低置信标记 UX F3）
11. `renderJobDone()` quiz_grade 处理（丰富摘要 + 下载链接 + 失败学生 UX F5/F7）

## Electron Renderer (app.js) — 12 步

12-17: 状态管理（Maps、cache、hydrate、cleanup）
18: `detectIntent()` 加 quiz 分支（用 activeSessionId 作 Map key）
19-20: `sendMessage()` quiz_answer_key + quiz_grade_papers 分支
21: `pollJob()` progress 检测 + `upsertPending()`
22-23: `pollJob()` quiz_key/quiz_grade done 处理

## Web vs Electron 差异

| 方面 | Web SPA | Electron |
|------|---------|----------|
| Map key | `'default'` | `state.activeSessionId` |
| 消息渲染 | `addBubble()` | `appendMessage()` |
| 进度显示 | DOM 直接更新 | `upsertPending()` |
| 文件上传 | File objects | filePaths |
| 发送 | `callMainAgent()` | `window.desktopApi.sendChat()` |

## 风险
- detectIntent regex 与 grades 冲突 → 放在 gradeHint 前，关键词无重叠
- pendingAnswerKeys 无限增长 → 20 条 eviction
- 后端 result 字段名不匹配 → 需对照 Phase 3 QuizAgent 输出验证
