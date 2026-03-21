import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { WebSocket } from 'ws';
import { applyPatch } from 'diff';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_DIR = path.join(os.homedir(), '.teacher-ai-desktop');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
const DEVICE_FILE = path.join(CONFIG_DIR, 'device.json');
const TOKEN_FALLBACK_FILE = path.join(CONFIG_DIR, '.device-token');
const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'teacher-ai-desktop.log');
const TOKEN_SERVICE = 'teacher-ai-desktop-device-token';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:8080';

const runtime = {
  mainWindow: null,
  session: null,
  device: null,
  deviceToken: null,
  ws: null,
  wsStatus: 'offline',
  wsDetail: '',
  reconnectMs: 2000,
  reconnectTimer: null
};

function nowIso() {
  return new Date().toISOString();
}

async function writeLog(text) {
  const line = `[${nowIso()}] ${text}\n`;
  await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fsp.appendFile(LOG_FILE, line, 'utf8');
}

function normalizeServer(value) {
  let out = String(value || '').trim();
  if (!out) {
    out = DEFAULT_SERVER_URL;
  }
  if (!/^https?:\/\//.test(out)) {
    out = `http://${out}`;
  }
  return out.replace(/\/$/, '');
}

function toWsUrl(serverUrl, token) {
  const base = normalizeServer(serverUrl);
  const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${wsBase}/ws/device?device_token=${encodeURIComponent(token)}`;
}

function mimeByFilename(filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.png')) {
    return 'image/png';
  }
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (name.endsWith('.webp')) {
    return 'image/webp';
  }
  if (name.endsWith('.gif')) {
    return 'image/gif';
  }
  if (name.endsWith('.bmp')) {
    return 'image/bmp';
  }
  if (name.endsWith('.csv')) {
    return 'text/csv';
  }
  if (name.endsWith('.xlsx')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (name.endsWith('.xls')) {
    return 'application/vnd.ms-excel';
  }
  return 'application/octet-stream';
}

async function readJson(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
}

async function saveTokenToKeychain(account, token) {
  try {
    await execFileAsync('security', [
      'add-generic-password',
      '-a',
      account,
      '-s',
      TOKEN_SERVICE,
      '-w',
      token,
      '-U'
    ]);
    return true;
  } catch (err) {
    await writeLog(`keychain 保存失败，降级到本地文件: ${err.message}`);
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    await fsp.writeFile(TOKEN_FALLBACK_FILE, token, { mode: 0o600 });
    return false;
  }
}

async function readTokenFromKeychain(account) {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-a',
      account,
      '-s',
      TOKEN_SERVICE,
      '-w'
    ]);
    const token = String(stdout || '').trim();
    if (token) {
      return token;
    }
  } catch {
    // ignore
  }

  try {
    const fromFile = await fsp.readFile(TOKEN_FALLBACK_FILE, 'utf8');
    return String(fromFile || '').trim() || null;
  } catch {
    return null;
  }
}

async function deleteToken(account) {
  try {
    await execFileAsync('security', [
      'delete-generic-password',
      '-a',
      account,
      '-s',
      TOKEN_SERVICE
    ]);
  } catch {
    // ignore
  }

  try {
    if (existsSync(TOKEN_FALLBACK_FILE)) {
      await fsp.unlink(TOKEN_FALLBACK_FILE);
    }
  } catch {
    // ignore
  }
}

function uiState() {
  return {
    authenticated: Boolean(runtime.session?.jwt),
    user_id: runtime.session?.userId || '',
    server_url: runtime.session?.serverUrl || runtime.device?.serverUrl || DEFAULT_SERVER_URL,
    device: {
      registered: Boolean(runtime.device?.deviceId),
      device_id: runtime.device?.deviceId || '',
      allowed_root: runtime.device?.allowedRoot || '',
      status: runtime.wsStatus,
      detail: runtime.wsDetail
    }
  };
}

function broadcastDeviceStatus() {
  if (!runtime.mainWindow || runtime.mainWindow.isDestroyed()) {
    return;
  }
  runtime.mainWindow.webContents.send('device-status', {
    status: runtime.wsStatus,
    detail: runtime.wsDetail,
    at: nowIso()
  });
}

function setWsStatus(status, detail = '') {
  runtime.wsStatus = status;
  runtime.wsDetail = detail;
  broadcastDeviceStatus();
}

function safeJoin(allowedRoot, userPath) {
  const root = path.resolve(String(allowedRoot || ''));
  if (!root) {
    throw new Error('设备未设置授权目录');
  }
  const requested = String(userPath || '').trim();
  if (!requested) {
    throw new Error('path 不能为空');
  }

  const resolved = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);

  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`禁止访问 allowed_root 外部路径: ${requested}`);
  }
  return resolved;
}

async function executeCommand(packet) {
  const action = packet.action;
  const payload = packet.payload || {};
  const allowedRoot = runtime.device?.allowedRoot;

  if (!allowedRoot) {
    throw new Error('本地设备尚未配置授权目录');
  }

  if (action === 'list_dir') {
    const dirPath = safeJoin(allowedRoot, payload.path || '.');
    const limitRaw = Number(payload.limit || 100);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 100;
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) {
        return -1;
      }
      if (!a.isDirectory() && b.isDirectory()) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    const sliced = entries.slice(0, limit);
    await writeLog(`list_dir ${dirPath} total=${entries.length} return=${sliced.length}`);
    return {
      path: dirPath,
      total: entries.length,
      truncated: entries.length > sliced.length,
      items: sliced.map((item) => ({
        name: item.name,
        type: item.isDirectory() ? 'dir' : 'file'
      }))
    };
  }

  if (action === 'read_file') {
    const filePath = safeJoin(allowedRoot, payload.path);
    const encoding = payload.encoding || 'utf8';
    const content =
      encoding === 'base64'
        ? (await fsp.readFile(filePath)).toString('base64')
        : await fsp.readFile(filePath, encoding);
    await writeLog(`read_file ${filePath}`);
    return {
      path: filePath,
      content
    };
  }

  if (action === 'write_file') {
    const filePath = safeJoin(allowedRoot, payload.path);
    const encoding = payload.encoding || 'utf8';
    const append = Boolean(payload.append);
    const content = String(payload.content || '');
    const writeBuffer = encoding === 'base64' ? Buffer.from(content, 'base64') : null;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (append) {
      if (writeBuffer) {
        await fsp.appendFile(filePath, writeBuffer);
      } else {
        await fsp.appendFile(filePath, content, encoding);
      }
    } else {
      if (writeBuffer) {
        await fsp.writeFile(filePath, writeBuffer);
      } else {
        await fsp.writeFile(filePath, content, encoding);
      }
    }
    const bytes = writeBuffer ? writeBuffer.length : Buffer.byteLength(content, encoding);
    await writeLog(`write_file ${filePath} bytes=${bytes}`);
    return {
      path: filePath,
      bytes,
      append
    };
  }

  if (action === 'apply_patch') {
    const filePath = safeJoin(allowedRoot, payload.path);
    const encoding = payload.encoding || 'utf8';
    const patch = String(payload.patch || '');
    const original = await fsp.readFile(filePath, encoding);
    const next = applyPatch(original, patch, { fuzzFactor: 1 });
    if (next === false) {
      throw new Error('patch 应用失败，请检查 patch 内容和文件版本');
    }
    await fsp.writeFile(filePath, next, encoding);
    await writeLog(`apply_patch ${filePath}`);
    return {
      path: filePath,
      bytes: Buffer.byteLength(next, encoding)
    };
  }

  if (action === 'delete_path') {
    const targetPath = safeJoin(allowedRoot, payload.path);
    const recursive = Boolean(payload.recursive);
    const stat = await fsp.lstat(targetPath);
    if (stat.isDirectory()) {
      if (!recursive) {
        await fsp.rmdir(targetPath);
      } else {
        await fsp.rm(targetPath, { recursive: true, force: false });
      }
      await writeLog(`delete_path dir=${targetPath} recursive=${recursive}`);
      return {
        path: targetPath,
        kind: 'dir',
        recursive
      };
    }

    await fsp.unlink(targetPath);
    await writeLog(`delete_path file=${targetPath}`);
    return {
      path: targetPath,
      kind: 'file',
      recursive: false
    };
  }

  throw new Error(`不支持的 action: ${action}`);
}

function closeWs() {
  if (runtime.ws) {
    try {
      runtime.ws.close();
    } catch {
      // ignore
    }
    runtime.ws = null;
  }
}

function scheduleReconnect() {
  if (runtime.reconnectTimer || !runtime.device || !runtime.deviceToken) {
    return;
  }
  const waitMs = runtime.reconnectMs;
  runtime.reconnectTimer = setTimeout(() => {
    runtime.reconnectTimer = null;
    connectWs().catch((err) => {
      setWsStatus('error', err.message || '重连失败');
      scheduleReconnect();
    });
  }, waitMs);
  runtime.reconnectMs = Math.min(12000, Math.round(waitMs * 1.4));
}

async function connectWs() {
  if (!runtime.device || !runtime.deviceToken) {
    setWsStatus('offline', '未注册本地设备');
    return;
  }

  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
  closeWs();

  const wsUrl = toWsUrl(runtime.device.serverUrl, runtime.deviceToken);
  await writeLog(`ws connecting ${wsUrl}`);
  setWsStatus('connecting', '正在连接本地设备通道');

  const ws = new WebSocket(wsUrl);
  runtime.ws = ws;

  ws.on('open', async () => {
    runtime.reconnectMs = 2000;
    setWsStatus('online', '本地设备已在线');
    await writeLog('ws connected');
  });

  ws.on('message', async (raw) => {
    let packet;
    try {
      packet = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (packet.type !== 'command' || !packet.request_id) {
      return;
    }

    try {
      const result = await executeCommand(packet);
      ws.send(
        JSON.stringify({
          type: 'result',
          request_id: packet.request_id,
          command_id: packet.command_id,
          ok: true,
          result
        }),
      );
    } catch (err) {
      await writeLog(`command failed ${packet.action}: ${err.message}`);
      ws.send(
        JSON.stringify({
          type: 'result',
          request_id: packet.request_id,
          command_id: packet.command_id,
          ok: false,
          error: err.message || '命令执行失败'
        }),
      );
    }
  });

  ws.on('close', async () => {
    await writeLog('ws closed');
    if (runtime.ws !== ws) {
      return;
    }
    runtime.ws = null;
    setWsStatus('offline', '本地设备连接断开，正在重连');
    scheduleReconnect();
  });

  ws.on('error', async (err) => {
    await writeLog(`ws error: ${err.message}`);
    if (runtime.ws !== ws) {
      return;
    }
    setWsStatus('error', err.message || '连接异常');
  });
}

async function apiRequest({
  serverUrl,
  endpoint,
  method = 'GET',
  jwt = '',
  body = null,
  headers = {}
}) {
  const url = `${normalizeServer(serverUrl)}${endpoint}`;
  const finalHeaders = { ...headers };
  if (jwt) {
    finalHeaders.Authorization = `Bearer ${jwt}`;
  }

  let requestBody = body;
  if (body && !(body instanceof FormData)) {
    finalHeaders['Content-Type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers: finalHeaders,
    body: requestBody
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `请求失败: ${response.status}`);
  }
  return data;
}

function ensureLoggedIn() {
  if (!runtime.session?.jwt || !runtime.session?.serverUrl) {
    throw new Error('请先完成邀请码登录');
  }
}

async function uploadByPaths({ filePaths, field = 'images', onlyImages = false }) {
  ensureLoggedIn();
  const form = new FormData();
  for (const filePath of filePaths || []) {
    const absolute = path.resolve(filePath);
    const filename = path.basename(absolute);
    if (onlyImages && !/\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(filename)) {
      continue;
    }
    const content = await fsp.readFile(absolute);
    form.append(field, new Blob([content], { type: mimeByFilename(filename) }), filename);
  }
  return form;
}

async function bootstrap({ inviteCode, serverUrl, allowedRoot }) {
  const normalizedServer = normalizeServer(serverUrl);
  const invite = String(inviteCode || '').trim();
  const root = path.resolve(String(allowedRoot || '').trim());

  if (!root) {
    throw new Error('请选择授权目录');
  }

  let session = runtime.session;
  if (invite) {
    const login = await apiRequest({
      serverUrl: normalizedServer,
      endpoint: '/auth/invite/redeem',
      method: 'POST',
      body: { code: invite }
    });
    session = {
      serverUrl: normalizedServer,
      jwt: login.jwt,
      userId: login.user_id,
      createdAt: nowIso()
    };
  } else {
    if (!session?.jwt) {
      throw new Error('请填写邀请码，或先使用已有会话');
    }
    if (normalizeServer(session.serverUrl) !== normalizedServer) {
      throw new Error('当前已登录会话与输入的 Server URL 不一致，请填写邀请码重新登录');
    }
  }

  const register = await apiRequest({
    serverUrl: normalizedServer,
    endpoint: '/devices/register-auth',
    method: 'POST',
    jwt: session.jwt,
    body: {
      allowed_root: root,
      device_info: {
        name: os.hostname(),
        platform: `${os.platform()}-${os.arch()}`,
        os_release: os.release()
      }
    }
  });

  runtime.session = session;
  runtime.device = {
    serverUrl: normalizedServer,
    userId: session.userId,
    deviceId: register.device_id,
    allowedRoot: root,
    createdAt: nowIso()
  };
  runtime.deviceToken = register.device_token;

  await writeJson(SESSION_FILE, runtime.session);
  await writeJson(DEVICE_FILE, runtime.device);
  await saveTokenToKeychain(runtime.device.deviceId, runtime.deviceToken);
  await connectWs();

  return uiState();
}

async function restoreRuntime() {
  runtime.session = await readJson(SESSION_FILE);
  runtime.device = await readJson(DEVICE_FILE);
  if (runtime.device?.deviceId) {
    runtime.deviceToken = await readTokenFromKeychain(runtime.device.deviceId);
  }
  if (runtime.device && runtime.deviceToken) {
    connectWs().catch((err) => {
      setWsStatus('error', err.message || '连接失败');
    });
  } else {
    setWsStatus('offline', '未注册本地设备');
  }
}

async function clearRuntime() {
  closeWs();
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }

  if (runtime.device?.deviceId) {
    await deleteToken(runtime.device.deviceId);
  }

  for (const file of [SESSION_FILE, DEVICE_FILE]) {
    try {
      if (existsSync(file)) {
        await fsp.unlink(file);
      }
    } catch {
      // ignore
    }
  }

  runtime.session = null;
  runtime.device = null;
  runtime.deviceToken = null;
  setWsStatus('offline', '未登录');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f2f5fb',
    title: 'SmartMarker',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  runtime.mainWindow = win;
  win.on('closed', () => {
    if (runtime.mainWindow === win) {
      runtime.mainWindow = null;
    }
  });
}

ipcMain.handle('app:get-state', async () => uiState());

ipcMain.handle('app:pick-directory', async () => {
  const result = await dialog.showOpenDialog(runtime.mainWindow || undefined, {
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('app:pick-files', async () => {
  const result = await dialog.showOpenDialog(runtime.mainWindow || undefined, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '支持格式',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'csv', 'xlsx', 'xls']
      }
    ]
  });
  if (result.canceled) {
    return [];
  }
  return result.filePaths || [];
});

ipcMain.handle('app:bootstrap', async (_, payload) => bootstrap(payload || {}));

ipcMain.handle('app:logout', async () => {
  await clearRuntime();
  return uiState();
});

ipcMain.handle('chat:create-session', async (_, payload) => {
  ensureLoggedIn();
  const title = String(payload?.title || '').trim() || '新会话';
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: '/chat/sessions',
    method: 'POST',
    jwt: runtime.session.jwt,
    body: { title }
  });
});

ipcMain.handle('chat:list-sessions', async () => {
  ensureLoggedIn();
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: '/chat/sessions',
    method: 'GET',
    jwt: runtime.session.jwt
  });
});

ipcMain.handle('chat:get-session-messages', async (_, payload) => {
  ensureLoggedIn();
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) {
    throw new Error('缺少 sessionId');
  }
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: `/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    method: 'GET',
    jwt: runtime.session.jwt
  });
});

