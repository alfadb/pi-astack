/**
 * model-fallback — 多模型 fallback 链。
 *
 * 初始模型错误时 pi 内建指数退避重试（依 pi settings#retry.maxRetries）；
 * 耗尽后切成下一个已配置的 fallback 模型继续——直到列表里有人成功，或全部
 * 失败。Fallback 模型任一错误直接切（不重试）。
 *
 * 加 "connection lost — " 前缀让 pi 的 retry regex（含 "connection.?lost"）能
 * 命中任意上游错误字面不一致的 case，最典型的是 anthropic.js 抛的
 * "Anthropic stream ended before message_stop"（regex 要的是 "ended
 * without"）。不加前缀则让 pi 跳过 retry 分支（用于 fallback 模型，不重试）。
 *
 * 【为什么 mutation 在 message_end 而不是 agent_end】
 * pi 评估 _isRetryableError 时读 errorMessage 字段。要让它看到加了前缀的
 * 版本，mutation 必须在评估前完成。pi 内部至少有两条评估路径：
 *   1. _willRetryAfterAgentEnd —— 在 agent_end emit 时同步评估，用于设置
 *      event.willRetry 字段。_handleAgentEvent 先 await 跑完所有 extension
 *      handlers（包括 message_end + agent_end），然后才 _emit 这个 willRetry，
 *      所以如果只看这条路径，agent_end handler 里 mutate 也能 affect。
 *   2. _handlePostAgentRun —— 在 agent.prompt() resolve 后 async 跑，读
 *      _lastAssistantMessage.errorMessage 决定是否 retry。这是实际触发
 *      retry 的路径，也读的是 message_end 时记录的那个引用。
 *
 * message_end 必然在 agent_end 之前 emit，两条路径都看到 mutated 版本。
 * 历史上有过一段 agent_end handler 里的"防御式 mutation"代码，但 message_end
 * 已经做了 mutation——agent_end 再 mutate 是 idempotent no-op，2026-05-21
 * 清理掉。老版 pi (含 _createRetryPromiseForAgentEnd 同步评估) 那条描述
 * 现在也不存在了，新版走的是上面两条 async 路径。
 *
 * agent_end handler 保留：
 *   - consecutiveErrors 计数（每次 pi retry 失败都 emit 新 agent_end，累加）
 *   - fallback 调度（到达 piMaxRetries+1 阈值后切下一个模型）
 *
 * 扩展自动读取 pi settings.json#retry.maxRetries，对齐 give-up 节点。
 * 旧名 retry-stream-eof → retry-all-errors。
 *
 * 【sub-agent 政策（ADR 0027 PR-B + 2026-05-28 修复）】
 * sub-agent（in-process via dispatch_agent / dispatch_parallel，由
 * isSubAgentSession(ctx) 识别）以及老式 sub-pi（subprocess 设了
 * PI_ABRAIN_DISABLED=1）的行为是：
 *   ✓ 允许 prefix injection → pi 内置 retry 命中、单 model 重试 maxRetries 次
 *   ✗ 不参与 fallback chain 切模型（caller 显式指定了 model，不能私自换）
 *   ✗ 不参与 fallback state machine（consecutiveErrors / isOnFallback /
 *     canaryLog / pre-flight check 全部跳过）
 *
 * 这条策略由用户 directive 锁定（2026-05-28）：
 *   「sub_agent 要允许重试，不允许切换模型」
 *
 * 实现上由 Handler A（轻量 prefix-only handler）跑在 sub-agent 路径，
 * Handler B（完整 main pi handler）+ agent_end fallback handler 都在
 * sub-agent context 内 opt-out。
 *
 * 历史 regression（已修）：ADR 0027 PR-B 重构 sub-agent 为 in-process 后，
 * Handler A 第一行误加了 `if (isSubAgentSession(ctx)) return;`，导致
 * in-process sub-agent 既不切模型 **也不加 prefix**，pi 的 retry regex 漏判
 * "upstream stream disconnected" / "stream_read_error" / "unexpected EOF" 等
 * 错误 → sub-agent 单 model 也不 retry → dispatch_parallel 单 task 静默失败。
 * 2026-05-28 修复：把 guard 反转为 "只 main pi return"，sub-agent 与
 * legacy sub-pi 共享 prefix injection 路径。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai/compat";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { isSubAgentBoundaryUntrusted, getSubAgentBoundaryUntrustedDiagnostic, isSubAgentSession } from "../_shared/pi-internals";
import {
	formatLocalIsoTimestamp,
	legacyModelFallbackCanaryPath,
	legacyRetryStreamEofPath,
	ensureProjectGitignoredOnce,
	modelFallbackCanaryPath,
	modelFallbackDir,
} from "../_shared/runtime";

// ── Constants ─────────────────────────────────────────────────

const RETRYABLE_PREFIX = "connection lost — ";

const PI_STACK_SETTINGS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"pi-astack-settings.json",
);

/** Pi's global settings file — read to auto-detect retry.maxRetries. */
const PI_SETTINGS_PATH = path.join(
	os.homedir(),
	".pi",
	"agent",
	"settings.json",
);

