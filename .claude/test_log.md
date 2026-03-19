# Manual Test Log

## 2026-03-19 Quiz Agent Phase 0+1

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | POST /chat 传入 answer_key_id 后，MainAgent context 确实收到该字段 | P1 | 启动 orchestrator，创建用户和 answer_key | console.log 或 debugger 确认 context.answer_key_id 非 undefined | [ ] 待测 |
| 2 | POST /chat 传入不属于当前用户的 answer_key_id 返回 404 | P1 | 两个不同用户各自有 answer_key | 返回 `{ error: 'answer_key_id 不存在' }` | [ ] 待测 |
| 3 | Electron 桌面端 chat:send 透传 answer_key_id / quiz_result_id 到服务器 | P1 | 运行 Electron app 并连接到 orchestrator | 服务器端日志确认收到两个字段 | [ ] 待测 |
| 4 | 数据库重启后四张新表依然存在且数据完整 | P0 | 插入测试数据后重启 orchestrator | 重启后查询返回之前的数据 | [ ] 待测 |
| 5 | CASCADE 删除在真实 SQLite 文件上生效 | P1 | 创建 answer_key + questions，然后删除 answer_key | questions 表中对应行消失 | [ ] 待测 |

## 2026-03-19 Quiz Agent Phase 2+3

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | 真实 VLM 调用 extractAnswerKeyFromImages 返回正确 JSON | P0 | 配置阿里云 API key，准备标准答案照片 | 返回 page_count + questions 数组，每题有 confidence | [ ] 待测 |
| 2 | 真实 VLM 调用 ocrStudentAnswers 返回紧凑格式 | P0 | 准备学生手写答卷照片 | 返回 "姓名\|学号\|1:answer\|..." 格式 | [ ] 待测 |
| 3 | 手写英文 OCR 准确率在 80%+ | P0 | 准备 5 份不同笔迹的答卷 | 对比人工识别结果，正确率 ≥ 80% | [ ] 待测 |
| 4 | 60 学生批量批改完整流程 | P0 | 标准答案 + 60 份学生答卷照片 | Job 完成，生成 Excel 有 4 个 sheet，数据正确 | [ ] 待测 |
| 5 | Worker 正确分发 quiz_key/quiz_grade 任务 | P1 | 启动服务，创建 quiz_key 类型 job | Job 不被标记为 failed，QuizAgent.run 被调用 | [ ] 待测 |
| 6 | 生成的 Excel 在 WPS/Excel 中打开正常 | P1 | 完成一次批改流程 | 4 个 sheet 命名正确，数据显示正常，无乱码 | [ ] 待测 |
| 7 | 部分学生 OCR 失败时不影响已成功的 | P1 | 混入 1-2 张模糊照片 | 其余学生正常出成绩，failed_students 列出失败项 | [ ] 待测 |
| 8 | 增量追加模式 student_count 累加 | P1 | 先批改一批，再追加一批 | 第二次 result 的 student_count > 第一次 | [ ] 待测 |
| 9 | hintText prompt 注入防护 | P2 | 传入含指令的 hint_text | VLM 输出不受注入影响，仍返回正常 JSON | [ ] 待测 |
