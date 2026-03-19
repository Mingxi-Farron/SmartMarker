import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';

import { config, resolveMockMode } from './config.js';
import { DB } from './db.js';
import { Storage } from './storage.js';
import { ModelClient } from './agents/model-client.js';
import { PptClient } from './agents/ppt-client.js';
import { PptAgent } from './agents/ppt-agent.js';
import { GradesAgent } from './agents/grades-agent.js';
import { MainAgent } from './agents/main-agent.js';
import { WeatherService } from './agents/weather-service.js';
import { QuizAgent } from './agents/quiz-agent.js';
import { JobWorker } from './jobs/worker.js';
import { DeviceHub } from './ws/device-hub.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true, bodyLimit: 40 * 1024 * 1024 });

const db = new DB(config.dataDir);
const storage = new Storage(config.dataDir);
const modelClient = new ModelClient({
  endpoint: config.aliModelEndpoint,
  apiKey: config.aliApiKey,
  model: config.aliVlmModel,
  disableThinking: config.aliDisableThinking,
  requestTimeoutMs: config.aliRequestTimeoutMs,
  maxTokens: config.aliMaxTokens,
  mockMode: resolveMockMode()
});
const pptClient = new PptClient({
  openclawBaseUrl: config.openclawBaseUrl,
  openclawApiKey: config.openclawApiKey,
  openclawGatewayToken: config.openclawGatewayToken,
  openclawPptTool: config.openclawPptTool,
  openclawPptToolArgSkillKey: config.openclawPptToolArgSkillKey,
  pptSkill: config.pptSkill,
  publicBaseUrl: config.publicBaseUrl,
  storage,
  db,
  mockMode: resolveMockMode()
});
const pptAgent = new PptAgent({ db, modelClient, pptClient, storage });
const gradesAgent = new GradesAgent({ db, storage, modelClient, publicBaseUrl: config.publicBaseUrl });
const quizAgent = new QuizAgent({ db, storage, modelClient, publicBaseUrl: config.publicBaseUrl });
const hub = new DeviceHub({ db, logger: app.log });
const weatherService = new WeatherService();
const mainAgent = new MainAgent({ db, modelClient, hub, weatherService });
const worker = new JobWorker({ db, pptAgent, gradesAgent, quizAgent, logger: app.log });

await app.register(fastifyJwt, { secret: config.jwtSecret });
await app.register(fastifyMultipart, {
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 20
  }
});
await app.register(fastifyWebsocket);
await app.register(fastifyStatic, {
  root: path.join(__dirname, 'static'),
  prefix: '/'
});

app.decorate('auth', async function auth(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: '未授权' });
  }
});

function safeDownloadName(name) {
  return String(name || 'file.bin').replace(/[\r\n\"]/g, '_');
}

function isImageFilename(name) {
  return /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(String(name || ''));
}

function isCsvOrExcelFilename(name) {
  return /\.(csv|xlsx|xls)$/i.test(String(name || ''));
}

function buildSessionTitleFromMessage(message) {
  const plain = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) {
    return '新会话';
  }
  return plain.length > 28 ? `${plain.slice(0, 28)}...` : plain;
}

function tokenFromAuthHeader(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length);
  }
  return null;
}

async function resolveUserIdForDownload(req) {
  let token = tokenFromAuthHeader(req);
  if (!token && req.query?.token) {
    token = String(req.query.token);
  }
  if (!token) {
    throw new Error('missing token');
  }
  const payload = await app.jwt.verify(token);
  if (!payload?.user_id) {
    throw new Error('bad token');
  }
  return payload.user_id;
}

async function saveMultipartFile({ userId, part, kind, category }) {
  const buffer = await part.toBuffer();
  const saved = await storage.saveBuffer({
    userId,
    category,
    originalName: part.filename || 'upload.bin',
    buffer
  });
  const fileId = db.createFile({
    userId,
    kind,
    filename: saved.filename,
    mime: part.mimetype || null,
    size: buffer.length,
    filePath: saved.path
  });
  return { fileId, filename: saved.filename, mime: part.mimetype, size: buffer.length };
}

app.get('/health', async () => ({
  ok: true,
  mock_mode: resolveMockMode(),
  time: new Date().toISOString()
}));

app.post('/admin/invites', async (req, reply) => {
  if (!config.adminKey || req.headers['x-admin-key'] !== config.adminKey) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  const { code, max_uses, expires_at } = req.body || {};
  if (!code) {
    return reply.code(400).send({ error: '缺少 code' });
  }
  const invite = db.ensureInvite({
    code: String(code),
    maxUses: Number(max_uses || 1),
    expiresAt: expires_at ? String(expires_at) : null
  });
  return invite;
});

