#!/usr/bin/env node
// opencode-bridge.js
// Local bridge that exposes the API keys/models configured in opencode to the
// Study Assistant extension. Binds to 127.0.0.1 only.
//
// Reads:
//   ~/.local/share/opencode/auth.json     (API keys stored by opencode)
//   ~/.config/opencode/opencode.json(.c)  (custom provider config)
//
// Serves:
//   GET /health  -> { ok: true }
//   GET /v1/keys -> { ok, source, providers, order }
//
// Start: node tools/opencode-bridge.js   (managed by start-bridge.ps1)

'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const PORT = 47821;
const HOST = '127.0.0.1';

const OPENDCODE_ZEN_BASE = 'https://opencode.ai/zen/v1';

function homedir() {
  return os.homedir();
}

function readJsonSafe(file, stripComments) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (stripComments) {
      raw = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,\s*([}\]])/g, '$1');
    }
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function loadAuth() {
  const file = path.join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  return readJsonSafe(file, false) || {};
}

function loadConfig() {
  const base = path.join(homedir(), '.config', 'opencode');
  return (
    readJsonSafe(path.join(base, 'opencode.json'), false) ||
    readJsonSafe(path.join(base, 'opencode.jsonc'), true) ||
    {}
  );
}

// Map opencode providers to extension providers.
function collectProviders(auth, config) {
  const providers = {};
  const order = [];

  const apiKey = (name) => {
    const entry = auth[name];
    if (entry && entry.type === 'api' && typeof entry.key === 'string' && entry.key.length > 10) {
      return entry.key;
    }
    return null;
  };

  const zenKey = apiKey('opencode-go');
  if (zenKey) {
    providers.opencode = { key: zenKey, base: OPENDCODE_ZEN_BASE, model: 'deepseek-v4-flash' };
    order.push('opencode');
  }

  for (const name of ['google', 'openai', 'anthropic', 'openrouter', 'nvidia']) {
    const key = apiKey(name);
    if (key) {
      providers[name] = { key };
      order.push(name);
    }
  }

  const customProviders = (config && config.provider) || {};
  const localCandidate =
    customProviders.llamacpp || customProviders.lmstudio || customProviders.ollama || null;
  if (localCandidate && localCandidate.options && localCandidate.options.baseURL) {
    const models = localCandidate.models || {};
    const firstModel = Object.keys(models)[0] || 'llama3';
    providers.local = {
      endpoint: localCandidate.options.baseURL.replace(/\/+$/, ''),
      model: firstModel,
    };
    order.push('local');
  }

  return { providers, order };
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function handler(req, res) {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && url === '/health') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url === '/v1/keys') {
    const auth = loadAuth();
    const config = loadConfig();
    const { providers, order } = collectProviders(auth, config);
    return send(res, 200, { ok: true, source: 'opencode', providers, order });
  }
  return send(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(handler);
server.listen(PORT, HOST, () => {
  console.log(`[opencode-bridge] listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
  console.error('[opencode-bridge] error:', err.message);
  process.exit(1);
});