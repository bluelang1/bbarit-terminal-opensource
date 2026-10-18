#!/usr/bin/env node
import http from 'node:http';
import { createServer } from 'vite';

const host = '127.0.0.1';
const port = 5175;
const checkOnly = process.argv.includes('--check');

const requestText = (path, method = 'GET') => new Promise((resolve) => {
  const request = http.request({ host, port, path, method, timeout: 1500 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      if (body.length < 4096) {
        body += chunk;
      }
    });
    response.on('end', () => {
      resolve({ ok: true, statusCode: response.statusCode ?? 0, body });
    });
  });
  request.on('timeout', () => {
    request.destroy();
    resolve({ ok: false, statusCode: 0, body: '', error: 'timeout' });
  });
  request.on('error', (error) => {
    resolve({ ok: false, statusCode: 0, body: '', error: error.message });
  });
  request.end();
});

const healthyResponse = (response) => (
  response.ok
  && response.statusCode >= 200
  && response.statusCode < 500
  && !response.body.includes('[plugin:vite')
  && !response.body.includes('The service is no longer running')
);

const checkExistingServer = async () => {
  const root = await requestText('/', 'HEAD');
  if (!root.ok) {
    return { exists: false, healthy: false, reason: root.error || 'not listening' };
  }

  const probes = [
    '/src/App.tsx',
    '/src/XTerminal.tsx',
  ];
  for (const path of probes) {
    const response = await requestText(path);
    if (!healthyResponse(response)) {
      return {
        exists: true,
        healthy: false,
        reason: `${path} returned ${response.statusCode || response.error || 'no response'}`,
      };
    }
  }

  return { exists: true, healthy: true, reason: 'ok' };
};

const existing = await checkExistingServer();
if (checkOnly) {
  if (!existing.exists) {
    console.log(`Vite dev server is not listening at http://${host}:${port}/`);
    process.exit(1);
  }
  if (!existing.healthy) {
    console.error(`Vite dev server failed health checks: ${existing.reason}`);
    process.exit(1);
  }
  console.log(`Vite dev server is healthy at http://${host}:${port}/`);
  process.exit(0);
}

if (existing.exists) {
  if (!existing.healthy) {
    console.error(
      `Vite dev server is already listening at http://${host}:${port}/ but failed health checks: ${existing.reason}`,
    );
    console.error('Stop the stale dev server for this repo, then run npm run tauri:dev again.');
    process.exit(1);
  }
  console.log(`Vite dev server already running and healthy at http://${host}:${port}/`);
  const keepAlive = setInterval(() => {}, 2 ** 30);
  const closeExisting = () => {
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.once('SIGINT', closeExisting);
  process.once('SIGTERM', closeExisting);
  await new Promise(() => {});
}

const server = await createServer({
  configFile: 'vite.config.ts',
  server: {
    host,
    port,
    strictPort: true,
  },
});

await server.listen();
server.printUrls();

const close = async () => {
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};

process.once('SIGINT', close);
process.once('SIGTERM', close);

await new Promise(() => {});
