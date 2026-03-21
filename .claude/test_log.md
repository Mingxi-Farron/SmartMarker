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

## 2026-03-20 Quiz Agent UX Improvements

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | "查看确认题"返回格式化的低置信列表 | P0 | 完成一次批改，有低置信答案 | 列表含学生姓名、题号、学生答案、标准答案 | [ ] 待测 |
| 2 | 照片顺序提示在上传学生卷后显示 | P0 | 上传学生答卷照片 | 系统消息提示"按学生顺序排列" | [ ] 待测 |
| 3 | 引导文案含拍照建议和预估时间 | P1 | 发"批改过关单" | 回复含"拍照建议"、"预估时间"、"按顺序" | [ ] 待测 |
| 4 | 答案预览按页分组展示 | P1 | quiz_key 完成 | 预览按"第 X-Y 题（第 N 页）"分组 | [ ] 待测 |
| 5 | 修正后回显 old→new 详情 | P1 | 答案预览后输入"47:movable" | 回复含"mobile → movable ✅" | [ ] 待测 |
| 6 | 追加模式显示已有学生数 | P1 | 第一次批改完成后再追加 | 回复含"已有 N 人" | [ ] 待测 |
| 7 | 批改进度含时间估算 | P2 | 提交 10+ 份学生答卷 | 进度显示"约剩 X 秒" | [ ] 待测 |
| 8 | "使用之前的答案"列出历史答案列表 | P2 | 用户已创建过 answer key | 列出答案标题和日期，可选择编号 | [ ] 待测 |
| 9 | 选择历史答案后可直接开始批改 | P2 | 列出历史答案后回复编号 | answer_key_id 被设置，可上传学生卷 | [ ] 待测 |
| 10 | 引导文案提示"已有保存的答案" | P2 | 用户已创建过 answer key | 引导回复含"已有保存的答案" | [ ] 待测 |

## 2026-03-21 批量作文批改 Agent

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | 上传 5+ 作文照片 + "批量批改作文" 创建 essay_review job | P0 | 配置百炼 API key，准备学生作文照片 | Job 创建成功，进度更新显示"批改中 1/5"等 | [ ] 待测 |
| 2 | 批量批改完成后生成 Excel（3 sheet）可下载 | P0 | 完成一次批量批改 | Excel 含成绩总览、逐人反馈、常见错误统计 | [ ] 待测 |
| 3 | 单篇作文批改仍然同步返回文本（不走 job） | P0 | 上传 1 张作文照片 + "批改作文" | 即时返回评分+反馈文本，不创建 job | [ ] 待测 |
| 4 | "批改作文" + 2 张照片（同一篇多页）不触发批量模式 | P1 | 上传 2 张照片 + "批改作文"（无批量关键词） | 同步返回单篇批改结果 | [ ] 待测 |
| 5 | "批量批改作文，每篇2页" 正确提取 pages_per_essay | P1 | 上传 6 张照片 | 系统识别为 3 位学生，每篇 2 页 | [ ] 待测 |
| 6 | VLM 提取 student_name 显示在 Excel 中 | P1 | 作文照片顶部有学生姓名 | Excel 中姓名列非"学生1" | [ ] 待测 |
| 7 | 部分学生 VLM 失败不影响其余学生 | P1 | 混入 1 张模糊照片 | 其余学生正常出成绩，failed_students 列出失败项 | [ ] 待测 |
| 8 | Electron 前端 renderJobDone 正确展示 essay_review 结果 | P0 | Electron app 完成批量批改 | 显示摘要 + 下载链接 | [ ] 待测 |

## 2026-03-20 Quiz Agent 审计修复（regex 对齐 + context override + CSV 共享）

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | Web 端完整两步流程（mockMode 关闭）：说"开始批改" + 上传答卷 → 后端正确创建 quiz_grade job | P0 | 配置百炼 API key，完成答案提取 | "开始批改" 被后端 inferIntent 识别为 quiz_grade，不依赖 LLM planner | [ ] 待测 |
| 2 | mockMode 下说"没问题"能走通确认流程 | P0 | mockMode=true，完成 quiz_key job，前端显示"答案已识别" | 回复"答案已确认"，不掉入通用 chat | [ ] 待测 |
| 3 | mockMode 下输入"47:movable"能修正答案 | P0 | 同上 | 回复"已修正 1 题"，DB 中 correct_answer 已更新 | [ ] 待测 |
| 4 | quiz session 中说无关话题不被劫持到 quiz handler | P1 | context 中有 answer_key_id，但上条 assistant 消息不含"答案已识别" | 不返回 quiz_grade intent，正常走 chat 或其他 intent | [ ] 待测 |
| 5 | GradesAgent CSV 输出中含"=CMD()"的学生姓名被转义 | P1 | 创建含恶意姓名的成绩数据 | 下载 CSV 打开后，姓名列显示 '=CMD() 而非执行公式 | [ ] 待测 |
| 6 | local_file reroute 到 quiz_grade/ppt/grades 仍正常工作 | P1 | 发类似"打开过关单文件"的消息 | handleLocalFileIntent reroute 后二次 dispatch 正确处理 | [ ] 待测 |
