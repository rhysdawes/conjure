// Lets Conjure on your phone run on your Claude Code login instead of an API key.
// It speaks just enough of the Anthropic Messages API for Conjure (streaming
// POST /v1/messages and GET /v1/models/:id) and answers each request with
// `claude -p`, passing Claude's stream events straight through as SSE.
//
//   node server/conjure-server.mjs          # listens on 127.0.0.1:8766
//
// Expose it to your phone with `tailscale funnel --bg 8766`, then paste the
// printed link into Conjure's settings. The link carries a secret token; every
// request without it is refused, because this runs Claude on your machine.
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.CONJURE_PORT || 8766);
const CLAUDE = process.env.CONJURE_CLAUDE || 'claude';
const ALLOWED_ORIGINS = ['https://rhysdawes.github.io', 'http://localhost:8765', 'http://127.0.0.1:8765'];
const MAX_BODY = 40 * 1024 * 1024;
const MAX_RUNNING = 3;
const STATE_DIR = join(homedir(), '.conjure-server');
const TOKEN_FILE = join(STATE_DIR, 'token');
// An empty working directory, so no project CLAUDE.md or settings leak into apps.
const WORK_DIR = join(tmpdir(), 'conjure-claude');

let running = 0;

function loadToken() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(TOKEN_FILE)) {
    writeFileSync(TOKEN_FILE, randomBytes(24).toString('base64url') + '\n', { mode: 0o600 });
  }
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

const TOKEN = loadToken();
mkdirSync(WORK_DIR, { recursive: true });

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function tokenOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

function sendError(res, status, type, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function systemText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  return system.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

function asBlocks(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

// claude -p takes one user turn, so earlier turns (rare in Conjure) become a
// transcript in front of the last message.
function userContent(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') throw new Error('The last message must be from the user');
  const earlier = messages.slice(0, -1).map((m) => {
    const text = asBlocks(m.content).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return `<${m.role}>\n${text}\n</${m.role}>`;
  });
  const blocks = asBlocks(last.content);
  return earlier.length
    ? [{ type: 'text', text: `Earlier in this conversation:\n${earlier.join('\n')}` }, ...blocks]
    : blocks;
}

function claudeArgs(body) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--tools', '', '--setting-sources', '', '--strict-mcp-config',
    '--no-session-persistence', '--model', String(body.model || 'claude-opus-5-5'),
  ];
  const effort = body.output_config && body.output_config.effort;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);
  const system = systemText(body.system);
  if (system) args.push('--system-prompt', system);
  return args;
}

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleMessages(req, res, body) {
  if (!body.stream) {
    sendError(res, 400, 'invalid_request_error', 'This server only supports streaming requests');
    return;
  }
  if (running >= MAX_RUNNING) {
    sendError(res, 429, 'rate_limit_error', 'Too many requests at once on your Claude Code server. Try again in a moment.');
    return;
  }
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content: userContent(body.messages || []) } });
  const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(body.max_tokens || 32000) };
  delete env.ANTHROPIC_API_KEY;

  running += 1;
  const started = Date.now();
  const child = spawn(CLAUDE, claudeArgs(body), { cwd: WORK_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  log(`start pid=${child.pid} model=${body.model} effort=${body.output_config && body.output_config.effort} running=${running}`);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  // Builds take minutes; pings keep proxies and the phone from timing the stream out.
  const ping = setInterval(() => sse(res, 'ping', { type: 'ping' }), 15000);

  let buffered = '';
  let stderr = '';
  let messages = 0;
  let finished = false;
  let failure = '';

  child.stdout.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    let nl;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        log(`unparseable line from claude: ${err.message}: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.type === 'stream_event') {
        // With no tools there is one assistant message; forward only the first in
        // case Claude Code ever retries, so the SDK sees a single clean message.
        if (msg.event.type === 'message_start') messages += 1;
        if (messages === 1) {
          sse(res, msg.event.type, msg.event);
          if (msg.event.type === 'message_stop') finished = true;
        }
      } else if (msg.type === 'result' && msg.is_error) {
        failure = msg.result || (msg.errors || []).join('; ') || msg.subtype || 'Claude Code failed';
      }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  child.stdin.on('error', (err) => log(`stdin error pid=${child.pid}: ${err.message}`));
  child.stdin.end(input + '\n');

  res.on('close', () => {
    if (child.exitCode === null && !child.killed) {
      log(`client went away, stopping pid=${child.pid}`);
      child.kill('SIGTERM');
    }
  });

  child.on('error', (err) => {
    failure = `Could not start Claude Code (${err.message})`;
    log(failure);
  });

  child.on('close', (code) => {
    running -= 1;
    clearInterval(ping);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (!finished) {
      const reason = failure || stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}`;
      log(`failed pid=${child.pid} after ${secs}s: ${reason}`);
      sse(res, 'error', { type: 'error', error: { type: 'api_error', message: reason } });
    } else {
      log(`done pid=${child.pid} in ${secs}s`);
    }
    res.end();
  });
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (!tokenOk(req.headers['x-api-key'])) {
    log(`refused ${req.method} ${path}: bad token`);
    sendError(res, 401, 'authentication_error', 'Wrong or missing Conjure server token');
    return;
  }
  if (req.method === 'GET' && path.startsWith('/v1/models/')) {
    const id = decodeURIComponent(path.slice('/v1/models/'.length));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'model', id, display_name: `${id} via Claude Code`, created_at: new Date().toISOString() }));
    return;
  }
  if (req.method === 'POST' && path === '/v1/messages') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      log(`bad request body: ${err.message}`);
      sendError(res, 400, 'invalid_request_error', err.message);
      return;
    }
    try {
      handleMessages(req, res, body);
    } catch (err) {
      log(`request failed: ${err.message}`);
      if (!res.headersSent) sendError(res, 400, 'invalid_request_error', err.message);
      else res.end();
    }
    return;
  }
  sendError(res, 404, 'not_found_error', `No route for ${req.method} ${path}`);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`Conjure server on http://127.0.0.1:${PORT} (token in ${TOKEN_FILE})`);
});
