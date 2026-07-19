export const DISPATCH_TASK_PROFILES = [
  "reviewer",
  "read_only",
  "research",
  "implementation",
  "heavy",
] as const;

export type DispatchTaskProfile = typeof DISPATCH_TASK_PROFILES[number];

const DISPATCH_TASK_PROFILE_SET = new Set<string>(DISPATCH_TASK_PROFILES);

export function isDispatchTaskProfile(value: unknown): value is DispatchTaskProfile {
  return typeof value === "string" && DISPATCH_TASK_PROFILE_SET.has(value);
}

/** Resolve the taskProfile/profile alias pair without silently discarding bad input. */
export function resolveDispatchTaskProfileAliases(
  taskProfile: unknown,
  profile: unknown,
): DispatchTaskProfile | undefined {
  const resolveOne = (value: unknown, field: "taskProfile" | "profile"): DispatchTaskProfile | undefined => {
    if (value === undefined) return undefined;
    if (!isDispatchTaskProfile(value)) {
      throw new Error(`${field} must be one of ${DISPATCH_TASK_PROFILES.join(", ")}`);
    }
    return value;
  };

  const primary = resolveOne(taskProfile, "taskProfile");
  const alias = resolveOne(profile, "profile");
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new Error(`taskProfile and profile conflict (${primary} != ${alias})`);
  }
  return primary ?? alias;
}

export function normalizeDispatchTaskProfile(
  profile: DispatchTaskProfile | undefined,
): "read_only" | "research" | "implementation" | undefined {
  if (profile === "reviewer" || profile === "read_only") return "read_only";
  if (profile === "research") return "research";
  if (profile === "implementation" || profile === "heavy") return "implementation";
  return undefined;
}