/** Fallback when pi settings.json is missing or has no retry.maxRetries. */
const PI_DEFAULT_MAX_RETRIES = 3;

function loadPiMaxRetries(): number {
	try {
		const raw = JSON.parse(
			fs.readFileSync(PI_SETTINGS_PATH, "utf-8"),
		) as Record<string, unknown>;
		const retry = raw.retry as Record<string, unknown> | undefined;
		if (retry && typeof retry.maxRetries === "number" && retry.maxRetries > 0) {
			return Math.floor(retry.maxRetries);
		}
	} catch {
		/* missing/invalid file — use default */
	}
	return PI_DEFAULT_MAX_RETRIES;
}

/**
 * canary.log location
 *
 * Was `~/.pi-extensions/model-fallback.log` (home-level, single file across
 * all projects). Moved 2026-05-09 to `<projectRoot>/.pi-astack/model-fallback/
 * canary.log` to align with all other pi-astack modules
 * (sediment / memory / compaction-tuner / imagine all live under
 * `<projectRoot>/.pi-astack/<module>/`).
 *
 * Trade-off accepted with the move: cross-project failure patterns are now
 * spread across N project log files instead of one global log. Per-project
 * isolation matches the pi-astack convention and makes `rm -rf .pi-astack/`
 * a clean way to forget all derived state for one project. If a future
 * cross-project view is needed, it can be assembled by globbing
 * `~/<project>/.pi-astack/model-fallback/canary.log` (the literal glob
 * pattern would close this block comment, so it is rendered with a
 * placeholder); the canonical sink stays project-scoped.
 *
 * Legacy files at `~/.pi-extensions/{model-fallback,retry-stream-eof}.log`
 * are NOT auto-migrated (cannot attribute history to a single project).
 * They remain on disk after this change and can be deleted by hand.
 */
const CANARY_LOG_MAX_BYTES = 512 * 1024;

/** Delay after pi's give-up logic before we switch model + trigger continuation. */
const FALLBACK_TRIGGER_DELAY_MS = 100;

// ── Config loading ────────────────────────────────────────────

interface ModelFallbackConfig {
	fallbackModels: string[];
}

function loadConfig(): ModelFallbackConfig {
	try {
		const raw = JSON.parse(
			fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"),
		) as Record<string, unknown>;
		const cfg = (raw.modelFallback as Record<string, unknown> | undefined) ?? {};
		const fallbackModels = Array.isArray(cfg.fallbackModels)
			? (cfg.fallbackModels as unknown[]).filter(
				(x): x is string => typeof x === "string" && x.includes("/"),
			)
			: [];
		return { fallbackModels };
	} catch {
		return { fallbackModels: [] };
	}
}

// ── Canary log (best-effort) ──────────────────────────────────

/**
 * Append a line to `<projectRoot>/.pi-astack/model-fallback/canary.log`.
 * Best-effort: any IO error is swallowed (fallback policy still runs).
 *
 * `projectRoot` is required — caller must resolve from `ctx.cwd` (or
 * `process.cwd()` when ctx is unavailable). The path is rebuilt every call
 * so cwd changes within a long-running pi process route to the right
 * project's log.
 */
