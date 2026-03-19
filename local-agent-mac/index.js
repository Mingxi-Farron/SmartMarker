#!/usr/bin/env node
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { WebSocket } from 'ws';
import { applyPatch } from 'diff';

const execFileAsync = promisify(execFile);
const SERVICE = 'teacher-ai-local-agent';
const CONFIG_DIR = path.join(os.homedir(), '.teacher-ai-local-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const FALLBACK_TOKEN_FILE = path.join(CONFIG_DIR, '.token.fallback');
const LOG_FILE = path.join(os.homedir(), 'Library', 'Logs', 'teacher-ai-local-agent.log');

async function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fsp.appendFile(LOG_FILE, line, 'utf8');
}

function normalizeServer(url) {
  let out = String(url || '').trim();
  if (!/^https?:\/\//.test(out)) {
    out = `http://${out}`;
  }
  return out.replace(/\/$/, '');
}

function safeJoin(allowedRoot, userPath) {
  const root = path.resolve(allowedRoot);
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

async function saveTokenToKeychain(account, token) {
  try {
    await execFileAsync('security', [
      'add-generic-password',
      '-a',
      account,
      '-s',
      SERVICE,
      '-w',
      token,
      '-U'
    ]);
    return true;
  } catch (err) {
    await logLine(`keychain 保存失败，降级文件存储: ${err.message}`);
    await fsp.writeFile(FALLBACK_TOKEN_FILE, token, { mode: 0o600 });
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
      SERVICE,
      '-w'
    ]);
    return String(stdout || '').trim() || null;
  } catch {
    try {
      return (await fsp.readFile(FALLBACK_TOKEN_FILE, 'utf8')).trim();
    } catch {
      return null;
    }
  }
}

