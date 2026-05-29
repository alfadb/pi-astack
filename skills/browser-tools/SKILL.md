---
name: browser-tools
description: Interactive browser automation via Chrome DevTools Protocol, backed by CloakBrowser stealth Chromium. Use to interact with web pages, test frontends, scrape JS-rendered/anti-bot-protected sites, or when visible browser interaction (over VNC) is needed.
---

# Browser Tools

CDP automation tools backed by **CloakBrowser** — a Chromium binary with 58
source-level C++ fingerprint patches (`github.com/CloakHQ/CloakBrowser`). Because
the patches are compiled into the binary, all stealth properties (`navigator.webdriver=false`,
real plugin list, spoofed Windows UA/GPU/canvas/WebGL, `window.chrome` present)
apply automatically over CDP — the connect scripts below stay vanilla `puppeteer-core`.

The browser runs detached on CDP port **9333** (override with `BROWSER_TOOLS_PORT`;
9333 avoids the vanilla Chrome that may squat :9222 on this host).

## Setup

Run once before first use:

```bash
cd {baseDir}
npm install
```

First `browser-start.js` downloads the stealth Chromium binary (~200MB, cached in
`~/.cloakbrowser`, SHA-256 verified). You do NOT need `playwright install`.

## Start

```bash
{baseDir}/browser-start.js            # headless (default)
{baseDir}/browser-start.js --headed   # render to the VNC X display ($DISPLAY, else :1)
```

Launches the stealth browser detached on `:9333` with a **persistent profile**
(`~/.cache/browser-tools`), so cookies/logins survive restarts. Re-running is a
no-op if it's already up. Use `--headed` when you need to watch/interact via VNC
(required for `browser-pick.js`); headless has no display.

> Stealth fingerprint patches work over CDP, but CloakBrowser's `humanize` (bezier
> mouse / human typing) is a wrapper-level feature and is NOT active for these raw-CDP
> scripts. The eval/DOM workflow below doesn't need it.

## Navigate

```bash
{baseDir}/browser-nav.js https://example.com
{baseDir}/browser-nav.js https://example.com --new      # open in a new tab
{baseDir}/browser-nav.js https://example.com --reload   # navigate + force reload
```

## Evaluate JavaScript

```bash
{baseDir}/browser-eval.js 'document.title'
{baseDir}/browser-eval.js 'document.querySelectorAll("a").length'
```

Runs JS in the active tab (async context). Use to extract data, inspect state, or
drive the DOM programmatically.

## Screenshot

```bash
{baseDir}/browser-screenshot.js
```

Capture the current viewport; returns a temp file path.

## Pick Elements (headed only)

```bash
{baseDir}/browser-pick.js "Click the submit button"
```

Interactive picker — the user clicks elements (Cmd/Ctrl+Click for multiple, Enter
to finish) and the tool returns CSS selectors. **Requires `--headed`** (a visible
VNC display); it does nothing headless.

## Cookies

```bash
{baseDir}/browser-cookies.js
```

Dump all cookies for the current tab (domain, path, httpOnly, secure). Useful for
debugging auth/session state.

## Extract Page Content

```bash
{baseDir}/browser-content.js https://example.com
```

Navigate and extract readable content as markdown (Mozilla Readability + Turndown).
Waits for JS to load — works on dynamic pages and, via the stealth backend, on many
anti-bot-protected sites.

## When to Use

- Testing frontend code in a real browser
- Pages that require JavaScript / dynamic content
- Sites with bot detection (reCAPTCHA v3 / Cloudflare Turnstile / FingerprintJS)
  where vanilla Playwright/Puppeteer gets blocked
- When the user needs to visually see or interact with a page (over VNC)
- Debugging authentication or session issues

CloakBrowser does NOT solve CAPTCHAs (it prevents them appearing) and has no built-in
proxy rotation — bring your own proxy via env/args if a site needs it.

---

## Efficiency Guide

### DOM Inspection Over Screenshots

**Don't** screenshot to read page state. **Do** parse the DOM:

```javascript
// Get page structure
document.body.innerHTML.slice(0, 5000)

// Find interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map(e => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className
}))
```

### Complex Scripts in Single Calls

Wrap multi-statement code in an IIFE:

```javascript
(function() {
  const data = document.querySelector('#target').textContent;
  const buttons = document.querySelectorAll('button');
  buttons[0].click();
  return JSON.stringify({ data, buttonCount: buttons.length });
})()
```

### Batch Interactions

```javascript
(function() {
  const actions = ["btn1", "btn2", "btn3"];
  actions.forEach(id => document.getElementById(id).click());
  return "Done";
})()
```

### Reading App/Game State

```javascript
(function() {
  const state = {
    score: document.querySelector('.score')?.textContent,
    status: document.querySelector('.status')?.className,
    items: Array.from(document.querySelectorAll('.item')).map(el => ({
      text: el.textContent,
      active: el.classList.contains('active')
    }))
  };
  return JSON.stringify(state, null, 2);
})()
```

### Waiting for Updates

If the DOM updates after an action, add a small delay:

```bash
sleep 0.5 && {baseDir}/browser-eval.js '...'
```

### Investigate Before Interacting

```javascript
(function() {
  return {
    title: document.title,
    forms: document.forms.length,
    buttons: document.querySelectorAll('button').length,
    inputs: document.querySelectorAll('input').length,
    mainContent: document.body.innerHTML.slice(0, 3000)
  };
})()
```
