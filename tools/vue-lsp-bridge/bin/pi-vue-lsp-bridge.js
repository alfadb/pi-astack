#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { VueLspBridge } from '../lib/bridge.js';
import { RpcEndpoint } from '../lib/protocol.js';

const require = createRequire(import.meta.url);
const packageRoot = packageName => path.dirname(require.resolve(`${packageName}/package.json`));
const vueRoot = packageRoot('@vue/language-server');
const tlsRoot = packageRoot('typescript-language-server');
const pluginLocation = packageRoot('@vue/typescript-plugin');
const typescriptLib = path.dirname(require.resolve('typescript/lib/typescript.js'));
const tsserverPath = require.resolve('typescript/lib/tsserver.js');
const timeoutArg = process.argv.find(argument => argument.startsWith('--timeout='));
const configuredTimeout = Number(timeoutArg?.slice('--timeout='.length) ?? process.env.PI_VUE_LSP_TIMEOUT_MS);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000;

function log(message) {
  process.stderr.write(`[pi-vue-lsp-bridge] ${message}\n`);
}

const peers = [];
let terminating = false;
let terminationPromise;

function terminate(code) {
  if (terminationPromise) {
    return terminationPromise;
  }
  terminating = true;
  terminationPromise = new Promise(resolve => {
    const children = peers.map(peer => peer.process);
    let remaining = children.filter(child => child.exitCode === null && child.signalCode === null).length;
    let finished = false;
    let killTimer;
    let forceFinishTimer;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(killTimer);
      clearTimeout(forceFinishTimer);
      resolve();
      process.exit(code);
    };
    if (remaining === 0) {
      finish();
      return;
    }
    killTimer = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
      forceFinishTimer = setTimeout(finish, 1_000);
    }, 1_000);
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) {
        continue;
      }
      child.once('exit', () => {
        remaining -= 1;
        if (remaining === 0) {
          finish();
        }
      });
      child.stdin.end();
    }
  });
  return terminationPromise;
}

function failPeer(name, detail) {
  if (terminating) {
    return;
  }
  log(`${name} ${detail}`);
  void terminate(1);
}

function monitorPeer(peer) {
  const { name, process: child } = peer;
  child.on('error', error => failPeer(name, `failed: ${error.message}`));
  child.on('exit', (code, signal) => {
    failPeer(name, `exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
  });
  child.stdout.on('close', () => failPeer(name, 'stdout closed unexpectedly'));

  if (process.env.PI_VUE_LSP_TEST_REPORT_CHILD_PIDS === '1') {
    log(`test peer ${name} pid=${child.pid}`);
  }
  if (process.env.PI_VUE_LSP_TEST_EXIT_CHILD === name) {
    // This is intentionally opt-in so the integration test can exercise supervision.
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
    }, 100).unref();
  }
}

function startPeer(name, entrypoint, args) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const endpoint = new RpcEndpoint({
    reader: child.stdout,
    writer: child.stdin,
    idPrefix: name,
    timeoutMs,
  });
  endpoint.process = child;
  endpoint.on('protocolError', error => log(`${name} protocol error: ${error.message}`));
  endpoint.on('orphanResponse', message => log(`${name} returned unknown response id ${String(message.id)}`));
  child.stderr.on('data', chunk => {
    process.stderr.write(`[${name}] ${chunk.toString('utf8')}`);
  });
  return endpoint;
}

const vue = startPeer(
  'vue',
  path.join(vueRoot, 'bin', 'vue-language-server.js'),
  ['--stdio', `--tsdk=${typescriptLib}`],
);
const tls = startPeer(
  'tls',
  path.join(tlsRoot, 'lib', 'cli.mjs'),
  ['--stdio'],
);
peers.push(
  { name: 'vue', process: vue.process },
  { name: 'tls', process: tls.process },
);
for (const peer of peers) {
  monitorPeer(peer);
}

const client = new RpcEndpoint({
  reader: process.stdin,
  writer: process.stdout,
  idPrefix: 'client',
  timeoutMs,
});

const bridge = new VueLspBridge({
  client,
  vue,
  tls,
  pluginLocation,
  tsserverPath,
  timeoutMs,
  logger: log,
  onExit: code => void terminate(code),
});
bridge.start();
client.on('protocolError', error => log(`client protocol error: ${error.message}`));
client.on('close', () => {
  if (!terminating) {
    void terminate(1);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => void terminate(1));
}
