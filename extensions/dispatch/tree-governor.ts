/// <reference types="node" />

/**
 * Deterministic per-root delegation tree governor.
 *
 * One instance owns one tree and serializes mutations through one promise
 * chain. Reservation lineage sequence numbers are permanently consumed before
 * pre-delegation callbacks, even when authorization is later denied.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type TreeGovernorMode = "accepting" | "draining" | "terminal";
export type TreeExecutionState = "active" | "waiting" | "terminal";
export type TreeTerminalKind = "completed" | "failed" | "cancelled";
export type TreeTerminalSource =
  | "settled"
  | "delegation_error"
  | "abort"
  | "revoked"
  | "shutdown"
  | "deadline"
  | "drained";

export interface TreeTerminalState {
  kind: TreeTerminalKind;
  source: TreeTerminalSource;
  reasonCode: string;
  atMs: number;
}

export interface TreeGovernorConfig {
  rootRef: string;
  deadlineMs: number;
  maxAcceptedRuns: number;
  maxActiveExecutions: number;
  maxOpenSessions: number;
}

export interface TreeBudgetSnapshot {
  acceptedRuns: number;
  activeExecutions: number;
  openSessions: number;
  maxAcceptedRuns: number;
  maxActiveExecutions: number;
  maxOpenSessions: number;
}

export interface TreeNodeSnapshot {
  nodeRef: string;
  parentRef: string;
  nodeDepth: number;
  state: TreeExecutionState;
  sessionOpen: boolean;
  children: readonly string[];
  terminal?: TreeTerminalState;
}

export interface TreeGovernorSnapshot {
  rootRef: string;
  mode: TreeGovernorMode;
  deadlineMs: number;
  budgets: TreeBudgetSnapshot;
  resumeQueue: readonly string[];
  rootTerminal?: TreeTerminalState;
  nodes: readonly TreeNodeSnapshot[];
}

export interface TreeAuthorizationReservation {
  rootRef: string;
  nodeRef: string;
  parentRef: string;
  nodeDepth: number;
  budgetBefore: TreeBudgetSnapshot;
  budgetAfter: TreeBudgetSnapshot;
  authorizedAtMs: number;
}

export interface TreeDelegationRegistration<T> {
  value: T;
  onTerminal?: (terminal: TreeTerminalState) => void;
}

export interface TreeAuthorizeAndDelegateRequest<T> {
  parentNodeRef?: string;
  signal?: AbortSignal;
  beforeDelegate?: (reservation: TreeAuthorizationReservation) => void | Promise<void>;
  /** Synchronous capability reservation performed after all async barriers and
   * immediately before tree counters commit, inside the same writer turn. */
  beforeCommit?: (reservation: TreeAuthorizationReservation) => void;
  delegate: (reservation: TreeAuthorizationReservation) => TreeDelegationRegistration<T>;
}

export interface TreeAuthorizationResult<T> {
  reservation: TreeAuthorizationReservation;
  value: T;
}

export type TreeGovernorErrorCode =
  | "invalid_config"
  | "tree_not_accepting"
  | "root_deadline_elapsed"
  | "authorization_aborted"
  | "parent_not_open"
  | "accepted_run_budget_exhausted"
  | "active_execution_budget_exhausted"
  | "open_session_budget_exhausted"
  | "node_not_found"
  | "invalid_transition"
  | "live_children"
  | "reentrant_operation";

export class TreeGovernorError extends Error {
  constructor(readonly code: TreeGovernorErrorCode, message: string) {
    super(message);
    this.name = "TreeGovernorError";
  }
}

interface TreeNodeRecord {
  nodeRef: string;
  parentRef: string;
  nodeDepth: number;
  state: TreeExecutionState;
  sessionOpen: boolean;
  children: Set<string>;
  terminal?: TreeTerminalState;
  onTerminal?: (terminal: TreeTerminalState) => void;
}

const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

function invalid(message: string): never {
  throw new TreeGovernorError("invalid_config", message);
}

function finiteNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${field} must be a finite non-negative integer`);
  }
  return value;
}

function auditSafeRootRef(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 64 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
    UUID_LIKE.test(value)
  ) {
    return invalid("rootRef must be a short audit-safe reference, not a raw session id");
  }
  return value;
}

function normalizeConfig(config: TreeGovernorConfig): TreeGovernorConfig {
  if (!config || typeof config !== "object") return invalid("TreeGovernor config is required");
  return Object.freeze({
    rootRef: auditSafeRootRef(config.rootRef),
    deadlineMs: finiteNonNegativeInteger(config.deadlineMs, "deadlineMs"),
    maxAcceptedRuns: finiteNonNegativeInteger(config.maxAcceptedRuns, "maxAcceptedRuns"),
    maxActiveExecutions: finiteNonNegativeInteger(config.maxActiveExecutions, "maxActiveExecutions"),
    maxOpenSessions: finiteNonNegativeInteger(config.maxOpenSessions, "maxOpenSessions"),
  });
}

function terminal(
  kind: TreeTerminalKind,
  source: TreeTerminalSource,
  reasonCode: string,
  atMs: number,
): TreeTerminalState {
  return Object.freeze({ kind, source, reasonCode, atMs });
}

export class TreeGovernor {
  readonly config: TreeGovernorConfig;

  private chain: Promise<void> = Promise.resolve();
  private readonly callbackContext = new AsyncLocalStorage<boolean>();
  private readonly nodes = new Map<string, TreeNodeRecord>();
  private readonly resumeQueue: string[] = [];
  private readonly queuedForResume = new Set<string>();
  private mode: TreeGovernorMode = "accepting";
  private rootTerminal: TreeTerminalState | undefined;
  private acceptedRuns = 0;
  private activeExecutions = 0;
  private openSessions = 0;
  private nextNodeSequence = 1;

  constructor(config: TreeGovernorConfig, private readonly clock: () => number = Date.now) {
    this.config = normalizeConfig(config);
  }

  snapshot(): TreeGovernorSnapshot {
    return {
      rootRef: this.config.rootRef,
      mode: this.mode,
      deadlineMs: this.config.deadlineMs,
      budgets: this.budgetSnapshot(),
      resumeQueue: [...this.resumeQueue],
      ...(this.rootTerminal ? { rootTerminal: { ...this.rootTerminal } } : {}),
      nodes: [...this.nodes.values()].map((node) => this.nodeSnapshot(node)),
    };
  }

  authorizeAndDelegate<T>(request: TreeAuthorizeAndDelegateRequest<T>): Promise<TreeAuthorizationResult<T>> {
    return this.transact(async () => {
      const now = this.now();
      this.assertAuthorizable(now, request.signal);
      const parentRef = request.parentNodeRef ?? this.config.rootRef;
      let nodeDepth = 1;
      if (parentRef !== this.config.rootRef) {
        const parent = this.nodes.get(parentRef);
        if (!parent || !parent.sessionOpen || parent.state === "terminal") {
          throw new TreeGovernorError("parent_not_open", `parent ${parentRef} is not an open tree node`);
        }
        nodeDepth = parent.nodeDepth + 1;
      }

      const before = this.budgetSnapshot();
      if (this.acceptedRuns >= this.config.maxAcceptedRuns) {
        throw new TreeGovernorError("accepted_run_budget_exhausted", "accepted-run budget is exhausted");
      }
      if (this.activeExecutions >= this.config.maxActiveExecutions) {
        throw new TreeGovernorError("active_execution_budget_exhausted", "active-execution budget is exhausted");
      }
      if (this.openSessions >= this.config.maxOpenSessions) {
        throw new TreeGovernorError("open_session_budget_exhausted", "open-session budget is exhausted");
      }

      const nodeRef = `${this.config.rootRef}.${this.nextNodeSequence++}`;
      const reservation: TreeAuthorizationReservation = Object.freeze({
        rootRef: this.config.rootRef,
        nodeRef,
        parentRef,
        nodeDepth,
        budgetBefore: before,
        budgetAfter: Object.freeze({
          ...before,
          acceptedRuns: before.acceptedRuns + 1,
          activeExecutions: before.activeExecutions + 1,
          openSessions: before.openSessions + 1,
        }),
        authorizedAtMs: now,
      });

      if (request.beforeDelegate) {
        await this.invokeGuardedCallback(() => request.beforeDelegate!(reservation));
      }
      if (request.signal?.aborted) {
        throw new TreeGovernorError("authorization_aborted", "authorization signal was aborted before delegation");
      }
      const preDelegateNow = this.now();
      if (preDelegateNow >= this.config.deadlineMs) {
        this.setRootTerminal(terminal("cancelled", "deadline", "root_deadline_elapsed", preDelegateNow));
        this.mode = "terminal";
        this.transitionAllOpenNodes(this.rootTerminal!);
        throw new TreeGovernorError("root_deadline_elapsed", "root deadline elapsed before delegation");
      }
      if (request.beforeCommit) {
        this.invokeGuardedCallback(() => request.beforeCommit!(reservation));
      }

      this.acceptedRuns++;
      this.activeExecutions++;
      this.openSessions++;
      const node: TreeNodeRecord = {
        nodeRef,
        parentRef,
        nodeDepth,
        state: "active",
        sessionOpen: true,
        children: new Set<string>(),
      };
      this.nodes.set(nodeRef, node);
      if (parentRef !== this.config.rootRef) this.nodes.get(parentRef)!.children.add(nodeRef);

      try {
        const registration = this.invokeExternalCallback(() => request.delegate(reservation));
        if (!registration || typeof registration !== "object" || !("value" in registration)) {
          throw new Error("delegation callback must return a TreeDelegationRegistration");
        }
        node.onTerminal = registration.onTerminal;
        return { reservation, value: registration.value };
      } catch (error) {
        this.transitionNode(node, terminal("failed", "delegation_error", "delegation_callback_failed", this.now()));
        this.pumpResumeQueue();
        this.finishDrainIfEmpty();
        throw error;
      }
    });
  }

  pauseExecution(nodeRef: string): Promise<TreeNodeSnapshot> {
    return this.transact(() => {
      const node = this.requireNode(nodeRef);
      if (node.state !== "active") throw new TreeGovernorError("invalid_transition", `${nodeRef} is not active`);
      node.state = "waiting";
      this.activeExecutions--;
      return this.nodeSnapshot(node);
    });
  }

  requestResume(nodeRef: string): Promise<TreeNodeSnapshot> {
    return this.transact(() => {
      const node = this.requireNode(nodeRef);
      if (node.state !== "waiting" || !node.sessionOpen) {
        throw new TreeGovernorError("invalid_transition", `${nodeRef} is not an open waiting node`);
      }
      if (!this.queuedForResume.has(nodeRef)) {
        this.queuedForResume.add(nodeRef);
        this.resumeQueue.push(nodeRef);
      }
      this.pumpResumeQueue();
      return this.nodeSnapshot(node);
    });
  }

  waitForChildren(nodeRef: string): Promise<TreeNodeSnapshot> {
    return this.transact(() => {
      const node = this.requireNode(nodeRef);
      if (node.state !== "active") throw new TreeGovernorError("invalid_transition", `${nodeRef} is not active`);
      if (!this.hasLiveChildren(node)) {
        throw new TreeGovernorError("invalid_transition", `${nodeRef} has no live children to wait for`);
      }
      node.state = "waiting";
      this.activeExecutions--;
      if (!this.queuedForResume.has(nodeRef)) {
        this.queuedForResume.add(nodeRef);
        this.resumeQueue.push(nodeRef);
      }
      this.pumpResumeQueue();
      return this.nodeSnapshot(node);
    });
  }

  settleNode(
    nodeRef: string,
    outcome: { kind: TreeTerminalKind; reasonCode: string },
  ): Promise<{ changed: boolean; terminal: TreeTerminalState }> {
    return this.transact(() => {
      const node = this.requireNode(nodeRef);
      if (node.terminal) return { changed: false, terminal: node.terminal };
      if (this.hasLiveChildren(node)) {
        throw new TreeGovernorError("live_children", `${nodeRef} cannot settle while descendants are live`);
      }
      const state = terminal(outcome.kind, "settled", outcome.reasonCode, this.now());
      this.transitionNode(node, state);
      this.pumpResumeQueue();
      this.finishDrainIfEmpty();
      return { changed: true, terminal: state };
    });
  }

  abortSubtree(nodeRef: string, reasonCode = "aborted"): Promise<TreeTerminalState> {
    return this.terminateSubtree(nodeRef, terminal("cancelled", "abort", reasonCode, this.now()));
  }

  revokeSubtree(nodeRef: string, reasonCode = "revoked"): Promise<TreeTerminalState> {
    return this.terminateSubtree(nodeRef, terminal("cancelled", "revoked", reasonCode, this.now()));
  }

  beginDrain(reasonCode = "drain_requested"): Promise<TreeGovernorSnapshot> {
    return this.transact(() => {
      if (this.mode === "terminal") return this.snapshot();
      this.mode = "draining";
      this.pumpResumeQueue();
      this.finishDrainIfEmpty(reasonCode);
      return this.snapshot();
    });
  }

  abortAll(reasonCode = "root_aborted"): Promise<TreeGovernorSnapshot> {
    return this.forceRootTerminal(terminal("cancelled", "abort", reasonCode, this.now()));
  }

  revokeAll(reasonCode = "root_revoked"): Promise<TreeGovernorSnapshot> {
    return this.forceRootTerminal(terminal("cancelled", "revoked", reasonCode, this.now()));
  }

  shutdown(reasonCode = "shutdown"): Promise<TreeGovernorSnapshot> {
    return this.forceRootTerminal(terminal("cancelled", "shutdown", reasonCode, this.now()));
  }

  expire(): Promise<TreeGovernorSnapshot> {
    return this.transact(() => {
      if (this.mode === "terminal") return this.snapshot();
      const now = this.now();
      if (now < this.config.deadlineMs) return this.snapshot();
      this.setRootTerminal(terminal("cancelled", "deadline", "root_deadline_elapsed", now));
      this.mode = "terminal";
      this.transitionAllOpenNodes(this.rootTerminal!);
      return this.snapshot();
    });
  }

  private terminateSubtree(nodeRef: string, state: TreeTerminalState): Promise<TreeTerminalState> {
    return this.transact(() => {
      const root = this.requireNode(nodeRef);
      if (root.terminal) return root.terminal;
      for (const node of this.subtreeRecords(root)) this.transitionNode(node, state);
      this.pumpResumeQueue();
      this.finishDrainIfEmpty();
      return root.terminal!;
    });
  }

  private forceRootTerminal(state: TreeTerminalState): Promise<TreeGovernorSnapshot> {
    return this.transact(() => {
      this.setRootTerminal(state);
      this.mode = "terminal";
      this.transitionAllOpenNodes(this.rootTerminal!);
      return this.snapshot();
    });
  }

  private transitionAllOpenNodes(state: TreeTerminalState): void {
    for (const node of this.nodes.values()) this.transitionNode(node, state);
    this.resumeQueue.length = 0;
    this.queuedForResume.clear();
  }

  private transitionNode(node: TreeNodeRecord, state: TreeTerminalState): boolean {
    if (node.terminal) return false;
    if (node.state === "active") this.activeExecutions--;
    if (node.sessionOpen) this.openSessions--;
    node.state = "terminal";
    node.sessionOpen = false;
    node.terminal = state;
    this.queuedForResume.delete(node.nodeRef);
    try {
      if (node.onTerminal) this.invokeExternalCallback(() => node.onTerminal!(state));
    } catch {
      // Synchronous lifecycle callbacks cannot rewrite governor state.
    }
    return true;
  }

  private pumpResumeQueue(): void {
    if (this.mode === "terminal") return;
    while (this.activeExecutions < this.config.maxActiveExecutions) {
      let selected = -1;
      for (let index = 0; index < this.resumeQueue.length; index++) {
        const nodeRef = this.resumeQueue[index]!;
        const node = this.nodes.get(nodeRef);
        if (!node || node.state !== "waiting" || !node.sessionOpen) {
          this.resumeQueue.splice(index, 1);
          this.queuedForResume.delete(nodeRef);
          index--;
          continue;
        }
        if (!this.hasLiveChildren(node)) {
          selected = index;
          break;
        }
      }
      if (selected < 0) return;
      const [nodeRef] = this.resumeQueue.splice(selected, 1);
      this.queuedForResume.delete(nodeRef!);
      const node = this.nodes.get(nodeRef!)!;
      node.state = "active";
      this.activeExecutions++;
    }
  }

  private finishDrainIfEmpty(reasonCode = "drained"): void {
    if (this.mode !== "draining" || this.openSessions !== 0) return;
    this.setRootTerminal(terminal("completed", "drained", reasonCode, this.now()));
    this.mode = "terminal";
  }

  private setRootTerminal(state: TreeTerminalState): boolean {
    if (this.rootTerminal) return false;
    this.rootTerminal = state;
    return true;
  }

  private assertAuthorizable(now: number, signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new TreeGovernorError("authorization_aborted", "authorization signal is aborted");
    if (now >= this.config.deadlineMs) {
      this.setRootTerminal(terminal("cancelled", "deadline", "root_deadline_elapsed", now));
      this.mode = "terminal";
      this.transitionAllOpenNodes(this.rootTerminal!);
      throw new TreeGovernorError("root_deadline_elapsed", "root deadline has elapsed");
    }
    if (this.mode !== "accepting" || this.rootTerminal) {
      throw new TreeGovernorError("tree_not_accepting", `tree is ${this.mode}`);
    }
  }

  private budgetSnapshot(): TreeBudgetSnapshot {
    return Object.freeze({
      acceptedRuns: this.acceptedRuns,
      activeExecutions: this.activeExecutions,
      openSessions: this.openSessions,
      maxAcceptedRuns: this.config.maxAcceptedRuns,
      maxActiveExecutions: this.config.maxActiveExecutions,
      maxOpenSessions: this.config.maxOpenSessions,
    });
  }

  private requireNode(nodeRef: string): TreeNodeRecord {
    const node = this.nodes.get(nodeRef);
    if (!node) throw new TreeGovernorError("node_not_found", `tree node ${nodeRef} does not exist`);
    return node;
  }

  private nodeSnapshot(node: TreeNodeRecord): TreeNodeSnapshot {
    return {
      nodeRef: node.nodeRef,
      parentRef: node.parentRef,
      nodeDepth: node.nodeDepth,
      state: node.state,
      sessionOpen: node.sessionOpen,
      children: [...node.children],
      ...(node.terminal ? { terminal: { ...node.terminal } } : {}),
    };
  }

  private hasLiveChildren(node: TreeNodeRecord): boolean {
    for (const childRef of node.children) {
      if (!this.nodes.get(childRef)?.terminal) return true;
    }
    return false;
  }

  private subtreeRecords(root: TreeNodeRecord): TreeNodeRecord[] {
    const out: TreeNodeRecord[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(node);
      const children = [...node.children].reverse();
      for (const childRef of children) {
        const child = this.nodes.get(childRef);
        if (child) stack.push(child);
      }
    }
    return out;
  }

  private invokeGuardedCallback<T>(callback: () => T): T {
    return this.callbackContext.run(true, callback);
  }

  private invokeExternalCallback<T>(callback: () => T): T {
    return this.callbackContext.exit(callback);
  }

  private now(): number {
    return finiteNonNegativeInteger(this.clock(), "clock result");
  }

  private transact<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.callbackContext.getStore()) {
      return Promise.reject(new TreeGovernorError(
        "reentrant_operation",
        "TreeGovernor operations cannot re-enter from the same callback async chain",
      ));
    }
    const next = this.chain.then(operation, operation);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
