import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RpcEndpoint } from '../lib/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeBin = path.resolve(here, '..', 'bin', 'pi-vue-lsp-bridge.js');

async function runChildFailureTest(target) {
  const child = spawn(process.execPath, [bridgeBin, '--stdio', '--timeout=5000'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PI_VUE_LSP_TEST_EXIT_CHILD: target,
      PI_VUE_LSP_TEST_REPORT_CHILD_PIDS: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));

  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge did not exit after peer failure')), 4_000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    const output = stderr.join('');
    assert.notEqual(exitCode, 0, `bridge must fail after ${target} exits unexpectedly\n${output}`);
    const pids = [...output.matchAll(/test peer (?:vue|tls) pid=(\d+)/g)].map(match => Number(match[1]));
    assert.equal(new Set(pids).size, 2, `bridge must report both child PIDs\n${output}`);

    const deadline = Date.now() + 1_000;
    while (pids.some(pid => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code !== 'ESRCH';
      }
    })) {
      if (Date.now() >= deadline) {
        throw new Error(`bridge left a child process running: ${pids.join(', ')}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    process.stdout.write(`${JSON.stringify({ target, exitCode, childPids: pids }, null, 2)}\n`);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

if (process.env.PI_VUE_LSP_TEST_EXIT_CHILD) {
  await runChildFailureTest(process.env.PI_VUE_LSP_TEST_EXIT_CHILD);
  process.exit(0);
}

const root = process.env.PI_VUE_LSP_SMOKE_ROOT ?? '/home/worker/work/base/sub2api/frontend';
const vueFile = path.join(root, 'src', 'App.vue');
const rootUri = pathToFileURL(root).href;
const uri = pathToFileURL(vueFile).href;
const text = await readFile(vueFile, 'utf8');
const child = spawn(process.execPath, [bridgeBin, '--stdio', '--timeout=45000'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const childExitPromise = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
});
const stderr = [];
child.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
const client = new RpcEndpoint({
  reader: child.stdout,
  writer: child.stdin,
  idPrefix: 'smoke',
  timeoutMs: 45_000,
});

let diagnosticResolve;
const diagnosticPromise = new Promise(resolve => {
  diagnosticResolve = resolve;
});
const notifications = [];
client.on('message', message => {
  if (Object.hasOwn(message, 'id')) {
    if (message.method === 'workspace/configuration') {
      client.respond(message.id, (message.params?.items ?? []).map(() => null));
    } else if (message.method === 'workspace/workspaceFolders') {
      client.respond(message.id, [{ uri: rootUri, name: path.basename(root) }]);
    } else if (message.method === 'window/workDoneProgress/create'
      || message.method === 'client/registerCapability'
      || message.method === 'client/unregisterCapability') {
      client.respond(message.id, null);
    } else if (message.method === 'workspace/applyEdit') {
      client.respond(message.id, { applied: false, failureReason: 'Smoke client does not edit files' });
    } else {
      client.respond(message.id, null);
    }
    return;
  }
  notifications.push(message);
  if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri === uri) {
    diagnosticResolve(message.params);
  }
});

function positionAt(needle) {
  const offset = text.indexOf(needle);
  assert.notEqual(offset, -1, `${needle} must exist in App.vue`);
  const prefix = text.slice(0, offset);
  const lines = prefix.split('\n');
  return {
    line: lines.length - 1,
    character: lines.at(-1).length + Math.min(2, needle.length - 1),
  };
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

let exitCode;
try {
  const initialize = await client.request('initialize', {
    processId: process.pid,
    clientInfo: { name: 'pi-vue-lsp-bridge-smoke', version: '1.0.0' },
    rootUri,
    rootPath: root,
    workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
    capabilities: {
      workspace: {
        configuration: true,
        workspaceFolders: true,
        didChangeWatchedFiles: { dynamicRegistration: false },
      },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: true },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        hover: { contentFormat: ['markdown', 'plaintext'] },
        publishDiagnostics: {
          relatedInformation: true,
          versionSupport: true,
          tagSupport: { valueSet: [1, 2] },
        },
      },
      window: { workDoneProgress: true },
    },
    initializationOptions: {},
  });
  assert.equal(initialize.serverInfo?.name, '@vue/language-server');
  assert.ok(initialize.capabilities?.documentSymbolProvider, 'document symbols must be advertised');
  assert.ok(initialize.capabilities?.hoverProvider, 'hover must be advertised');

  client.notify('initialized', {});
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'vue', version: 1, text },
  });
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text }],
  });

  const symbols = await client.request('textDocument/documentSymbol', {
    textDocument: { uri },
  });
  assert.ok(Array.isArray(symbols) && symbols.length > 0, 'real App.vue must return document symbols');

  const hover = await client.request('textDocument/hover', {
    textDocument: { uri },
    position: positionAt('useRouter()'),
  });
  assert.ok(hover?.contents, 'real App.vue must return hover content');

  const diagnostics = await withTimeout(diagnosticPromise, 30_000, 'real App.vue diagnostics');
  assert.ok(Array.isArray(diagnostics.diagnostics), 'diagnostics notification must contain an array');

  client.notify('textDocument/didClose', { textDocument: { uri } });
  assert.equal(await client.request('shutdown'), null);
  client.notify('exit');
  exitCode = await withTimeout(childExitPromise, 5_000, 'bridge exit');
  assert.equal(exitCode, 0);

  process.stdout.write(`${JSON.stringify({
    root,
    file: vueFile,
    symbols: symbols.length,
    hover: true,
    diagnostics: diagnostics.diagnostics.length,
    diagnosticPublishCount: notifications.filter(
      message => message.method === 'textDocument/publishDiagnostics' && message.params?.uri === uri,
    ).length,
    exitCode,
  }, null, 2)}\n`);
} catch (error) {
  child.kill('SIGKILL');
  const details = stderr.join('').slice(-8_000);
  process.stderr.write(`${error.stack ?? error}\n${details}`);
  process.exitCode = 1;
}
