const { contextBridge, ipcRenderer } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('ghostwolf', {
  platform,
  closeWindow: () => ipcRenderer.send('close-window'),
  windowDrag: (dx, dy) => ipcRenderer.send('window-drag', { dx, dy }),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[GhostWolf] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  isLinux: process.platform === 'linux',
  resizeWindow: (width, height) => ipcRenderer.send('window:resize', { width, height }),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  linuxRecloakChrome: () => ipcRenderer.invoke('linux:recloak-chrome'),
  log: (msg) => ipcRenderer.send('log', msg),
  // Meeting persistence
  meetingsList: () => ipcRenderer.invoke('meetings:list'),
  meetingsAdd: () => ipcRenderer.invoke('meetings:add'),
  meetingsUpdate: (id, patch) => ipcRenderer.invoke('meetings:update', id, patch),
  meetingsSearch: (q) => ipcRenderer.invoke('meetings:search', q),
  meetingsRecentSummaries: (n) => ipcRenderer.invoke('meetings:recent-summaries', n),
  meetingsRemove: (id) => ipcRenderer.invoke('meetings:remove', id),
  meetingsGenerateNotes: (id) => ipcRenderer.invoke('meetings:generate-notes', id),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'status', 'transcript', 'stt:interim', 'stt:final', 'stt:status', 'vad:state', 'applink:consent-request', 'hide:toggle', 'whisper:download-progress', 'whisper:models-changed', 'meetings:notes-token', 'linux:cloak-result'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
