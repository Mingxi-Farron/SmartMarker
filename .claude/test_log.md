# Manual Test Log

## 2026-03-19 Quiz Agent Phase 0+1

| # | 待测项 | 优先级 | 前置条件 | 通过标准 | 状态 |
|---|--------|--------|---------|---------|------|
| 1 | POST /chat 传入 answer_key_id 后，MainAgent context 确实收到该字段 | P1 | 启动 orchestrator，创建用户和 answer_key | console.log 或 debugger 确认 context.answer_key_id 非 undefined | [ ] 待测 |
| 2 | POST /chat 传入不属于当前用户的 answer_key_id 返回 404 | P1 | 两个不同用户各自有 answer_key | 返回 `{ error: 'answer_key_id 不存在' }` | [ ] 待测 |
| 3 | Electron 桌面端 chat:send 透传 answer_key_id / quiz_result_id 到服务器 | P1 | 运行 Electron app 并连接到 orchestrator | 服务器端日志确认收到两个字段 | [ ] 待测 |
| 4 | 数据库重启后四张新表依然存在且数据完整 | P0 | 插入测试数据后重启 orchestrator | 重启后查询返回之前的数据 | [ ] 待测 |
| 5 | CASCADE 删除在真实 SQLite 文件上生效 | P1 | 创建 answer_key + questions，然后删除 answer_key | questions 表中对应行消失 | [ ] 待测 |