ipcMain.handle('chat:delete-message', async (_, payload) => {
  ensureLoggedIn();
  const messageId = String(payload?.messageId || '').trim();
  if (!messageId) {
    throw new Error('缺少 messageId');
  }
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: `/chat/messages/${encodeURIComponent(messageId)}`,
    method: 'DELETE',
    jwt: runtime.session.jwt
  });
});

ipcMain.handle('chat:delete-session', async (_, payload) => {
  ensureLoggedIn();
  const sessionId = String(payload?.sessionId || '').trim();
  if (!sessionId) {
    throw new Error('缺少 sessionId');
  }
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: `/chat/sessions/${encodeURIComponent(sessionId)}`,
    method: 'DELETE',
    jwt: runtime.session.jwt
  });
});

ipcMain.handle('chat:clear-sessions', async () => {
  ensureLoggedIn();
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: '/chat/sessions/clear',
    method: 'POST',
    jwt: runtime.session.jwt,
    body: {
      scope: 'all'
    }
  });
});

ipcMain.handle('chat:send', async (_, payload) => {
  ensureLoggedIn();
  const message = String(payload?.message || '').trim();
  if (!message) {
    throw new Error('message 不能为空');
  }
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: '/chat',
    method: 'POST',
    jwt: runtime.session.jwt,
    body: {
      message,
      session_id: payload?.session_id || null,
      upload_id: payload?.upload_id || null,
      file_id: payload?.file_id || null,
      device_id: runtime.device?.deviceId || null,
      answer_key_id: payload?.answer_key_id || null,
      quiz_result_id: payload?.quiz_result_id || null
    }
  });
});

