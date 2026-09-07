/** Channel names, kept in one place so main and preload cannot drift apart. */
export const IPC = {
  serverStart: 'server:start',
  serverStop: 'server:stop',
  serverStatus: 'server:status',
  serverStatusChanged: 'server:status-changed',
  logsSince: 'logs:since',
  logsChanged: 'logs:changed',
  binaryInfo: 'binary:info',
  binaryDevices: 'binary:devices',
  pickModelFile: 'dialog:pick-model'
} as const
