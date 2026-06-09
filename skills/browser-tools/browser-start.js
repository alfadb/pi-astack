#!/usr/bin/env node

// Launch the CloakBrowser stealth Chromium with CDP on :9333 (BROWSER_TOOLS_PORT).
// NOTE: a separate vanilla Chrome may already squat :9222 on this host, so
// browser-tools uses its own dedicated port to keep the stealth backend isolated.
//
// Backend: cloakbrowser (https://github.com/CloakHQ/CloakBrowser) — a Chromium
// binary with 58 source-level C++ fingerprint patches. Because the patches are
// compiled into the binary, all stealth properties apply automatically over CDP,
// so the other browser-*.js scripts connect to the same port unchanged.
//
// Model: this script ensures the stealth binary is present, then spawns it
// DETACHED so the browser survives after this process exits. Subsequent
// browser-nav / browser-eval / ... invocations connect via puppeteer-core.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { ensureBinary, getDefaultStealthArgs, binaryInfo } from "cloakbrowser";

const argv = process.argv.slice(2);
const headed = argv.includes("--headed") || argv.includes("--display");
const help = argv.includes("--help") || argv.includes("-h");

if (help) {
	console.log("Usage: browser-start.js [--headed]");
	console.log("\nOptions:");
	console.log("  --headed   Render to a visible X display (VNC) instead of headless.");
	console.log("             Uses $DISPLAY, falling back to :1 (the TigerVNC display).");
	console.log("\nLaunched detached on CDP port :9333 (override with $BROWSER_TOOLS_PORT),");
	console.log("persistent profile ~/.cache/browser-tools, so logins survive restarts.");
	process.exit(0);
}

const PORT = Number(process.env.BROWSER_TOOLS_PORT) || 9333;
const PROFILE_DIR = path.join(os.homedir(), ".cache", "browser-tools");
const BROWSER_URL = `http://localhost:${PORT}`;

// Already running? Reuse it.
try {
	const b = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
	await b.disconnect();
	console.log(`✓ CloakBrowser already running on :${PORT}`);
	process.exit(0);
} catch {}

// Ensure profile dir; clear stale singleton locks so a new instance can start.
fs.mkdirSync(PROFILE_DIR, { recursive: true });
for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
	try {
		fs.rmSync(path.join(PROFILE_DIR, name), { force: true });
	} catch {}
}

// Download the stealth Chromium binary on first run (~200MB, cached in ~/.cloakbrowser).
const info = binaryInfo();
if (!info.installed) {
	console.log(`Downloading CloakBrowser stealth Chromium ${info.version} (~200MB, one-time)...`);
}
const executablePath = await ensureBinary();

// stealth defaults (--no-sandbox, --fingerprint=<seed>, --fingerprint-platform=windows)
const args = [
	...getDefaultStealthArgs(),
	`--remote-debugging-port=${PORT}`,
	`--user-data-dir=${PROFILE_DIR}`,
	"--no-first-run",
	"--no-default-browser-check",
];

const env = { ...process.env };
if (headed) {
	// Render to the VNC X display on POSIX. On Windows, headed mode uses the
	// native desktop and DISPLAY is not meaningful.
	if (process.platform !== "win32") env.DISPLAY = process.env.DISPLAY || ":1";
	args.push("--ignore-gpu-blocklist");
} else {
	args.push("--headless=new");
}

spawn(executablePath, args, { detached: true, stdio: "ignore", env }).unref();

// Wait for CDP to come up.
let connected = false;
for (let i = 0; i < 40; i++) {
	try {
		const b = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null });
		await b.disconnect();
		connected = true;
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 500));
	}
}

if (!connected) {
	console.error(`✗ Failed to connect to CloakBrowser on :${PORT}`);
	process.exit(1);
}

const displayLabel = process.platform === "win32" ? "native desktop" : env.DISPLAY;
console.log(
	`✓ CloakBrowser started on :${PORT} (${headed ? `headed on ${displayLabel}` : "headless"}, profile: ${PROFILE_DIR})`,
);
