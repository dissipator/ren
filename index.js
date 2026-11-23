// Single-file zero-dependency wrapper for Node.js PaaS (route A, eooce-style shell, Lei core).
// - Serves a plain HTTP page on PORT and proxies WebSocket upgrades to a local xray.
// - Downloads xray ONLY from the official XTLS GitHub release. UUID comes from env (required).
// - No subscription endpoint, nothing secret is printed to logs.
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT || '10001', 10);
const UUID = process.env.UUID || '';
const WS_PATH = process.env.WS_PATH || '/ws';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'node-core-'));

if (!UUID) {
  console.error('UUID env is required');
  process.exit(1);
}

function download(url, dest, cb) {
  const { execFile } = require('child_process');
  execFile('curl', ['-fsSL', '-o', dest, url], (err) => {
    if (!err) return cb(null);
    execFile('wget', ['-q', '-O', dest, url], (err2) => cb(err2 || null));
  });
}

function ensureXray(cb) {
  const local = process.env.XRAY_BIN;
  if (local && fs.existsSync(local)) return cb(local);
  const inWork = path.join(WORK, 'xray');
  if (fs.existsSync(inWork)) return cb(inWork);
  const arch = os.arch();
  const pkg = arch === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
  const url = `https://github.com/XTLS/Xray-core/releases/latest/download/${pkg}`;
  const zip = path.join(WORK, 'xray.zip');
  download(url, zip, (err) => {
    if (err) { console.error('download failed'); return process.exit(1); }
    try { execFileSync('unzip', ['-q', '-o', zip, 'xray', '-d', WORK]); }
    catch (e) { execFileSync('python3', ['-m', 'zipfile', '-e', zip, WORK]); }
    fs.chmodSync(inWork, 0o755);
    cb(inWork);
  });
}

function writeConfig() {
  const cfg = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1', port: INTERNAL_PORT, protocol: 'vless',
      settings: { clients: [{ id: UUID, level: 0 }], decryption: 'none' },
      streamSettings: { network: 'ws', security: 'none', wsSettings: { path: WS_PATH } },
      sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] }
    }],
    outbounds: [{ protocol: 'freedom', tag: 'direct', settings: { finalRules: [{ action: 'allow', network: 'tcp,udp', port: '0-65535' }] } }],
    dns: { servers: ['1.1.1.1', '8.8.8.8'] }
  };
  const p = path.join(WORK, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Welcome</title></head>' +
  '<body style="font-family:sans-serif;margin:40px"><h3>Server is Running</h3><p>It works.</p></body></html>';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url || !req.url.startsWith(WS_PATH)) { socket.destroy(); return; }
  const upstream = net.connect(INTERNAL_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

ensureXray((bin) => {
  const cfgPath = writeConfig();
  const child = spawn(bin, ['run', '-config', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', (code) => { console.error('core exited', code); process.exit(code || 1); });
  server.listen(PORT, '0.0.0.0', () => console.log(`http listening on ${PORT}`));
});
