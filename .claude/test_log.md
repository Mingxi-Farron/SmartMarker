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

## 2026-03-20 Quiz Agent Phase 4+5

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | 聊天发"批改过关单"返回两步引导 | P0 | 启动 orchestrator，登录用户 | 收到引导文案，提示上传标准答案 | [ ] 待测 |
| 2 | 上传答案照片后发消息，自动创建 quiz_key job | P0 | 准备答案照片，先上传再发消息 | job 类型为 quiz_key，status 变为 processing | [ ] 待测 |
| 3 | quiz_key 完成后说"没问题"，确认答案 | P0 | quiz_key job 完成，前端展示答案预览 | 收到"答案已确认"回复 | [ ] 待测 |
| 4 | 答案修正 "47:movable" 实际修改 DB | P1 | quiz_key 完成，答案预览中有低置信题 | DB 中对应 question 的 correct_answer 更新 | [ ] 待测 |
| 5 | REST POST /jobs/quiz-key 创建 job | P1 | 有效 JWT + upload_id | 返回 job_id + status:queued | [ ] 待测 |
| 6 | REST POST /jobs/quiz-grade 创建 job | P1 | 有效 JWT + upload_id + answer_key_id | 返回 job_id + status:queued | [ ] 待测 |
| 7 | REST GET /answer-keys 列出用户答案 | P1 | 用户已创建 answer_key | 返回 answer_keys 数组 | [ ] 待测 |
| 8 | REST DELETE /answer-keys/:id 删除 + CASCADE | P1 | 用户有 answer_key + questions | 删除后 questions 也消失 | [ ] 待测 |
| 9 | planMainAction 返回 quiz_grade intent 后正确路由 | P1 | 发含 quiz 关键词的模糊消息 | LLM planner 返回 quiz_grade，handleChat 正确 dispatch | [ ] 待测 |
| 10 | local_file reroute 到 quiz_grade 正常工作 | P2 | 发类似"帮我批改过关单文件"的消息 | 先进入 local_file，reroute 到 quiz_grade | [ ] 待测 |

## 2026-03-20 Quiz Agent Phase 6 (Frontend)

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | Web SPA 完整流程：上传答案 → 预览 → 确认 → 上传学生卷 → 批改 → 下载 Excel | P0 | 启动 orchestrator + 配置 VLM API key + 准备照片 | 全流程无报错，Excel 可下载 | [ ] 待测 |
| 2 | Electron 桌面端完整流程同上 | P0 | 运行 Electron app 并连接到 orchestrator | 同 Web SPA 预期 | [ ] 待测 |
| 3 | 答案预览展示低置信题标记 | P0 | quiz_key 完成，有低置信题 | 预览消息中标出低置信题号和识别结果 | [ ] 待测 |
| 4 | 批改进度实时更新（"批改中 3/10"） | P1 | 提交 10 份学生答卷 | 聊天气泡文字从"处理中"变为"批改中 1/10"..."批改中 10/10" | [ ] 待测 |
| 5 | 照片计数提示（UX F2）显示估算学生数 | P1 | answer key page_count=3，上传 9 张照片 | 显示"约 3 份答卷，每份 3 页" | [ ] 待测 |
| 6 | 照片数非整数倍时显示警告 | P1 | page_count=3，上传 10 张照片 | 显示"不是 3 的整数倍，可能有遗漏" | [ ] 待测 |
| 7 | 批改完成摘要显示班级概况 + 高频错题 + 下载链接 | P1 | 完成一次批改 | 摘要含平均分、最高/最低、错题列表、Excel/CSV 下载按钮 | [ ] 待测 |
| 8 | 增量追加：第二次上传自动传 quiz_result_id | P1 | 第一次批改完成 | 第二次批改用追加模式，student_count 累加 | [ ] 待测 |
| 9 | Electron 端 quiz 状态在 session 切换后保留 | P1 | 切换到其他 session 再切回 | pendingAnswerKeys 仍在，可继续批改流程 | [ ] 待测 |
| 10 | detectIntent 不误判"成绩统计"为 quiz | P1 | 发"查看成绩"消息 | 路由到 grades 而非 quiz | [ ] 待测 |
| 11 | 部分失败学生在前端显示 | P2 | 混入模糊照片导致部分学生 OCR 失败 | 摘要中列出失败学生和原因 | [ ] 待测 |
