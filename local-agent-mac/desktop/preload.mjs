import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktopApi', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  pickDirectory: () => ipcRenderer.invoke('app:pick-directory'),
  pickFiles: () => ipcRenderer.invoke('app:pick-files'),
  bootstrap: (payload) => ipcRenderer.invoke('app:bootstrap', payload),
  logout: () => ipcRenderer.invoke('app:logout'),
  createSession: (payload) => ipcRenderer.invoke('chat:create-session', payload),
  listSessions: () => ipcRenderer.invoke('chat:list-sessions'),
  getSessionMessages: (sessionId) => ipcRenderer.invoke('chat:get-session-messages', { sessionId }),
  deleteMessage: (messageId) => ipcRenderer.invoke('chat:delete-message', { messageId }),
  deleteSession: (sessionId) => ipcRenderer.invoke('chat:delete-session', { sessionId }),
  clearSessions: () => ipcRenderer.invoke('chat:clear-sessions'),
  sendChat: (payload) => ipcRenderer.invoke('chat:send', payload),
  uploadImages: (payload) => ipcRenderer.invoke('upload:images', payload),
  createGradesJob: (payload) => ipcRenderer.invoke('jobs:create-grades', payload),
  getJob: (jobId) => ipcRenderer.invoke('jobs:get', { jobId }),
  openDownload: (url) => ipcRenderer.invoke('download:open', { url }),
  onDeviceStatus: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('device-status', wrapped);
    return () => ipcRenderer.removeListener('device-status', wrapped);
  }
});
