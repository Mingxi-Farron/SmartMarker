import { randomUUID } from 'node:crypto';

export class DeviceHub {
  constructor({ db, logger }) {
    this.db = db;
    this.logger = logger;
    this.connections = new Map();
    this.pending = new Map();
  }

  setConnection(deviceId, ws) {
    if (!ws || typeof ws.send !== 'function') {
      this.logger?.warn({ deviceId }, 'invalid device websocket, skip setConnection');
      return;
    }
    this.connections.set(deviceId, ws);
  }

  removeConnection(deviceId) {
    this.connections.delete(deviceId);
    for (const [requestId, pending] of this.pending.entries()) {
      if (pending.deviceId === deviceId) {
        pending.reject(new Error('设备断开连接'));
        this.pending.delete(requestId);
      }
    }
  }

  isOnline(deviceId) {
    const ws = this.connections.get(deviceId);
    return Boolean(ws && typeof ws.send === 'function' && (typeof ws.readyState !== 'number' || ws.readyState === 1));
  }

  handleDeviceMessage(deviceId, raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.type === 'result' && data.request_id) {
      const pending = this.pending.get(data.request_id);
      if (!pending) {
        return;
      }
      this.pending.delete(data.request_id);
      if (data.ok) {
        pending.resolve(data.result || null);
      } else {
        pending.reject(new Error(data.error || '设备执行失败'));
      }
    }
  }

  async request({ userId, deviceId, action, payload, timeoutMs = 15000 }) {
    if (!this.isOnline(deviceId)) {
      throw new Error('设备不在线');
    }
    const ws = this.connections.get(deviceId);

    const commandId = this.db.createDeviceCommand({
      userId,
      deviceId,
      action,
      payload
    });

    const requestId = randomUUID();
    const packet = {
      type: 'command',
      command_id: commandId,
      request_id: requestId,
      action,
      payload
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.db.finishDeviceCommand({
          commandId,
          ok: false,
          error: '设备响应超时',
          result: null
        });
        reject(new Error('设备响应超时'));
      }, timeoutMs);

      this.pending.set(requestId, {
        deviceId,
        resolve: (result) => {
          clearTimeout(timer);
          this.db.finishDeviceCommand({
            commandId,
            ok: true,
            result,
            error: null
          });
          resolve({ command_id: commandId, result });
        },
        reject: (error) => {
          clearTimeout(timer);
          this.db.finishDeviceCommand({
            commandId,
            ok: false,
            result: null,
            error: error.message
          });
          reject(error);
        }
      });

      ws.send(JSON.stringify(packet), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(requestId);
          this.db.finishDeviceCommand({
            commandId,
            ok: false,
            result: null,
            error: err.message
          });
          reject(err);
        }
      });
    });
  }
}
