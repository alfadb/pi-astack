import { EventEmitter } from 'node:events';

export const JSON_RPC_VERSION = '2.0';

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

export class LspFramer extends EventEmitter {
  #buffer = Buffer.alloc(0);
  #contentLength = null;

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      chunk = Buffer.from(chunk);
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    while (true) {
      if (this.#contentLength === null) {
        const headerEnd = this.#buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          return;
        }
        const header = this.#buffer.subarray(0, headerEnd).toString('ascii');
        this.#buffer = this.#buffer.subarray(headerEnd + 4);
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
        if (!match) {
          this.emit('error', new Error('LSP frame is missing Content-Length'));
          continue;
        }
        this.#contentLength = Number(match[1]);
      }

      if (this.#buffer.length < this.#contentLength) {
        return;
      }

      const body = this.#buffer.subarray(0, this.#contentLength);
      this.#buffer = this.#buffer.subarray(this.#contentLength);
      this.#contentLength = null;
      try {
        this.emit('message', JSON.parse(body.toString('utf8')));
      } catch (error) {
        this.emit('error', new Error(`Invalid JSON-RPC payload: ${error.message}`));
      }
    }
  }
}

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);
}

export function toRpcError(error) {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data === undefined ? {} : { data: error.data }),
    };
  }
  return {
    code: -32603,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class RpcEndpoint extends EventEmitter {
  #reader;
  #writer;
  #framer = new LspFramer();
  #pending = new Map();
  #nextId = 1;
  #idPrefix;
  #defaultTimeoutMs;
  #closed = false;

  constructor({ reader, writer, idPrefix, timeoutMs = 30_000 }) {
    super();
    this.#reader = reader;
    this.#writer = writer;
    this.#idPrefix = idPrefix;
    this.#defaultTimeoutMs = timeoutMs;

    this.#framer.on('message', message => this.#onMessage(message));
    this.#framer.on('error', error => this.emit('protocolError', error));
    reader.on('data', chunk => this.#framer.push(chunk));
    reader.on('error', error => this.close(error));
    reader.on('end', () => this.close(new Error(`${idPrefix} input ended`)));
    writer.on('error', error => this.close(error));
  }

  get closed() {
    return this.#closed;
  }

  request(method, params, options = {}) {
    if (this.#closed) {
      return Promise.reject(new RpcError(-32097, `${this.#idPrefix} is closed`));
    }
    const id = `${this.#idPrefix}:${this.#nextId++}`;
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    options.onId?.(id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.notify('$/cancelRequest', { id });
        reject(new RpcError(-32001, `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      this.send({ jsonrpc: JSON_RPC_VERSION, id, method, params });
    });
  }

  notify(method, params) {
    if (!this.#closed) {
      this.send({ jsonrpc: JSON_RPC_VERSION, method, params });
    }
  }

  respond(id, result) {
    if (!this.#closed) {
      this.send({ jsonrpc: JSON_RPC_VERSION, id, result });
    }
  }

  respondError(id, error) {
    if (!this.#closed) {
      this.send({ jsonrpc: JSON_RPC_VERSION, id, error: toRpcError(error) });
    }
  }

  send(message) {
    this.#writer.write(encodeMessage(message));
  }

  close(cause = new Error(`${this.#idPrefix} closed`)) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.#pending.clear();
    this.emit('close', cause);
  }

  #onMessage(message) {
    if (message && Object.hasOwn(message, 'id') && !Object.hasOwn(message, 'method')) {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        this.emit('orphanResponse', message);
        return;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    this.emit('message', message);
  }
}