ipcMain.handle('upload:images', async (_, payload) => {
  ensureLoggedIn();
  const filePaths = payload?.filePaths || [];
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('未选择图片');
  }
  const form = await uploadByPaths({ filePaths, field: 'images', onlyImages: true });
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: '/upload/images',
    method: 'POST',
    jwt: runtime.session.jwt,
    body: form
  });
});

ipcMain.handle('jobs:create-grades', async (_, payload) => {
  ensureLoggedIn();
  const filePaths = payload?.filePaths || [];
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error('未选择文件');
  }

  const form = new FormData();
  let hasValue = false;

  for (const filePath of filePaths) {
    const absolute = path.resolve(filePath);
    const filename = path.basename(absolute);
    const content = await fsp.readFile(absolute);
    if (/\.(csv|xlsx|xls)$/i.test(filename)) {
      if (!hasValue) {
        form.append('file', new Blob([content], { type: mimeByFilename(filename) }), filename);
        hasValue = true;
      }
      continue;
    }
    if (/\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(filename)) {
      form.append('images', new Blob([content], { type: mimeByFilename(filename) }), filename);
      hasValue = true;
    }
  }

  if (!hasValue) {
    throw new Error('成绩分析仅支持 csv/xlsx/xls 或图片文件');
  }

  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: '/jobs/grades',
    method: 'POST',
    jwt: runtime.session.jwt,
    body: form
  });
});

ipcMain.handle('jobs:get', async (_, payload) => {
  ensureLoggedIn();
  const jobId = String(payload?.jobId || '');
  if (!jobId) {
    throw new Error('缺少 jobId');
  }
  return apiRequest({
    serverUrl: runtime.session.serverUrl,
    endpoint: `/jobs/${encodeURIComponent(jobId)}`,
    method: 'GET',
    jwt: runtime.session.jwt
  });
});

ipcMain.handle('download:open', async (_, payload) => {
  ensureLoggedIn();
  const rawUrl = String(payload?.url || '').trim();
  if (!rawUrl) {
    throw new Error('缺少下载地址');
  }

  const resolved = new URL(rawUrl, runtime.session.serverUrl);
  if (resolved.pathname.startsWith('/download/')) {
    resolved.searchParams.set('token', runtime.session.jwt);
  }
  await shell.openExternal(resolved.toString());
  return resolved.toString();
});

app.whenReady().then(async () => {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await restoreRuntime();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  closeWs();
  if (runtime.reconnectTimer) {
    clearTimeout(runtime.reconnectTimer);
    runtime.reconnectTimer = null;
  }
});
