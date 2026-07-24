import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { VueLspBridge } from '../lib/bridge.js';
import { encodeMessage, LspFramer, RpcError } from '../lib/protocol.js';

class FakeEndpoint extends EventEmitter {
  constructor(requestHandler = async () => null) {
    super();
    this.requestHandler = requestHandler;
    this.requests = [];
    this.notifications = [];
    this.responses = [];
    this.errors = [];
    this.nextId = 1;
  }

  async request(method, params, options = {}) {
    const id = `fake:${this.nextId++}`;
    options.onId?.(id);
    this.requests.push({ id, method, params, options });
    return this.requestHandler(method, params, options);
  }

  notify(method, params) {
    this.notifications.push({ method, params });
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, error) {
    this.errors.push({ id, error });
  }
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

test('LSP framing handles split headers, UTF-8 byte lengths, and adjacent messages', () => {
  const first = {
    jsonrpc: '2.0',
    id: 1,
    method: 'example',
    params: { text: 'Vue \u5355\u6587\u4ef6' },
  };
  const second = { jsonrpc: '2.0', method: 'ready', params: ['two'] };
  const encoded = Buffer.concat([encodeMessage(first), encodeMessage(second)]);
  const messages = [];
  const framer = new LspFramer();
  framer.on('message', message => messages.push(message));

  framer.push(encoded.subarray(0, 11));
  framer.push(encoded.subarray(11, 39));
  framer.push(encoded.subarray(39));

  assert.deepEqual(messages, [first, second]);
});

test('client requests are forwarded with a distinct peer id and original response id', async () => {
  const client = new FakeEndpoint();
  const vue = new FakeEndpoint(async (method, params) => ({ method, uri: params.textDocument.uri }));
  const tls = new FakeEndpoint();
  tls.pluginLocation = '/bridge/node_modules/@vue/typescript-plugin';
  tls.tsserverPath = '/bridge/node_modules/typescript/lib/tsserver.js';
  const bridge = new VueLspBridge({ client, vue, tls });

  await bridge.handleClientMessage({
    jsonrpc: '2.0',
    id: 77,
    method: 'textDocument/hover',
    params: { textDocument: { uri: 'file:///project/App.vue' }, position: { line: 1, character: 2 } },
  });

  assert.equal(vue.requests.length, 1);
  assert.equal(vue.requests[0].method, 'textDocument/hover');
  assert.notEqual(vue.requests[0].id, 77);
  assert.deepEqual(client.responses, [{
    id: 77,
    result: { method: 'textDocument/hover', uri: 'file:///project/App.vue' },
  }]);
});

test('initialize pins TLS to the bridge plugin and TypeScript paths', async () => {
  const client = new FakeEndpoint();
  const vue = new FakeEndpoint(async () => ({ capabilities: {}, serverInfo: { name: 'vue' } }));
  const tls = new FakeEndpoint(async () => ({
    capabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
  }));
  const bridge = new VueLspBridge({
    client,
    vue,
    tls,
    pluginLocation: '/bridge/node_modules/@vue/typescript-plugin',
    tsserverPath: '/bridge/node_modules/typescript/lib/tsserver.js',
  });
  const params = {
    rootUri: 'file:///project',
    capabilities: {},
    initializationOptions: {
      plugins: [{ name: 'other-plugin', location: '/other', languages: ['typescript'] }],
      tsserver: { path: '/project/node_modules/typescript/lib/tsserver.js' },
    },
  };

  await bridge.handleClientMessage({ jsonrpc: '2.0', id: 4, method: 'initialize', params });

  assert.equal(tls.requests[0].params.initializationOptions.tsserver.path,
    '/bridge/node_modules/typescript/lib/tsserver.js');
  assert.deepEqual(tls.requests[0].params.initializationOptions.plugins.at(-1), {
    name: '@vue/typescript-plugin',
    location: '/bridge/node_modules/@vue/typescript-plugin',
    languages: ['vue'],
  });
  assert.strictEqual(vue.requests[0].params, params);
  assert.deepEqual(client.responses[0].result.capabilities.executeCommandProvider.commands,
    ['typescript.tsserverRequest']);
});

test('Vue tsserver notifications become TLS execute commands and unwrap only the response envelope', async () => {
  const client = new FakeEndpoint();
  const vue = new FakeEndpoint();
  const tls = new FakeEndpoint(async () => ({
    seq: 0,
    type: 'response',
    command: '_vue:getComponentNames',
    request_seq: 9,
    success: true,
    body: [['FirstComponent', 'SecondComponent']],
  }));
  const bridge = new VueLspBridge({ client, vue, tls });

  await bridge.handlePeerMessage('vue', {
    jsonrpc: '2.0',
    method: 'tsserver/request',
    params: [[23, '_vue:getComponentNames', ['/project/App.vue']]],
  });

  assert.deepEqual(tls.requests[0], {
    id: 'fake:1',
    method: 'workspace/executeCommand',
    params: {
      command: 'typescript.tsserverRequest',
      arguments: ['_vue:getComponentNames', ['/project/App.vue']],
    },
    options: { timeoutMs: 30_000 },
  });
  assert.deepEqual(vue.notifications, [{
    method: 'tsserver/response',
    params: [[23, [['FirstComponent', 'SecondComponent']]]],
  }]);
});

test('timed out tsserver forwarding always sends a null response notification', async () => {
  const client = new FakeEndpoint();
  const vue = new FakeEndpoint();
  const tls = new FakeEndpoint((_method, _params, options) => new Promise((resolve, reject) => {
    void resolve;
    setTimeout(() => reject(new RpcError(-32001, 'test timeout')), options.timeoutMs);
  }));
  const logs = [];
  const bridge = new VueLspBridge({
    client,
    vue,
    tls,
    timeoutMs: 5,
    logger: message => logs.push(message),
  });

  await bridge.handlePeerMessage('vue', {
    jsonrpc: '2.0',
    method: 'tsserver/request',
    params: [[91, '_vue:projectInfo', { file: '/project/App.vue' }]],
  });

  assert.deepEqual(vue.notifications, [{
    method: 'tsserver/response',
    params: [[91, null]],
  }]);
  assert.match(logs[0], /timed out|timeout/);
});

test('document open, change, and close notifications use identical payloads for both peers', async () => {
  const client = new FakeEndpoint();
  const vue = new FakeEndpoint();
  const tls = new FakeEndpoint();
  const bridge = new VueLspBridge({ client, vue, tls });
  const messages = [
    { method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///App.vue', languageId: 'vue', version: 1, text: '<template />' } } },
    { method: 'textDocument/didChange', params: { textDocument: { uri: 'file:///App.vue', version: 2 }, contentChanges: [{ text: '<script setup></script>' }] } },
    { method: 'textDocument/didClose', params: { textDocument: { uri: 'file:///App.vue' } } },
  ];

  for (const message of messages) {
    await bridge.handleClientMessage({ jsonrpc: '2.0', ...message });
  }
  await nextTurn();

  assert.deepEqual(vue.notifications, messages);
  assert.deepEqual(tls.notifications, messages);
  assert.strictEqual(vue.notifications[0].params, tls.notifications[0].params);
});

test('shutdown responds before exit is sent to both peers with a successful status', async () => {
  const client = new FakeEndpoint();
  const vue = new FakeEndpoint();
  const tls = new FakeEndpoint();
  const exitCodes = [];
  const bridge = new VueLspBridge({
    client,
    vue,
    tls,
    onExit: code => exitCodes.push(code),
  });

  await bridge.handleClientMessage({ jsonrpc: '2.0', id: 8, method: 'shutdown' });
  await bridge.handleClientMessage({ jsonrpc: '2.0', method: 'exit' });

  assert.deepEqual(client.responses, [{ id: 8, result: null }]);
  assert.deepEqual(vue.notifications.at(-1), { method: 'exit', params: undefined });
  assert.deepEqual(tls.notifications.at(-1), { method: 'exit', params: undefined });
  assert.deepEqual(exitCodes, [0]);
});