app.post('/auth/invite/redeem', async (req, reply) => {
  const { code } = req.body || {};
  if (!code) {
    return reply.code(400).send({ error: '缺少 code' });
  }
  try {
    const result = db.redeemInvite(String(code));
    const jwt = app.jwt.sign({ user_id: result.user_id }, { expiresIn: '7d' });
    return {
      jwt,
      user_id: result.user_id,
      created: result.created
    };
  } catch (err) {
    return reply.code(400).send({ error: err.message || '邀请码兑换失败' });
  }
});

app.post('/devices/register', async (req, reply) => {
  const { invite_code, device_info, allowed_root } = req.body || {};
  if (!invite_code) {
    return reply.code(400).send({ error: '缺少 invite_code' });
  }

  try {
    const { user_id } = db.redeemInvite(String(invite_code));
    const deviceToken = randomBytes(32).toString('hex');
    const deviceId = db.registerDevice({
      userId: user_id,
      deviceInfo: device_info || {},
      allowedRoot: allowed_root || null,
      deviceToken
    });
    return {
      device_id: deviceId,
      device_token: deviceToken,
      user_id
    };
  } catch (err) {
    return reply.code(400).send({ error: err.message || '设备注册失败' });
  }
});

app.post('/devices/register-auth', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const { device_info, allowed_root } = req.body || {};
  const deviceToken = randomBytes(32).toString('hex');
  const deviceId = db.registerDevice({
    userId,
    deviceInfo: device_info || {},
    allowedRoot: allowed_root || null,
    deviceToken
  });
  return {
    device_id: deviceId,
    device_token: deviceToken,
    user_id: userId
  };
});

app.get('/devices', { preHandler: [app.auth] }, async (req) => {
  const userId = req.user.user_id;
  const devices = db.listUserDevices(userId).map((d) => ({
    ...d,
    online: hub.isOnline(d.id)
  }));
  return { devices };
});

app.get('/ws/device', { websocket: true }, (connection, req) => {
  const ws = connection?.socket || connection;
  if (!ws || typeof ws.on !== 'function' || typeof ws.send !== 'function') {
    app.log.error({ hasConnection: Boolean(connection) }, 'invalid websocket connection object');
    return;
  }

  const token = req.query?.device_token;
  if (!token) {
    ws.close(1008, 'missing device_token');
    return;
  }
  const device = db.getDeviceByToken(String(token));
  if (!device) {
    ws.close(1008, 'invalid device_token');
    return;
  }

  db.touchDevice(device.id);
  hub.setConnection(device.id, ws);
  app.log.info({ deviceId: device.id }, 'device connected');

  ws.on('message', (buf) => {
    db.touchDevice(device.id);
    hub.handleDeviceMessage(device.id, buf);
  });
  ws.on('close', () => {
    hub.removeConnection(device.id);
    app.log.info({ deviceId: device.id }, 'device disconnected');
  });
  ws.on('error', (err) => {
    app.log.error({ err, deviceId: device.id }, 'device websocket error');
  });

  ws.send(
    JSON.stringify({
      type: 'hello',
      device_id: device.id,
      server_time: new Date().toISOString()
    }),
  );
});

app.post('/upload/images', { preHandler: [app.auth] }, async (req, reply) => {
  if (!req.isMultipart()) {
    return reply.code(400).send({ error: '请使用 multipart/form-data 上传 images' });
  }
  const userId = req.user.user_id;
  const fileIds = [];

  for await (const part of req.parts()) {
    if (part.type !== 'file') {
      continue;
    }
    if (!part.mimetype?.startsWith('image/') && !isImageFilename(part.filename)) {
      return reply.code(400).send({ error: `只允许图片: ${part.filename}` });
    }
    const saved = await saveMultipartFile({ userId, part, kind: 'image', category: 'uploads' });
    fileIds.push(saved.fileId);
  }

  if (fileIds.length === 0) {
    return reply.code(400).send({ error: '没有检测到 images 文件' });
  }

  const uploadId = db.createUpload({ userId, fileIds });
  return {
    upload_id: uploadId,
    file_ids: fileIds
  };
});

app.post('/jobs/ppt', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const { upload_id, prompt } = req.body || {};
  if (!upload_id) {
    return reply.code(400).send({ error: '缺少 upload_id' });
  }
  const upload = db.getUploadWithFiles({ userId, uploadId: upload_id });
  if (!upload) {
    return reply.code(404).send({ error: 'upload 不存在' });
  }

  const jobId = db.createJob({
    userId,
    type: 'ppt',
    input: {
      upload_id,
      prompt: String(prompt || ''),
    }
  });
  return {
    job_id: jobId,
    status: 'queued'
  };
});