function canaryLog(projectRoot: string, line: string): void {
	try {
		const dir = modelFallbackDir(projectRoot);
		const file = modelFallbackCanaryPath(projectRoot);
		fs.mkdirSync(dir, { recursive: true });
		// Round 9 P0 (sonnet R9-5 fix): ensure .pi-astack/ gitignored.
		// Canary log holds errorMessage snippets that may echo provider
		// request body — same exfil risk if accidentally committed.
		// Fire-and-forget (async): the canary writer is sync but the
		// gitignore check is async; not awaiting is OK because it's
		// idempotent + cached + best-effort.
		void ensureProjectGitignoredOnce(projectRoot).catch(() => { /* best-effort */ });
		try {
			const stat = fs.statSync(file);
			if (stat.size > CANARY_LOG_MAX_BYTES) fs.unlinkSync(file);
		} catch {
			/* file doesn't exist */
		}
		fs.appendFileSync(file, `${formatLocalIsoTimestamp()} ${line}\n`);
	} catch {
		/* best-effort */
	}
}

/**
 * One-time noop check: at extension load, if the legacy home-level log files
 * still exist, log a one-line breadcrumb to the new location so the user
 * can find them on inspection. We do NOT auto-delete — those files may
 * contain history from before this migration that is worth keeping.
 */
function noteLegacyLogsIfPresent(projectRoot: string): void {
	try {
		const home = os.homedir();
		const legacy = [
			legacyModelFallbackCanaryPath(home),
			legacyRetryStreamEofPath(home),
		];
		const existing = legacy.filter((p) => {
			try { fs.statSync(p); return true; } catch { return false; }
		});
		if (existing.length > 0) {
			canaryLog(
				projectRoot,
				`legacy-logs-still-on-disk count=${existing.length} paths=[${existing.join(",")}] (safe to rm by hand)`,
			);
		}
	} catch {
		/* best-effort */
	}
}

// ── Helpers ───────────────────────────────────────────────────

function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

function parseEntry(entry: string): { provider: string; id: string } | undefined {
	const idx = entry.indexOf("/");
	if (idx <= 0 || idx >= entry.length - 1) return undefined;
	return { provider: entry.slice(0, idx), id: entry.slice(idx + 1) };
}

