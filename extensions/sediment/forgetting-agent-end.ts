import { isForgettingExecutorRealApplyEnabled, type MemorySettings } from "../memory/settings";
import type { MemoryEntry } from "../memory/types";
import {
  runForgettingExecutor,
  type ArchiveEntryFn,
  type ForgettingExecutorRealResult,
} from "./forgetting-executor";
import {
  appendSupersededMarkdownFrontmatterProposals,
  reconcileLifecycleProposalDeferrals,
} from "./entry-lifecycle-proposals";
import { refreshLifecycleConvergenceReadModel } from "./lifecycle-convergence";

export interface ForgettingAgentEndInput {
  projectRoot: string;
  memorySettings: MemorySettings;
  /** Fail-closed projection of effective sediment auto-write authority. */
  globalWriteAuthority: boolean;
  loadEntries: () => Promise<MemoryEntry[]>;
  createArchiveEntry: (scopeOf: ReadonlyMap<string, "project" | "world">) => ArchiveEntryFn;
}

export interface ForgettingLifecycleHookSummary {
  frontmatter_bridge: "completed" | "failed";
  e2_reconcile: "completed" | "failed";
  convergence_refresh: "completed" | "failed";
}

export interface ForgettingAgentEndResult {
  real_apply_gate_enabled: boolean;
  executor_real_apply_gate_enabled: boolean;
  global_write_authority_enabled: boolean;
  archive_entry_injected: boolean;
  lifecycle_hooks: ForgettingLifecycleHookSummary;
  executor: ForgettingExecutorRealResult;
}

export interface ForgettingAgentEndDependencies {
  appendFrontmatterBridge: typeof appendSupersededMarkdownFrontmatterProposals;
  reconcileDeferrals: typeof reconcileLifecycleProposalDeferrals;
  refreshConvergence: typeof refreshLifecycleConvergenceReadModel;
  runExecutor: typeof runForgettingExecutor;
}

const DEFAULT_DEPENDENCIES: ForgettingAgentEndDependencies = {
  appendFrontmatterBridge: appendSupersededMarkdownFrontmatterProposals,
  reconcileDeferrals: reconcileLifecycleProposalDeferrals,
  refreshConvergence: refreshLifecycleConvergenceReadModel,
  runExecutor: runForgettingExecutor,
};

/**
 * The forgetting slice of the real sediment agent_end orchestration.
 * Lifecycle bridges and proposal planning always run while forgetting is
 * enabled. The dedicated gate requires literal boolean true; global write
 * authority uses existing effective auto-write semantics (boolean true or the
 * legacy string "true") with missing/malformed input closed.
 */
export async function runForgettingAgentEndPass(
  input: ForgettingAgentEndInput,
  dependencies: ForgettingAgentEndDependencies = DEFAULT_DEPENDENCIES,
): Promise<ForgettingAgentEndResult> {
  const lifecycleHooks: ForgettingLifecycleHookSummary = {
    frontmatter_bridge: "completed",
    e2_reconcile: "completed",
    convergence_refresh: "completed",
  };

  try { dependencies.appendFrontmatterBridge({ projectRoot: input.projectRoot }); }
  catch { lifecycleHooks.frontmatter_bridge = "failed"; }
  try { dependencies.reconcileDeferrals(); }
  catch { lifecycleHooks.e2_reconcile = "failed"; }
  try { dependencies.refreshConvergence(); }
  catch { lifecycleHooks.convergence_refresh = "failed"; }

  let allEntries: MemoryEntry[] = [];
  try { allEntries = await input.loadEntries(); }
  catch { /* active corpus remains unknown; a real executor fails closed */ }

  const executorRealApplyGateEnabled = isForgettingExecutorRealApplyEnabled(
    (input.memorySettings.forgetting as { executorRealApplyEnabled?: unknown } | undefined)?.executorRealApplyEnabled,
  );
  const globalWriteAuthorityEnabled = input.globalWriteAuthority === true;
  const realApplyGateEnabled = executorRealApplyGateEnabled && globalWriteAuthorityEnabled;
  if (!realApplyGateEnabled) {
    const executor = await dependencies.runExecutor(
      input.projectRoot,
      input.memorySettings,
      { globalWriteAuthority: globalWriteAuthorityEnabled },
    );
    return {
      real_apply_gate_enabled: false,
      executor_real_apply_gate_enabled: executorRealApplyGateEnabled,
      global_write_authority_enabled: globalWriteAuthorityEnabled,
      archive_entry_injected: false,
      lifecycle_hooks: lifecycleHooks,
      executor,
    };
  }

  const activeCorpusSize = allEntries.length > 0
    ? allEntries.filter((entry) => entry.status === "active").length
    : undefined;
  const scopeOf = new Map(
    allEntries.map((entry) => [entry.slug, entry.scope === "world" ? "world" : "project"] as const),
  );
  const archiveEntry = input.createArchiveEntry(scopeOf);
  const executor = await dependencies.runExecutor(
    input.projectRoot,
    input.memorySettings,
    { archiveEntry, activeCorpusSize, globalWriteAuthority: globalWriteAuthorityEnabled },
  );
  return {
    real_apply_gate_enabled: true,
    executor_real_apply_gate_enabled: true,
    global_write_authority_enabled: true,
    archive_entry_injected: true,
    lifecycle_hooks: lifecycleHooks,
    executor,
  };
}
