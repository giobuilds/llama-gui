/** Channel names, kept in one place so main and preload cannot drift apart. */
export const IPC = {
  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverStatus: 'server:status',
  serverStatusChanged: 'server:status-changed',
  logsSince: 'logs:since',
  logsChanged: 'logs:changed',
  binaryInfo: 'binary:info',
  binaryList: 'binary:list',
  binarySelect: 'binary:select',
  binaryDevices: 'binary:devices',
  modelsList: 'models:list',
  modelsRescan: 'models:rescan',
  modelPlan: 'models:plan',
  modelFit: 'models:fit',
  binaryHealthCheck: 'binary:health-check',
  pickModelFile: 'dialog:pick-model',
  pickModelDir: 'dialog:pick-model-dir'
} as const