// ── Extension entry ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ═══════════════════════════════════════════════════════════════════
	// Handler A — lightweight retry prefix injection (message_end).
	// Runs in:
	//   - in-process sub-agent (isSubAgentSession(ctx) === true, ADR 0027 PR-B)
	//   - legacy subprocess sub-pi (PI_ABRAIN_DISABLED === "1")
	// Skipped in main pi — Handler B below covers main with full state machine.
	// ═══════════════════════════════════════════════════════════════════
	//
	// What this handler does: ONLY adds the "connection lost — " prefix
	// to errorMessage so pi's built-in retry regex (`connection.?lost`)
	// matches provider-specific error strings that would otherwise be
	// missed (e.g., anthropic "stream ended before message_stop", gateway
	// "upstream stream disconnected: unexpected EOF" from sub2api SSE
	// error frames, etc.). Pi's built-in retry is always active in
	// sub-agent contexts (reads settings.json#retry.maxRetries, currently
	// 9), but without this prefix injection some transient errors fail
	// the regex check and skip retry entirely — making dispatch sub-agents
	// silently die on transient network blips.
	//
	// What this handler does NOT do (per user directive 2026-05-28
	// "sub_agent 要允许重试，不允许切换模型"):
	//   - NOT participate in fallback chain (model switching) — Handler B
	//     + agent_end handler stay opt-out for sub-agent.
	//   - NOT manage consecutiveErrors / isOnFallback / canaryLog / etc.
	//
	// In main pi, this handler returns early; Handler B (below) covers
	// main with full state machine. Handler A and B both add the same
	// prefix, and Handler B uses startsWith(RETRYABLE_PREFIX) guard, so
	// the prefix is idempotent across handlers.
	pi.on("message_end", (event, ctx?: any) => {
		if (isSubAgentBoundaryUntrusted()) return;
		const isSub = isSubAgentSession(ctx);
		const isLegacySubPi = process.env.PI_ABRAIN_DISABLED === "1";
		// Main pi (neither sub-agent nor legacy sub-pi) → defer to Handler B.
		if (!isSub && !isLegacySubPi) return;

		if (event.message.role !== "assistant") return;
		const msg = event.message as { stopReason?: string; errorMessage?: string };
		if (msg.stopReason !== "error" || !msg.errorMessage) return;
		if (!msg.errorMessage.startsWith(RETRYABLE_PREFIX)) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
		}
	});

	// ── Sub-pi guard (model switching disabled in sub-pi) ──────────
	// Sub-pi guard (2026-05-14 audit): dispatch sub-agents set
	// PI_ABRAIN_DISABLED=1. model-fallback must not fire inside sub-pi
	// — it would silently switch the sub-agent's model instead of
	// failing fast and letting the parent handle the error.
	if (process.env.PI_ABRAIN_DISABLED === "1") return;

	// ═══════════════════════════════════════════════════════════════════
	// P2 fix (R6 audit): pre-flight check on model-fallback candidates.
	// model-curator may have removed fallback models from the registry
	// via its provider whitelist. Warn on session_start so the user
	// knows before an error hits that their fallback chain is broken.
	// ═══════════════════════════════════════════════════════════════════
	{
		const config = loadConfig();
		if (config.fallbackModels?.length) {
			pi.on("session_start", async (_event, ctx) => {
				if (isSubAgentBoundaryUntrusted()) {
					const diagnostic = getSubAgentBoundaryUntrustedDiagnostic();
					const projectRoot = path.resolve(ctx?.cwd || process.cwd());
					console.error(`[model-fallback] sub-agent boundary untrusted; blocked session_start preflight (${diagnostic?.reason ?? "unknown"})`);
					canaryLog(projectRoot, `blocked session_start reason=subagent_boundary_untrusted detail=${diagnostic?.reason ?? "unknown"}`);
					try { ctx.ui?.notify?.("model-fallback: sub-agent boundary untrusted; fallback preflight disabled", "error"); } catch { /* best-effort */ }
					return;
				}

				// ADR 0027 PR-B: skip pre-flight in sub-agent (parent already
				// validated the model + sub-agent uses an explicit dispatched
				// model, not the fallback chain).
				if (isSubAgentSession(ctx)) return;

				try {
					const reg = ctx.modelRegistry;
					if (!reg) return;
					const available: Array<{ provider: string; id: string }> =
						(typeof reg.getAvailable === "function" ? reg.getAvailable() : null) ??
						(typeof reg.getAll === "function" ? reg.getAll() : []) ??
						[];
					const availableIds = new Set(available.map((m) => `${m.provider}/${m.id}`));
					for (const entry of config.fallbackModels!) {
						if (!availableIds.has(entry)) {
							console.error(
								`[model-fallback] WARN: fallback model "${entry}" not in registry — ` +
								`may have been removed by model-curator whitelist`,
							);
							try {
								ctx.ui?.notify?.(
									`model-fallback: "${entry}" absent from registry (check modelCurator.providers whitelist)`,
									"warning",
								);
							} catch { /* best-effort */ }
						}
					}
				} catch { /* best-effort */ }
			});
		}
	}

	const config = loadConfig();
	// Auto-detect pi's retry budget so we always align the give-up node.
	const piMaxRetries = loadPiMaxRetries();
	// Initial model: 1 + piMaxRetries attempts before we switch (= pi's give-up node).
	const initialErrorThreshold = piMaxRetries + 1;
	// Fallback models: any error → switch immediately.
	const fallbackErrorThreshold = 1;

	// Per-session state. Each pi process loads this module once.
	let consecutiveErrors = 0;
	let isOnFallback = false; // true after we've switched at least once on this turn
	const tried = new Set<string>(); // keys: "provider/id"
	let fallbackInFlight = false;

	// resetState() may be called from contexts where we don't have an
	// extension ctx (e.g., on a fallback's success after switching). In
	// those cases we use process.cwd() at the moment of reset; for a
	// long-running pi this is the same as the active project's cwd.
	const resetState = () => {
		if (
			consecutiveErrors !== 0 ||
			tried.size !== 0 ||
			fallbackInFlight ||
			isOnFallback
		) {
			canaryLog(
				path.resolve(process.cwd()),
				`reset consecutiveErrors=${consecutiveErrors} tried=[${[...tried].join(",")}] isOnFallback=${isOnFallback} fallbackInFlight=${fallbackInFlight}`,
			);
		}
		consecutiveErrors = 0;
		isOnFallback = false;
		tried.clear();
		fallbackInFlight = false;
	};

	// At extension activation, surface a one-time pointer to legacy log
	// files so they don't get forgotten on disk.
	noteLegacyLogsIfPresent(path.resolve(process.cwd()));

	// message_end handler —— 主要有两件事：
	//   1. 成功 assistant message 重置 fallback state
	//   2. 错误 assistant message 在这里提前处理 retry prefix mutation
	//      —— 必须在 agent_end 同步评估之前完成（详见文件头注释）。
	// 保持 sync handler——不能加 async，否则 await listener 会意外延迟。
	pi.on("message_end", (event, ctx: any) => {
		if (isSubAgentBoundaryUntrusted()) {
			const diagnostic = getSubAgentBoundaryUntrustedDiagnostic();
			const projectRoot = path.resolve(ctx?.cwd || process.cwd());
			console.error(`[model-fallback] sub-agent boundary untrusted; blocked message_end state mutation (${diagnostic?.reason ?? "unknown"})`);
			canaryLog(projectRoot, `blocked message_end reason=subagent_boundary_untrusted detail=${diagnostic?.reason ?? "unknown"}`);
			return;
		}

		// ADR 0027 PR-B: sub-agent must not trigger fallback chain switching.
		if (isSubAgentSession(ctx)) return;

		if (event.message.role !== "assistant") return;
		const msg = event.message as { stopReason?: string; errorMessage?: string };

		if (msg.stopReason !== "error") {
			resetState();
			return;
		}

		// Error path: 提前 mutation。只在初始模型阶段加前缀——fallback 阶段不
		// 加前缀，让 pi 看到不可 retry 错误、跳过重试分支，交给 agent_end
		// 的 fallback 逻辑决定是否切下一个模型。
		if (
			!isOnFallback &&
			msg.errorMessage &&
			!msg.errorMessage.startsWith(RETRYABLE_PREFIX)
		) {
			msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage;
			const projectRoot = path.resolve(ctx?.cwd || process.cwd());
			canaryLog(
				projectRoot,
				`mutated@message_end errorMessage="${msg.errorMessage.slice(0, 200).replace(/[\r\n]+/g, " ")}"`,
			);
		}
	});

	pi.on("agent_end", async (event, ctx: any) => {
		// Resolve projectRoot once per agent_end — reused by every canaryLog
		// call below (including the deferred setTimeout closure).
		const projectRoot = path.resolve(ctx?.cwd || process.cwd());

		if (isSubAgentBoundaryUntrusted()) {
			const diagnostic = getSubAgentBoundaryUntrustedDiagnostic();
			console.error(`[model-fallback] sub-agent boundary untrusted; blocked agent_end fallback state machine (${diagnostic?.reason ?? "unknown"})`);
			canaryLog(projectRoot, `blocked agent_end reason=subagent_boundary_untrusted detail=${diagnostic?.reason ?? "unknown"}`);
			try { ctx.ui?.notify?.("model-fallback: sub-agent boundary untrusted; fallback switching disabled", "error"); } catch { /* best-effort */ }
			return;
		}

		// ADR 0027 PR-B: sub-agent does not participate in main-session
		// fallback state machine / canary logging. Fail-fast back to parent.
		if (isSubAgentSession(ctx)) return;

		// Find last assistant message in the turn's messages.
		let last: (typeof event.messages)[number] | undefined;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (event.messages[i].role === "assistant") {
				last = event.messages[i];
				break;
			}
		}
		if (!last) return;

		const msg = last as { stopReason?: string; errorMessage?: string };
		if (msg.stopReason !== "error" || !msg.errorMessage) {
			// Successful turn — message_end handler already reset state, but be defensive.
			resetState();
			return;
		}

		consecutiveErrors++;

		// Policy:
		//   - Initial model: message_end already prefixed → pi auto-retries; we
		//     switch only after pi exhausts its retries (consecutiveErrors >=
		//     piMaxRetries + 1 = pi's give-up node).
		//   - Fallback model: message_end did NOT prefix → pi skipped its retry
		//     branch; we switch on the very first error (threshold = 1).
		const threshold = isOnFallback ? fallbackErrorThreshold : initialErrorThreshold;

		// No mutation here — message_end has already done it (or deliberately
		// skipped it for fallback models). The historical "defensive mutation"
		// block here was idempotent no-op in the normal path and was removed
		// 2026-05-21 along with the obsolete _createRetryPromiseForAgentEnd
		// race description in the file header.
		canaryLog(
			projectRoot,
			`agent_end error consecutiveErrors=${consecutiveErrors}/${threshold} isOnFallback=${isOnFallback} errorMessage="${msg.errorMessage.slice(0, 80).replace(/[\r\n]+/g, " ")}"`,
		);

		// Trigger our fallback once we hit the per-role threshold. Guarded by
		// fallbackInFlight to avoid double-fire if agent_end is emitted twice.
		if (consecutiveErrors < threshold || fallbackInFlight) return;

		if (config.fallbackModels.length === 0) {
			// No fallback configured → retry-only behavior, no model switching.
			canaryLog(projectRoot, "fallback-disabled (no fallbackModels configured)");
			return;
		}

		const currentModel = ctx.model;
		if (!currentModel) {
			canaryLog(projectRoot, "fallback-skip (ctx.model undefined)");
			return;
		}

		// Mark current as tried so we never re-pick it.
		tried.add(modelKey(currentModel));

		// Find next configured model that's NOT tried, exists in registry, and has auth.
		let next: Model<any> | undefined;
		for (const entry of config.fallbackModels) {
			if (tried.has(entry)) continue;
			const parsed = parseEntry(entry);
			if (!parsed) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`model-fallback: invalid fallback entry "${entry}" (expected "provider/modelId")`,
					"warning",
				);
				continue;
			}
			const candidate = ctx.modelRegistry.find(parsed.provider, parsed.id) as
				| Model<any>
				| undefined;
			if (!candidate) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`model-fallback: model "${entry}" not in registry — skipping`,
					"warning",
				);
				continue;
			}
			if (!ctx.modelRegistry.hasConfiguredAuth(candidate)) {
				tried.add(entry);
				ctx.ui?.notify?.(
					`model-fallback: no auth configured for "${entry}" — skipping`,
					"warning",
				);
				continue;
			}
			tried.add(entry);
			next = candidate;
			break;
		}

		if (!next) {
			ctx.ui?.notify?.(
				`model-fallback: all ${tried.size} fallback model(s) exhausted — giving up`,
				"error",
			);
			canaryLog(projectRoot, `fallback-exhausted tried=[${[...tried].join(",")}]`);
			resetState();
			return;
		}

		const fromKey = modelKey(currentModel);
		const nextKey = modelKey(next);

		// Reset per-model error counter for the new model.
		consecutiveErrors = 0;
		fallbackInFlight = true;
		// Mark that we've left the initial model — every subsequent error switches.
		const becameFallback = !isOnFallback;

		// Defer to AFTER pi's _handleRetryableError finishes its give-up branch
		// (auto_retry_end success=false, _retryAttempt reset to 0). Otherwise our
		// sendMessage/setModel would race with pi's retry teardown.
		setTimeout(async () => {
			try {
				const ok = await pi.setModel(next as Model<any>);
				if (!ok) {
					ctx.ui?.notify?.(
						`model-fallback: setModel("${nextKey}") returned false — fallback aborted`,
						"error",
					);
					canaryLog(projectRoot, `fallback-setModel-failed model=${nextKey}`);
					fallbackInFlight = false;
					return;
				}

				isOnFallback = true;
				canaryLog(
					projectRoot,
					`fallback-switched from=${fromKey} to=${nextKey} role=${becameFallback ? "initial->fallback" : "fallback->fallback"}`,
				);
				ctx.ui?.notify?.(`Falling back: ${fromKey} → ${nextKey}`, "info");

				// Inject a custom message + trigger a new agent turn on the new model.
				// custom messages are converted to user messages in LLM context
				// (see pi-coding-agent/dist/core/messages.js convertToLlm), so the new
				// model gets explicit context that we just switched.
				const priorAttempts = becameFallback
					? `${initialErrorThreshold} attempts (1 initial + ${piMaxRetries} retries)`
					: `1 attempt (no retries on fallback models)`;
				pi.sendMessage(
					{
						customType: "model-fallback",
						content:
							`[model-fallback] Previous model ${fromKey} failed after ${priorAttempts}. ` +
							`Switched to ${nextKey}. Please continue the task from where the failed turn left off.`,
						display: true,
						details: {
							from: fromKey,
							to: nextKey,
							priorAttempts: becameFallback ? initialErrorThreshold : 1,
							role: becameFallback ? "initial->fallback" : "fallback->fallback",
							triedSoFar: [...tried],
						},
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				canaryLog(projectRoot, `fallback-error ${msg}`);
				ctx.ui?.notify?.(
					`model-fallback: fallback failed: ${msg}`,
					"error",
				);
				fallbackInFlight = false;
			}
			// fallbackInFlight stays true until success or error; reset by
			// resetState() (on next successful response) or above on failure.
		}, FALLBACK_TRIGGER_DELAY_MS);
	});
}
