// Stands in for a running llama-server: answers /health 200 (or 503 if arg says so).
import { createServer } from 'node:http'
const port = Number(process.argv[2]); const healthy = process.argv[3] !== 'sick'
createServer((req, res) => {
  if (req.url === '/health' && healthy) { res.writeHead(200, {'content-type':'application/json'}); res.end('{"status":"ok"}') }
  else { res.writeHead(503); res.end('{"error":"Loading model"}') }
}).listen(port, '127.0.0.1', () => console.log('fake up on', port))
