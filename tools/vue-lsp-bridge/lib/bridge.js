import { RpcError } from './protocol.js';

const BROADCAST_NOTIFICATIONS = new Set([
  '$/setTrace',
  'initialized',
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didSave',
  'textDocument/didClose',
  'workspace/didChangeConfiguration',
  'workspace/didChangeWatchedFiles',
  'workspace/didCreateFiles',
  'workspace/didRenameFiles',
  'workspace/didDeleteFiles',
  'workspace/didChangeWorkspaceFolders',
]);

function isRequest(message) {
  return message && typeof message.method === 'string' && Object.hasOwn(message, 'id');
}

function isNotification(message) {
  return message && typeof message.method === 'string' && !Object.hasOwn(message, 'id');
}

function hasTsserverEnvelope(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.type === 'response'
    && (Object.hasOwn(value, 'body') || Object.hasOwn(value, 'success'));
}

export function unwrapTsserverResponse(result) {
  // Some clients wrap the execute-command result once; only unwrap a singleton
  // when its member is recognizably a tsserver response envelope.
  if (Array.isArray(result) && result.length === 1 && hasTsserverEnvelope(result[0])) {
    result = result[0];
  }
  if (hasTsserverEnvelope(result)) {
    return Object.hasOwn(result, 'body') ? result.body : null;
  }
  return result ?? null;
}

export class VueLspBridge {
  #client;
  #vue;
  #tls;
  #timeoutMs;
  #logger;
  #pluginLocation;
  #tsserverPath;
  #clientRequests = new Map();
  #tlsCommands = new Set();
  #shutdown = false;
  #onExit;

  constructor({
    client,
    vue,
    tls,
    pluginLocation,
    tsserverPath,
    timeoutMs = 30_000,
    logger = () => {},
    onExit = () => {},
  }) {
    this.#client = client;
    this.#vue = vue;
    this.#tls = tls;
    this.#pluginLocation = pluginLocation;
    this.#tsserverPath = tsserverPath;
    this.#timeoutMs = timeoutMs;
    this.#logger = logger;
    this.#onExit = onExit;
  }

  start() {
    this.#client.on('message', message => void this.handleClientMessage(message));
    this.#vue.on('message', message => void this.handlePeerMessage('vue', message));
    this.#tls.on('message', message => void this.handlePeerMessage('tls', message));
  }

  async handleClientMessage(message) {
    if (isRequest(message)) {
      try {
        const result = await this.#handleClientRequest(message);
        this.#client.respond(message.id, result);
      } catch (error) {
        this.#client.respondError(message.id, error);
      } finally {
        this.#clientRequests.delete(message.id);
      }
      return;
    }

    if (!isNotification(message)) {
      return;
    }

    if (message.method === '$/cancelRequest') {
      for (const request of this.#clientRequests.get(message.params?.id) ?? []) {
        request.peer.notify('$/cancelRequest', { id: request.id });
      }
      return;
    }

    if (message.method === 'exit') {
      this.#vue.notify('exit');
      this.#tls.notify('exit');
      this.#onExit(this.#shutdown ? 0 : 1);
      return;
    }

    if (BROADCAST_NOTIFICATIONS.has(message.method)) {
      this.#vue.notify(message.method, message.params);
      this.#tls.notify(message.method, message.params);
      return;
    }

    this.#vue.notify(message.method, message.params);
  }

