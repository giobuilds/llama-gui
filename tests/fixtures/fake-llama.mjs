#!/usr/bin/env node
// Stand-in for llama-server: same CLI shape, same stderr strings (taken from the
// b6153 binary), same /health semantics (503 "Loading model" until resident).
import { createServer } from 'node:http'
const argv = process.argv.slice(2)
const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const port = Number(get('--port'))
const model = get('--model')
const loadMs = Number(process.env.FAKE_LOAD_MS ?? 1500)

let ready = false
process.stderr.write(`srv    load_model: loading model '${model}'\n`)
createServer((req, res) => {
  if (req.url === '/health') {
    if (ready) { res.writeHead(200, {'content-type':'application/json'}); res.end('{"status":"ok"}') }
    else { res.writeHead(503, {'content-type':'application/json'}); res.end('{"error":{"code":503,"message":"Loading model"}}') }
    return
  }
  res.writeHead(404); res.end()
}).listen(port, '127.0.0.1', () => {
  setTimeout(() => {
    process.stderr.write('main: model loaded\n')
    process.stderr.write(`main: HTTP server is listening, hostname: 127.0.0.1, port: ${port}, http threads: 4\n`)
    process.stderr.write(`main: server is listening on http://127.0.0.1:${port} - starting the main loop\n`)
    ready = true
  }, loadMs)
})
// Ignore SIGTERM if asked, to exercise the SIGKILL escalation.
if (process.env.FAKE_IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
