import * as os from "node:os";
import * as path from "node:path";

export class PropositionPolicyStableViewRootError extends Error {
  readonly code: "PRODUCTION_ROOT_INVALID";
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(message: string, detail?: Record<string, unknown>) {
    super(`PRODUCTION_ROOT_INVALID: ${message}`);
    this.name = "PropositionPolicyStableViewRootError";
    this.code = "PRODUCTION_ROOT_INVALID";
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

/** Resolve production ownership at invocation time, never at module load. */
export function resolvePropositionPolicyStableViewCurrentAbrainHome(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = env.HOME || os.homedir();
  if (!path.isAbsolute(home)) throw new PropositionPolicyStableViewRootError("HOME must be an absolute path");
  const configured = env.ABRAIN_ROOT
    ? env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, home)
    : path.join(home, ".abrain");
  if (!path.isAbsolute(configured)) {
    throw new PropositionPolicyStableViewRootError(
      "ABRAIN_ROOT must resolve to an absolute path",
      { configured },
    );
  }
  return path.resolve(configured);
}
