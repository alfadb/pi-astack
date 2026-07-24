# pi Vue LSP bridge

A local stdio LSP server for `pi-lsp`. It runs Vue Language Server in hybrid mode beside TypeScript Language Server and hides their private coordination protocol behind one standard LSP connection.

The package resolves Vue, the Vue TypeScript plugin, and TypeScript 6 from its own dependency tree. It does not inspect or depend on a project's `node_modules` for those tools and does not alter the global TypeScript installation.

## Run

```bash
~/.pi/agent/skills/pi-astack/tools/vue-lsp-bridge/bin/pi-vue-lsp-bridge.js --stdio
```

`PI_VUE_LSP_TIMEOUT_MS` or `--timeout=<milliseconds>` changes the default 30 second internal request timeout. Protocol output is written only to stdout; child-server logs go to stderr.

## Verify

```bash
npm --prefix ~/.pi/agent/skills/pi-astack/tools/vue-lsp-bridge test
npm --prefix ~/.pi/agent/skills/pi-astack/tools/vue-lsp-bridge run smoke
```

The smoke test defaults to `/home/worker/work/base/sub2api/frontend/src/App.vue`. Set `PI_VUE_LSP_SMOKE_ROOT` to exercise another real Vue project with `src/App.vue`.

## Protocol

The Vue 3.3.8 server emits `tsserver/request` notifications with the wire-level params shape `[[id, command, args]]`. The bridge executes `typescript.tsserverRequest` through TypeScript Language Server 5.3.0, unwraps only the tsserver response envelope, and always returns `tsserver/response` as `[[id, body]]`. Errors and timeouts return a null body so Vue never retains an unresolved request.

`didOpen`, `didChange`, and `didClose` notifications are sent unchanged to both peers. Vue-specific features are served by Vue Language Server; script hover falls back to the TypeScript peer. Diagnostics from both peers are forwarded to the client.
