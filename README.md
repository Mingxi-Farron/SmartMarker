# Teacher AI 助手 MVP（阿里云 Ubuntu 24.04 + Mac Local Agent）

面向中国老师的最小可运行版本，支持：
- 邀请码登录（`max_uses=1`）
- 教材图片上传 -> 异步 PPT Job -> 返回 `ppt_url`
- 成绩文件/图片 -> 异步 Grades Job -> 下载 `csv/xlsx`
- 云端 Main Agent + PPT Agent
- Mac Local Agent（首次邀请码注册，后续自动连接）

## 1. 项目结构

- `docker-compose.yml`：服务编排（`orchestrator` + 可选 `openclaw` + 可选 `nginx`）
- `orchestrator/`：后端 API、Web 聊天页面、异步任务、设备 WebSocket
- `local-agent-mac/`：Mac 本地执行器（`read_file/write_file/apply_patch`）
- `scripts/build-local-agent-dmg.sh`：生成 macOS DMG 安装包

## 2. 端口说明

- `8080`：`orchestrator` 对外端口（默认）
- `3000`：`openclaw` 端口（可选 profile）
- `80`：`nginx` 端口（可选 profile）

## 3. 环境变量

复制并编辑：

```bash
cp .env.example .env
```

关键变量：

- `PUBLIC_BASE_URL`：例如 `http://<服务器公网IP>:8080`
- `JWT_SECRET`：JWT 签名密钥
- `ADMIN_KEY`：创建邀请码接口的管理密钥
- `ALI_MODEL_ENDPOINT`
- `ALI_API_KEY`
- `ALI_VLM_MODEL`（默认 `qwen3.5-plus`）
- `ALI_DISABLE_THINKING`（默认 `true`，降低首 token 延迟）
- `ALI_REQUEST_TIMEOUT_MS`（默认 `30000`）
- `ALI_MAX_TOKENS`（默认 `1200`，可适当下调到 `700~1000` 提升速度）
- `PPT_SKILL`（默认 `ide-rea/ai-ppt-generator`）
- `OPENCLAW_BASE_URL`
- `OPENCLAW_API_KEY`
- `OPENCLAW_GATEWAY_TOKEN`（OpenClaw `/tools/invoke` 鉴权 token）
- `OPENCLAW_PPT_TOOL`（默认 `skills_run`）
- `OPENCLAW_PPT_TOOL_ARG_SKILL_KEY`（默认 `skill`）
- `MOCK_MODE=true`（无 key 时建议开启）

说明：
- 若未配置阿里模型 key/endpoint，系统会自动进入 mock（流程完整可跑通）。

## 4. 服务器启动（阿里云 Ubuntu 24.04）

```bash
docker compose up -d --build
```

访问：

- Web 页面：`http://<公网IP>:8080/`
- 健康检查：`http://<公网IP>:8080/health`

可选：
- 启动 OpenClaw：`docker compose --profile openclaw up -d`
- 启动 Nginx：`docker compose --profile nginx up -d`

## 5. 邀请码创建与登录

### 5.1 创建邀请码（管理员）

```bash
curl -X POST "http://<公网IP>:8080/admin/invites" \
  -H "x-admin-key: <ADMIN_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"code":"TEACHER-001","max_uses":1}'
```

### 5.2 用户兑换邀请码

```bash
curl -X POST "http://<公网IP>:8080/auth/invite/redeem" \
  -H "Content-Type: application/json" \
  -d '{"code":"TEACHER-001"}'
```

返回：`jwt`, `user_id`

## 6. API（MVP）

### Auth
- `POST /auth/invite/redeem`

### Device
- `POST /devices/register`
- `POST /devices/register-auth`（已登录用户注册本地设备）
- `GET /devices`
- `POST /devices/:device_id/commands`
- `GET /commands/:command_id`
  - `action`: `list_dir | read_file | write_file | apply_patch | delete_path`

### WebSocket
- `GET /ws/device?device_token=xxx`

### Upload
- `POST /upload/images`（multipart，字段名 `images`）

### PPT Job
- `POST /jobs/ppt`：`{ "upload_id": "...", "prompt": "可选，用户需求原文" }`
- `GET /jobs/:job_id`

PPT 状态机：
- `queued`
- `extracting_text`
- `outline_ready`
- `ppt_generating`
- `done`
- `failed`

### Grades Job
- `POST /jobs/grades`（multipart `file` 或 `images`，也支持 JSON 提交 `file_id/upload_id`）
- `GET /jobs/:job_id`

### Download
- `GET /download/:file_id`（需 Bearer JWT，或 `?token=<jwt>`）

### Chat Session 管理
- `DELETE /chat/messages/:message_id`
- `DELETE /chat/sessions/:session_id`
- `POST /chat/sessions/clear`：`{ "scope": "all" }`

## 7. 数据隔离

所有核心表都带 `user_id` 并在查询层强制校验：
- `messages`
- `jobs`
- `files`
- `devices`

禁止跨 `user_id` 查询。

## 8. Mac Local Agent 使用

### 8.1 开发运行（Desktop App）

```bash
cd local-agent-mac
npm install
npm run start
```

首次启动流程（窗口内完成）：
1. 输入 `Server URL`
2. 输入邀请码
3. 选择 `allowed_root`
4. 自动完成：
   - 邀请码登录（获取 `jwt + user_id`）
   - 以当前登录用户调用 `/devices/register-auth`
   - 保存 `device_token` 到 macOS Keychain（失败降级本地受限文件）
   - 建立 `/ws/device` 长连接

后续启动：
- 自动恢复会话与设备连接，无需再次输入邀请码
- 若仅需重选授权目录，可在已登录状态下直接重配（邀请码可留空）

本地安全规则：
- 仅允许访问 `allowed_root` 及其子目录
- 拒绝路径穿越
- Desktop 版日志：`~/Library/Logs/teacher-ai-desktop.log`
- CLI 版日志：`~/Library/Logs/teacher-ai-local-agent.log`

CLI 版本（可选）：

```bash
cd local-agent-mac
npm run start:cli
```

### 8.2 生成 DMG（给老师安装 Desktop App）

在 Mac 上执行：

```bash
./scripts/build-local-agent-dmg.sh
```

产物：
- `dist/smartmarker.dmg`

说明：
- 当前 DMG 为未签名/未公证版本，首次打开可能被 Gatekeeper 拦截。
- 生产环境建议补充 Apple Developer ID 签名与 notarization。

## 9. 关键实现说明

- Main Agent：意图识别（PPT/成绩/本地文件）并分发任务。
- PPT Agent：图片理解 -> 文本合并 -> 大纲 JSON -> 生成 PPT。
- ClawHub Skill：优先尝试 OpenClaw `/tools/invoke`（`skills_run`），兼容旧 `/skills/run`，失败自动本地增强模板 fallback 生成 `.pptx`。
- Mock 机制：无模型 key 时自动启用，保证全链路可演示。

## 10. 生产建议（下一步）

- 接入 Redis + 独立 Worker（当前为单进程轮询队列）
- 邀请码体系增加创建者、审计、撤销
- Local Agent 增加写前审批策略
- 增加对象存储（OSS）与 CDN 下载
- 增加 HTTPS（自有域名 + 证书）