async function loadConfig() {
  try {
    const text = await fsp.readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function saveConfig(config) {
  await fsp.mkdir(CONFIG_DIR, { recursive: true });
  await fsp.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function promptFirstSetup() {
  const rl = readline.createInterface({ input, output });
  try {
    const baseInput = await rl.question('Server URL (默认 http://127.0.0.1:8080): ');
    const inviteCode = await rl.question('邀请码: ');
    const defaultRoot = path.join(os.homedir(), 'Documents');
    const allowedRootInput = await rl.question(`授权目录 allowed_root (默认 ${defaultRoot}): `);

    const serverUrl = normalizeServer(baseInput || 'http://127.0.0.1:8080');
    const allowedRoot = path.resolve(allowedRootInput || defaultRoot);

    const resp = await fetch(`${serverUrl}/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invite_code: inviteCode.trim(),
        allowed_root: allowedRoot,
        device_info: {
          name: os.hostname(),
          platform: `${os.platform()}-${os.arch()}`,
          os_release: os.release()
        }
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || '设备注册失败');
    }

    const config = {
      server_url: serverUrl,
      device_id: data.device_id,
      allowed_root: allowedRoot,
      created_at: new Date().toISOString()
    };

    await saveConfig(config);
    await saveTokenToKeychain(data.device_id, data.device_token);

    console.log('首次配置完成。后续启动无需再次输入邀请码。');
    await logLine(`首次注册完成 device_id=${data.device_id} root=${allowedRoot}`);
    return {
      ...config,
      device_token: data.device_token
    };
  } finally {
    rl.close();
  }
}

async function ensureState() {
  const cfg = await loadConfig();
  if (!cfg) {
    return promptFirstSetup();
  }
  const token = await readTokenFromKeychain(cfg.device_id);
  if (!token) {
    await logLine('未找到 device_token，重新走首次配置');
    return promptFirstSetup();
  }
  return {
    ...cfg,
    device_token: token
  };
}

async function handleReadFile({ allowedRoot, payload }) {
  const filePath = safeJoin(allowedRoot, payload?.path);
  const encoding = payload?.encoding || 'utf8';
  const content =
    encoding === 'base64'
      ? (await fsp.readFile(filePath)).toString('base64')
      : await fsp.readFile(filePath, encoding);
  await logLine(`read_file ${filePath}`);
  return {
    path: filePath,
    content
  };
}

async function handleListDir({ allowedRoot, payload }) {
  const dirPath = safeJoin(allowedRoot, payload?.path || '.');
  const limitRaw = Number(payload?.limit || 100);
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
  await logLine(`list_dir ${dirPath} total=${entries.length} return=${sliced.length}`);
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

async function handleWriteFile({ allowedRoot, payload }) {
  const filePath = safeJoin(allowedRoot, payload?.path);
  const encoding = payload?.encoding || 'utf8';
  const append = Boolean(payload?.append);
  const content = String(payload?.content || '');
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
  await logLine(`write_file ${filePath} bytes=${bytes}`);
  return {
    path: filePath,
    bytes,
    append
  };
}

async function handleApplyPatch({ allowedRoot, payload }) {
  const filePath = safeJoin(allowedRoot, payload?.path);
  const patch = String(payload?.patch || '');
  const encoding = payload?.encoding || 'utf8';
  const original = await fsp.readFile(filePath, encoding);

  const next = applyPatch(original, patch, {
    fuzzFactor: 1
  });
  if (next === false) {
    throw new Error('patch 应用失败，请检查 patch 内容和文件版本');
  }

  await fsp.writeFile(filePath, next, encoding);
  await logLine(`apply_patch ${filePath}`);
  return {
    path: filePath,
    bytes: Buffer.byteLength(next, encoding)
  };
}

async function handleDeletePath({ allowedRoot, payload }) {
  const targetPath = safeJoin(allowedRoot, payload?.path);
  const recursive = Boolean(payload?.recursive);
  const stat = await fsp.lstat(targetPath);

  if (stat.isDirectory()) {
    if (!recursive) {
      await fsp.rmdir(targetPath);
    } else {
      await fsp.rm(targetPath, { recursive: true, force: false });
    }
    await logLine(`delete_path dir=${targetPath} recursive=${recursive}`);
    return {
      path: targetPath,
      kind: 'dir',
      recursive
    };
  }

  await fsp.unlink(targetPath);
  await logLine(`delete_path file=${targetPath}`);
  return {
    path: targetPath,
    kind: 'file',
    recursive: false
  };
}

async function executeCommand(state, packet) {
  const action = packet.action;
  if (action === 'list_dir') {
    return handleListDir({ allowedRoot: state.allowed_root, payload: packet.payload });
  }
  if (action === 'read_file') {
    return handleReadFile({ allowedRoot: state.allowed_root, payload: packet.payload });
  }
  if (action === 'write_file') {
    return handleWriteFile({ allowedRoot: state.allowed_root, payload: packet.payload });
  }
  if (action === 'apply_patch') {
    return handleApplyPatch({ allowedRoot: state.allowed_root, payload: packet.payload });
  }
  if (action === 'delete_path') {
    return handleDeletePath({ allowedRoot: state.allowed_root, payload: packet.payload });
  }
  throw new Error(`不支持的 action: ${action}`);
}

function toWsUrl(serverUrl, token) {
  const base = normalizeServer(serverUrl);
  const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return `${wsBase}/ws/device?device_token=${encodeURIComponent(token)}`;
}

async function run() {
  const state = await ensureState();
  await logLine(`agent 启动 device_id=${state.device_id}`);

  let retry = 0;

  const connect = () => {
    const wsUrl = toWsUrl(state.server_url, state.device_token);
    const ws = new WebSocket(wsUrl);

    ws.on('open', async () => {
      retry = 0;
      await logLine(`WS 已连接 ${wsUrl}`);
      console.log('已连接服务器。');
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
        const result = await executeCommand(state, packet);
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
        await logLine(`命令失败 action=${packet.action} err=${err.message}`);
        ws.send(
          JSON.stringify({
            type: 'result',
            request_id: packet.request_id,
            command_id: packet.command_id,
            ok: false,
            error: err.message
          }),
        );
      }
    });

    ws.on('close', async () => {
      retry += 1;
      const waitMs = Math.min(10000, 1500 * retry);
      await logLine(`WS 断开，${waitMs}ms 后重连`);
      setTimeout(connect, waitMs);
    });

    ws.on('error', async (err) => {
      await logLine(`WS 错误: ${err.message}`);
    });
  };

  connect();
}

run().catch(async (err) => {
  console.error(err.message);
  await logLine(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