  async handlePeerMessage(source, message) {
    const peer = source === 'vue' ? this.#vue : this.#tls;

    if (source === 'vue' && isNotification(message) && message.method === 'tsserver/request') {
      await this.#handleTsserverRequest(message.params);
      return;
    }

    if (isRequest(message)) {
      try {
        const result = await this.#client.request(message.method, message.params, {
          timeoutMs: this.#timeoutMs,
        });
        peer.respond(message.id, result);
      } catch (error) {
        peer.respondError(message.id, error);
      }
      return;
    }

    if (isNotification(message)) {
      this.#client.notify(message.method, message.params);
    }
  }

  async #handleClientRequest(message) {
    if (message.method === 'initialize') {
      return this.#initialize(message.id, message.params);
    }
    if (message.method === 'shutdown') {
      this.#shutdown = true;
      await Promise.allSettled([
        this.#requestPeer(this.#vue, message.id, 'shutdown', undefined),
        this.#requestPeer(this.#tls, message.id, 'shutdown', undefined),
      ]);
      return null;
    }

    if (message.method === 'textDocument/hover') {
      const results = await Promise.allSettled([
        this.#requestPeer(this.#vue, message.id, message.method, message.params),
        this.#requestPeer(this.#tls, message.id, message.method, message.params),
      ]);
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value != null) {
          return result.value;
        }
      }
      if (results.some(result => result.status === 'fulfilled')) {
        return null;
      }
      throw results[0].reason;
    }

    const peer = message.method === 'workspace/executeCommand'
      && this.#tlsCommands.has(message.params?.command)
      ? this.#tls
      : this.#vue;
    return this.#requestPeer(peer, message.id, message.method, message.params);
  }

  async #initialize(clientId, params) {
    const configuredPlugins = Array.isArray(params.initializationOptions?.plugins)
      ? params.initializationOptions.plugins
      : [];
    const tlsParams = {
      ...params,
      initializationOptions: {
        ...(params.initializationOptions ?? {}),
        plugins: [
          ...(configuredPlugins.filter(plugin => plugin?.name !== '@vue/typescript-plugin')),
          {
            name: '@vue/typescript-plugin',
            location: this.#pluginLocation,
            languages: ['vue'],
          },
        ],
        tsserver: {
          ...(params.initializationOptions?.tsserver ?? {}),
          path: this.#tsserverPath,
        },
      },
    };

    const tlsResult = await this.#requestPeer(this.#tls, clientId, 'initialize', tlsParams);
    const vueResult = await this.#requestPeer(this.#vue, clientId, 'initialize', params);
    for (const command of tlsResult?.capabilities?.executeCommandProvider?.commands ?? []) {
      this.#tlsCommands.add(command);
    }

    const vueCommands = vueResult?.capabilities?.executeCommandProvider?.commands ?? [];
    const tlsCommands = [...this.#tlsCommands];
    const commands = [...new Set([...vueCommands, ...tlsCommands])];
    if (commands.length === 0) {
      return vueResult;
    }

    return {
      ...vueResult,
      capabilities: {
        ...vueResult.capabilities,
        executeCommandProvider: {
          ...(vueResult.capabilities?.executeCommandProvider ?? {}),
          commands,
        },
      },
    };
  }

  async #requestPeer(peer, clientId, method, params) {
    const requests = this.#clientRequests.get(clientId) ?? new Set();
    this.#clientRequests.set(clientId, requests);
    let request;
    try {
      return await peer.request(method, params, {
        timeoutMs: this.#timeoutMs,
        onId: id => {
          request = { peer, id };
          requests.add(request);
        },
      });
    } finally {
      if (request) {
        requests.delete(request);
      }
    }
  }

  async #handleTsserverRequest(params) {
    // vscode-jsonrpc's string-method overload serializes positional arguments
    // as params. Vue passes one tuple argument, so the wire shape is [[id, command, args]].
    const tuple = Array.isArray(params) && params.length === 1 && Array.isArray(params[0])
      ? params[0]
      : params;
    if (!Array.isArray(tuple) || tuple.length !== 3) {
      this.#logger('Ignoring malformed tsserver/request notification');
      return;
    }

    const [requestId, command, args] = tuple;
    let response = null;
    try {
      const result = await this.#tls.request('workspace/executeCommand', {
        command: 'typescript.tsserverRequest',
        arguments: [command, args],
      }, { timeoutMs: this.#timeoutMs });
      response = unwrapTsserverResponse(result);
    } catch (error) {
      const detail = error instanceof RpcError ? `${error.code}: ${error.message}` : String(error);
      this.#logger(`tsserver/request ${String(command)} failed: ${detail}`);
    } finally {
      // Vue's request is a notification backed by an internal Promise. A response
      // notification is mandatory even when TLS failed, otherwise Vue hangs.
      this.#vue.notify('tsserver/response', [[requestId, response]]);
    }
  }
}