app.post('/jobs/grades', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;

  let input = null;
  if (req.isMultipart()) {
    const imageFileIds = [];
    let gradeFileId = null;

    for await (const part of req.parts()) {
      if (part.type !== 'file') {
        continue;
      }
      if (part.mimetype?.startsWith('image/') || isImageFilename(part.filename)) {
        const saved = await saveMultipartFile({ userId, part, kind: 'image', category: 'uploads' });
        imageFileIds.push(saved.fileId);
        continue;
      }
      if (part.mimetype === 'text/csv' || isCsvOrExcelFilename(part.filename)) {
        const saved = await saveMultipartFile({ userId, part, kind: 'grades_input', category: 'uploads' });
        gradeFileId = saved.fileId;
        continue;
      }
      return reply.code(400).send({ error: `不支持的文件类型: ${part.filename}` });
    }

    if (gradeFileId) {
      input = { file_id: gradeFileId };
    } else if (imageFileIds.length > 0) {
      const uploadId = db.createUpload({ userId, fileIds: imageFileIds });
      input = { upload_id: uploadId };
    }
  } else {
    const body = req.body || {};
    if (body.file_id) {
      const file = db.getFileForUser({ userId, fileId: body.file_id });
      if (!file) {
        return reply.code(404).send({ error: 'file_id 不存在' });
      }
      input = { file_id: body.file_id };
    } else if (body.upload_id) {
      const upload = db.getUploadWithFiles({ userId, uploadId: body.upload_id });
      if (!upload) {
        return reply.code(404).send({ error: 'upload_id 不存在' });
      }
      input = { upload_id: body.upload_id };
    }
  }

  if (!input) {
    return reply.code(400).send({ error: '请上传 csv/xlsx 或成绩图片' });
  }

  const jobId = db.createJob({
    userId,
    type: 'grades',
    input
  });
  return {
    job_id: jobId,
    status: 'queued'
  };
});

app.get('/jobs/:jobId', { preHandler: [app.auth] }, async (req, reply) => {
  const job = db.getJobForUser({
    userId: req.user.user_id,
    jobId: req.params.jobId
  });
  if (!job) {
    return reply.code(404).send({ error: 'job 不存在' });
  }

  return {
    job_id: job.id,
    type: job.type,
    status: job.status,
    result: job.result,
    error: job.error,
    updated_at: job.updated_at
  };
});

app.get('/download/:fileId', async (req, reply) => {
  let userId;
  try {
    userId = await resolveUserIdForDownload(req);
  } catch {
    return reply.code(401).send({ error: '未授权下载' });
  }

  const file = db.getFileForUser({ userId, fileId: req.params.fileId });
  if (!file || !fs.existsSync(file.path)) {
    return reply.code(404).send({ error: '文件不存在' });
  }

  reply.header('Content-Type', file.mime || 'application/octet-stream');
  reply.header('Content-Disposition', `attachment; filename="${safeDownloadName(file.filename)}"`);
  return reply.send(fs.createReadStream(file.path));
});

app.post('/devices/:deviceId/commands', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const { action, payload } = req.body || {};
  const deviceId = req.params.deviceId;

  if (!['list_dir', 'read_file', 'write_file', 'apply_patch', 'delete_path'].includes(action)) {
    return reply.code(400).send({ error: 'action 仅支持 list_dir/read_file/write_file/apply_patch/delete_path' });
  }

  const device = db.getDeviceForUser({ userId, deviceId });
  if (!device) {
    return reply.code(404).send({ error: '设备不存在' });
  }

  try {
    const result = await hub.request({
      userId,
      deviceId,
      action,
      payload: payload || {}
    });
    return {
      ok: true,
      ...result
    };
  } catch (err) {
    return reply.code(504).send({ error: err.message || '设备调用失败' });
  }
});

app.get('/commands/:commandId', { preHandler: [app.auth] }, async (req, reply) => {
  const cmd = db.getDeviceCommandForUser({
    userId: req.user.user_id,
    commandId: req.params.commandId
  });
  if (!cmd) {
    return reply.code(404).send({ error: 'command 不存在' });
  }
  return cmd;
});

app.post('/chat/sessions', { preHandler: [app.auth] }, async (req) => {
  const userId = req.user.user_id;
  const title = String(req.body?.title || '').trim() || '新会话';
  const session = db.createChatSession({ userId, title });
  return {
    session_id: session.id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    last_message_at: session.last_message_at
  };
});

