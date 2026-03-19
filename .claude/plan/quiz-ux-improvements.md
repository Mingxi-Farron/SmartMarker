# Implementation Plan: Quiz Agent UX Improvements (P0-P2)

## Overview
UX audit 发现的 10 项改进，全部实施。分 5 个 Phase。

## Phase 1: Backend handleQuizGradeIntent 文案/逻辑（Items 1,5,6,7）
- 1.1 P0: "查看确认题"实际返回低置信列表
- 1.2 P1: 修正后回显 old→new 详情 + 剩余低置信数
- 1.3 P1: 引导文案加拍照建议、预估时间、顺序提示
- 1.4 P1: 追加模式显示已有学生数

## Phase 2: Backend quiz-agent 进度和结果结构（Items 3,4,9）
- 2.1 P1: processAnswerKey 加进度更新
- 2.2 P1: questions_by_page 分页预览结构
- 2.3 P2: gradeStudentPapers 进度加时间估算

## Phase 3: Web SPA 前端（Items 2,4,8）
- 3.1 P0: 上传学生卷后加照片顺序提示
- 3.2 P1: 答案预览按页分组展示
- 3.3 P2: 上传答案后加质量提示

## Phase 4: Electron 前端镜像（Items 2,4,8）
- 4.1-4.3: 同 Phase 3

## Phase 5: 答案库历史复用（Item 10）
- 5.1 P2: "之前的答案"→列出历史答案
- 5.2 P2: 前端捕获选中的 answer_key_id
- 5.3 P2: 引导文案加"已有答案"提示
