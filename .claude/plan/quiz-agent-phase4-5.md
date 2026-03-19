# Implementation Plan: Quiz Agent Phase 4 (REST Endpoints) + Phase 5 (MainAgent Routing)

## Overview

Phase 4 加 5 个 REST endpoints。Phase 5 把 quiz_grade intent 接入 MainAgent 聊天路由。

---

## Phase 4: REST Endpoints (index.js)

### Step 1: POST /jobs/quiz-key
- 输入: `{ upload_id, hint_text }`，upload_id 必填
- 验证 upload 存在，创建 quiz_key 类型 job

### Step 2: POST /jobs/quiz-grade
- 输入: `{ upload_id, answer_key_id, append_to_result_id }`
- upload_id + answer_key_id 必填，append_to_result_id 可选
- 验证所有引用实体存在

### Step 3: GET /answer-keys
- 列出当前用户的 answer keys

### Step 4: GET /answer-keys/:id
- 返回 answer key + questions

### Step 5: DELETE /answer-keys/:id
- CASCADE 删除

---

## Phase 5: MainAgent Intent Routing (main-agent.js)

### Step 6: inferIntent 加 quiz_grade regex
- 关键词: `过关单|过关|批改过关|标准答案|答案录入|答题卡|批改试卷`
- 放在 grades regex 之前，无冲突

### Step 7: handleQuizGradeIntent 方法
6 个路由分支:
1. Session history: 答案确认/修正（"答案已识别" 上下文）
2. Session history: 低置信复核（"需要你确认" 上下文）
3. 无 upload + 无 answer_key_id → 首次引导 (UX F1)
4. 有 upload + 无 answer_key_id → 创建 quiz_key job
5. 有 upload + 有 answer_key_id → 创建 quiz_grade job（支持 append）
6. 无 upload + 有 quiz_result_id → 查询/复核模式

### Step 8+9: handleChat 双 pass 加 quiz_grade 分支
- 第一 pass（直接路由）和第二 pass（local_file 重路由）都加

### Step 10: handleLocalFileIntent reroute 白名单加 quiz_grade

---

## 测试计划
- Phase 4: 13 个 REST endpoint 测试
- Phase 5: 14 个 MainAgent 路由测试
- 总计 ~27 个新测试

## 风险
| 风险 | 等级 | 缓解 |
|------|------|------|
| Session history 误判 | MEDIUM | 同时检查 context ID 存在 |
| 修正 regex 误匹配 | LOW | 仅在确认上下文内启用 |
| REST/chat 重复创建 job | LOW | by design，独立 job |