app.get('/chat/sessions', { preHandler: [app.auth] }, async (req) => {
  const userId = req.user.user_id;
  const sessions = db.listChatSessionsForUser({ userId, limit: 200 }).map((item) => ({
    session_id: item.id,
    title: item.title,
    created_at: item.created_at,
    updated_at: item.updated_at,
    last_message_at: item.last_message_at
  }));
  return { sessions };
});

app.get('/chat/sessions/:sessionId/messages', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const sessionId = String(req.params.sessionId || '');
  const session = db.getChatSessionForUser({ userId, sessionId });
  if (!session) {
    return reply.code(404).send({ error: 'session 不存在' });
  }
  const messages = db.listMessagesForSession({ userId, sessionId, limit: 500 }).map((item) => ({
    id: item.id,
    role: item.role,
    content: item.content,
    created_at: item.created_at,
    session_id: item.session_id
  }));
  return {
    session: {
      session_id: session.id,
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
      last_message_at: session.last_message_at
    },
    messages
  };
});

app.delete('/chat/messages/:messageId', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const messageId = String(req.params.messageId || '');
  if (!messageId) {
    return reply.code(400).send({ error: '缺少 message_id' });
  }
  const deleted = db.deleteMessageForUser({ userId, messageId });
  if (!deleted) {
    return reply.code(404).send({ error: 'message 不存在' });
  }

  let session = null;
  if (deleted.session_id) {
    session = db.getChatSessionForUser({ userId, sessionId: deleted.session_id });
  }
  return {
    ok: true,
    deleted_message_id: deleted.id,
    session_id: deleted.session_id || null,
    session_last_message_at: session?.last_message_at || null,
  };
});

app.delete('/chat/sessions/:sessionId', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const sessionId = String(req.params.sessionId || '');
  if (!sessionId) {
    return reply.code(400).send({ error: '缺少 session_id' });
  }
  const deleted = db.deleteSessionForUser({ userId, sessionId });
  if (!deleted) {
    return reply.code(404).send({ error: 'session 不存在' });
  }
  return {
    ok: true,
    ...deleted,
  };
});

app.post('/chat/sessions/clear', { preHandler: [app.auth] }, async (req, reply) => {
  const userId = req.user.user_id;
  const scope = String(req.body?.scope || 'all');
  if (scope !== 'all') {
    return reply.code(400).send({ error: 'scope 仅支持 all' });
  }
  const result = db.clearAllSessionsForUser({ userId });
  return {
    ok: true,
    ...result,
  };
});

app.post('/chat', { preHandler: [app.auth] }, async (req, reply) => {
  const { message, upload_id, file_id, session_id, device_id, answer_key_id, quiz_result_id } = req.body || {};
  if (!message) {
    return reply.code(400).send({ error: '缺少 message' });
  }

  const userId = req.user.user_id;
  let session = null;
  if (session_id) {
    session = db.getChatSessionForUser({ userId, sessionId: String(session_id) });
    if (!session) {
      return reply.code(404).send({ error: 'session_id 不存在' });
    }
  } else {
    session = db.createChatSession({
      userId,
      title: buildSessionTitleFromMessage(message)
    });
  }

  if (answer_key_id) {
    const key = db.getAnswerKeyForUser({ userId, answerKeyId: String(answer_key_id) });
    if (!key) {
      return reply.code(404).send({ error: 'answer_key_id 不存在' });
    }
  }
  if (quiz_result_id) {
    const qr = db.getQuizResultForUser({ userId, resultId: String(quiz_result_id) });
    if (!qr) {
      return reply.code(404).send({ error: 'quiz_result_id 不存在' });
    }
  }

  const result = await mainAgent.handleChat({
    userId,
    sessionId: session.id,
    message,
    context: {
      upload_id,
      file_id,
      device_id,
      answer_key_id,
      quiz_result_id
    }
  });

  const assistantMessage = db.createMessage({ userId, sessionId: session.id, role: 'assistant', content: result.reply });
  const userMessage = db.getLatestMessageForSessionRole({ userId, sessionId: session.id, role: 'user' });
  return {
    ...result,
    session_id: session.id,
    messages: {
      user: userMessage
        ? {
            id: userMessage.id,
            created_at: userMessage.created_at,
          }
        : null,
      assistant: {
        id: assistantMessage.id,
        created_at: assistantMessage.created_at,
      },
    },
  };
});

worker.start(1500);

app.addHook('onClose', async () => {
  worker.stop();
});

app.listen({ port: config.port, host: config.host })
  .then(() => {
    app.log.info({
      port: config.port,
      mockMode: resolveMockMode(),
      publicBaseUrl: config.publicBaseUrl
    }, 'orchestrator started');
  })
  .catch((err) => {
    app.log.error({ err }, 'orchestrator failed to start');
    process.exit(1);
  });
