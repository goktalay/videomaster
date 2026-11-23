'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  // arayüz dili (açılışta senkron alınır ki ilk çizim doğru dilde olsun)
  lang: ipcRenderer.sendSync('app:lang'),
  version: ipcRenderer.sendSync('app:version'),

  // Mastertool hesabı ve senkron
  accountState: () => ipcRenderer.invoke('account:state'),
  login: (email, password, remember) => ipcRenderer.invoke('account:login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('account:logout'),
  syncNow: () => ipcRenderer.invoke('account:syncNow'),
  setSyncEnabled: (on) => ipcRenderer.invoke('account:setSync', on),
  deleteRemoteLibrary: () => ipcRenderer.invoke('account:deleteRemote'),
  openWeb: (page) => ipcRenderer.invoke('account:openWeb', page), // 'forgot' | 'register' | 'account'
  onAccountStatus: on('account:status'),
  onUpdateAvailable: on('app:update'),
  onLibraryBackup: on('account:backup'),
  openMastertool: () => ipcRenderer.invoke('app:openMastertool'),
  about: () => ipcRenderer.invoke('app:about'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openLicenses: () => ipcRenderer.invoke('app:openLicenses'),
  showMain: () => ipcRenderer.invoke('app:showMain'),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),

  // depo
  getStore: () => ipcRenderer.invoke('store:get'),
  onStoreChanged: on('store:changed'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // bağlantılar ve klasörler
  saveConnection: (form) => ipcRenderer.invoke('connection:save', form),
  getConnection: (id) => ipcRenderer.invoke('connection:get', id),
  deleteConnection: (id) => ipcRenderer.invoke('connection:delete', id),
  duplicateConnection: (id) => ipcRenderer.invoke('connection:duplicate', id),
  moveConnection: (id, folderId) => ipcRenderer.invoke('connection:move', { id, folderId }),
  openConnection: (id) => ipcRenderer.invoke('connection:open', id),
  testConnection: (form) => ipcRenderer.invoke('connection:test', form),
  onConnectionChanged: on('connection:changed'),
  saveFolder: (f) => ipcRenderer.invoke('folder:save', f),
  moveFolder: (id, parentId) => ipcRenderer.invoke('folder:move', { id, parentId }),
  deleteFolder: (id) => ipcRenderer.invoke('folder:delete', id),
  pickDir: (defaultPath) => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  pickSdp: () => ipcRenderer.invoke('dialog:pickSdp'),

  // akış
  streamStates: () => ipcRenderer.invoke('stream:states'),
  streamState: (id) => ipcRenderer.invoke('stream:state', id),
  streamPlay: (id, origin) => ipcRenderer.invoke('stream:play', { id, origin }),
  streamStop: (id) => ipcRenderer.invoke('stream:stop', id),
  streamRestart: (id) => ipcRenderer.invoke('stream:restart', id),
  streamHistory: (id) => ipcRenderer.invoke('stream:history', id),
  streamSubscribe: (id, on) => ipcRenderer.invoke('stream:subscribe', { id, on }),
  streamAck: (id) => ipcRenderer.send('stream:ack', id),
  streamSaveFrame: (id) => ipcRenderer.invoke('stream:saveFrame', id),
  onStreamState: on('stream:state'),
  onStreamStats: on('stream:stats'),
  onStreamFrame: on('stream:frame'),
  onStreamAudio: on('stream:audio'),
  onThumbChanged: on('thumb:changed'),

  // kayıt
  recStart: (id) => ipcRenderer.invoke('rec:start', id),
  recStop: (id) => ipcRenderer.invoke('rec:stop', id),
  recReveal: (file) => ipcRenderer.invoke('rec:reveal', file),
  recOpenFile: (file) => ipcRenderer.invoke('rec:openFile', file),
  recOpenDir: (id) => ipcRenderer.invoke('rec:openDir', id),

  // akış verisi (HEX / paketler)
  tapTail: (id, bytes) => ipcRenderer.invoke('tap:tail', { id, bytes }),
  tapSnapshot: (id) => ipcRenderer.invoke('tap:snapshot', id),
  tapClear: (id) => ipcRenderer.invoke('tap:clear', id),
  tapSave: (id, base, length) => ipcRenderer.invoke('tap:save', { id, base, length }),

  // dronlar ve uçuşlar
  saveDrone: (form) => ipcRenderer.invoke('drone:save', form),
  getDrone: (id) => ipcRenderer.invoke('drone:get', id),
  deleteDrone: (id) => ipcRenderer.invoke('drone:delete', id),
  duplicateDrone: (id) => ipcRenderer.invoke('drone:duplicate', id),
  openDrone: (id) => ipcRenderer.invoke('drone:open', id),
  dronePorts: () => ipcRenderer.invoke('drone:ports'),
  droneConnect: (id) => ipcRenderer.invoke('drone:connect', id),
  droneDisconnect: (id) => ipcRenderer.invoke('drone:disconnect', id),
  droneState: (id) => ipcRenderer.invoke('drone:state', id),
  droneRecent: (id) => ipcRenderer.invoke('drone:recent', id),
  droneCall: (id, method, ...args) => ipcRenderer.invoke('drone:call', { id, method, args }),
  droneParams: (id) => ipcRenderer.invoke('drone:params', id),
  droneBriefs: () => ipcRenderer.invoke('drone:briefs'),
  droneParamsExport: (id, text) => ipcRenderer.invoke('drone:paramsExport', { id, text }),
  droneParamsImport: () => ipcRenderer.invoke('drone:paramsImport'),
  onDroneState: on('drone:state'),
  onDroneLog: on('drone:log'),
  onDroneStatustext: on('drone:statustext'),
  onDroneParams: on('drone:params'),
  onDroneParam: on('drone:param'),
  onDroneCalibration: on('drone:calibration'),
  onDroneChanged: on('drone:changed'),
  onDroneBrief: on('drone:brief'),
  saveFlight: (form) => ipcRenderer.invoke('flight:save', form),
  getFlight: (id) => ipcRenderer.invoke('flight:get', id),
  deleteFlight: (id) => ipcRenderer.invoke('flight:delete', id),
  openFlight: (id) => ipcRenderer.invoke('flight:open', id),
  onFlightChanged: on('flight:changed'),

  // yapay görü
  visionModels: () => ipcRenderer.invoke('vision:models'),
  visionDownload: (id) => ipcRenderer.invoke('vision:download', id),
  visionCancel: (id) => ipcRenderer.invoke('vision:cancel', id),
  visionRemove: (id) => ipcRenderer.invoke('vision:remove', id),
  visionRead: (id) => ipcRenderer.invoke('vision:read', id),
  visionAddModel: (input) => ipcRenderer.invoke('vision:addModel', input),
  visionRemoveModel: (id) => ipcRenderer.invoke('vision:removeModel', id),
  visionPickModel: () => ipcRenderer.invoke('vision:pickModel'),
  visionOpenDir: () => ipcRenderer.invoke('vision:openDir'),
  visionRuntime: () => ipcRenderer.invoke('vision:runtime'),
  visionSet: (id, vision) => ipcRenderer.invoke('vision:set', { id, vision }),
  visionExport: (id) => ipcRenderer.invoke('vision:export', id),
  visionImport: (id) => ipcRenderer.invoke('vision:import', id),
  onVisionProgress: on('vision:progress'),
  onVisionModels: on('vision:models'),

  // kamera kontrolü (modele özel)
  camConnect: (id) => ipcRenderer.invoke('cam:connect', id),
  camDisconnect: (id) => ipcRenderer.invoke('cam:disconnect', id),
  camState: (id) => ipcRenderer.invoke('cam:state', id),
  camExec: (id, cmd, args) => ipcRenderer.invoke('cam:exec', { id, cmd, args }),
  camHold: (id, cmd, args) => ipcRenderer.send('cam:hold', { id, cmd, args }),
  onCamState: on('cam:state'),
  onCamStatus: on('cam:status'),
  onCamReply: on('cam:reply'),
  onCamLog: on('cam:log'),
});
