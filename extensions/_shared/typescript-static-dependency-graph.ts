import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { jcsSha256Hex, sha256Hex } from "./jcs";

export const TYPESCRIPT_STATIC_DEPENDENCY_GRAPH_SCHEMA = "typescript-static-dependency-graph/v1" as const;

const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface StaticDependencyFileRow {
  path: string;
  bytes: number;
  sha256: string;
  local_dependencies: readonly string[];
}

export interface TypescriptStaticDependencyGraph {
  schema_version: typeof TYPESCRIPT_STATIC_DEPENDENCY_GRAPH_SCHEMA;
  parser: "typescript-compiler-api";
  scope: "reachable_static_local_modules_plus_explicit_files";
  roots: readonly string[];
  explicit_files: readonly string[];
  files: readonly StaticDependencyFileRow[];
  unresolved_dynamic_loaders: readonly never[];
  graph_hash: string;
}

export class StaticDependencyGraphError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "StaticDependencyGraphError";
    this.code = code;
    this.detail = detail ? deepFreeze(detail) : undefined;
  }
}

export function buildTypescriptStaticDependencyGraph(options: {
  repoRoot: string;
  roots: readonly string[];
  explicitFiles?: readonly string[];
}): TypescriptStaticDependencyGraph {
  const repoRoot = path.resolve(options.repoRoot);
  assertDirectoryNoSymlink(repoRoot);
  const roots = normalizeInputPaths(repoRoot, options.roots, "root");
  const explicitFiles = normalizeInputPaths(repoRoot, options.explicitFiles ?? [], "explicit file", { allowEmpty: true });
  const pending = [...roots];
  const dependenciesByPath = new Map<string, readonly string[]>();

  while (pending.length > 0) {
    pending.sort(compareCodeUnits);
    const relative = pending.shift()!;
    if (dependenciesByPath.has(relative)) continue;
    const absolute = resolveRepoFile(repoRoot, relative, "reachable module");
    const source = fs.readFileSync(absolute, "utf-8");
    const dependencies = path.extname(absolute) === ".json"
      ? Object.freeze([] as string[])
      : Object.freeze(extractLocalDependencies({ repoRoot, file: absolute, source }));
    dependenciesByPath.set(relative, dependencies);
    for (const dependency of dependencies) if (!dependenciesByPath.has(dependency)) pending.push(dependency);
  }

  for (const relative of explicitFiles) {
    if (!dependenciesByPath.has(relative)) dependenciesByPath.set(relative, Object.freeze([] as string[]));
  }

  const files = Object.freeze([...dependenciesByPath.keys()].sort(compareCodeUnits).map((relative): StaticDependencyFileRow => {
    const absolute = resolveRepoFile(repoRoot, relative, "graph file");
    const bytes = fs.readFileSync(absolute);
    return deepFreeze({
      path: relative,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      local_dependencies: dependenciesByPath.get(relative) ?? Object.freeze([] as string[]),
    });
  }));
  const base = {
    schema_version: TYPESCRIPT_STATIC_DEPENDENCY_GRAPH_SCHEMA,
    parser: "typescript-compiler-api" as const,
    scope: "reachable_static_local_modules_plus_explicit_files" as const,
    roots,
    explicit_files: explicitFiles,
    files,
    unresolved_dynamic_loaders: Object.freeze([] as never[]),
  };
  const graph = deepFreeze({ ...base, graph_hash: jcsSha256Hex(base) });
  validateTypescriptStaticDependencyGraph(graph);
  return graph;
}

export function extractJitiRepoModules(options: {
  repoRoot: string;
  entrypoint: string;
  repoRootIdentifiers?: readonly string[];
}): readonly string[] {
  const repoRoot = path.resolve(options.repoRoot);
  assertDirectoryNoSymlink(repoRoot);
  const relativeEntrypoint = normalizeInputPaths(repoRoot, [options.entrypoint], "jiti entrypoint")[0]!;
  const absoluteEntrypoint = resolveRepoFile(repoRoot, relativeEntrypoint, "jiti entrypoint");
  const source = fs.readFileSync(absoluteEntrypoint, "utf-8");
  const sourceFile = ts.createSourceFile(absoluteEntrypoint, source, ts.ScriptTarget.Latest, false, scriptKind(absoluteEntrypoint));
  const loaderNames = collectJitiLoaderNames(sourceFile);
  const rootIdentifiers = new Set(options.repoRootIdentifiers ?? ["repoRoot"]);
  const modules: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && loaderNames.has(node.expression.text)) {
      const argument = node.arguments[0];
      let absolute: string | null = null;
      if (argument && ts.isStringLiteralLike(argument)) {
        absolute = path.resolve(repoRoot, argument.text);
      } else if (argument && ts.isCallExpression(argument)
        && ts.isPropertyAccessExpression(argument.expression)
        && ts.isIdentifier(argument.expression.expression)
        && argument.expression.expression.text === "path"
        && argument.expression.name.text === "join"
        && argument.arguments.length >= 2
        && ts.isIdentifier(argument.arguments[0]!)
        && rootIdentifiers.has((argument.arguments[0] as ts.Identifier).text)
        && argument.arguments.slice(1).every((part) => ts.isStringLiteralLike(part))) {
        absolute = path.join(repoRoot, ...argument.arguments.slice(1).map((part) => (part as ts.StringLiteralLike).text));
      }
      if (!absolute) {
        const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        fail("STATIC_DEPENDENCY_DYNAMIC_LOADER", "jiti entrypoint contains a noncanonical dynamic module path", {
          file: relativeEntrypoint,
          line: location.line + 1,
          column: location.character + 1,
        });
      }
      assertInsideRepo(repoRoot, absolute, "jiti module");
      const relative = relativeUnix(repoRoot, absolute);
      resolveRepoFile(repoRoot, relative, "jiti module");
      modules.push(relative);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const ordered = [...new Set(modules)].sort(compareCodeUnits);
  if (ordered.length !== modules.length || ordered.length === 0) fail("STATIC_DEPENDENCY_DYNAMIC_LOADER", "jiti module inventory is empty or duplicated", { entrypoint: relativeEntrypoint });
  return Object.freeze(ordered);
}

export function validateTypescriptStaticDependencyGraph(
  graph: TypescriptStaticDependencyGraph,
  options: { requiredPaths?: readonly string[] } = {},
): void {
  assertExactKeys(asRecord(graph), ["schema_version", "parser", "scope", "roots", "explicit_files", "files", "unresolved_dynamic_loaders", "graph_hash"], "dependency_graph");
  if (graph.schema_version !== TYPESCRIPT_STATIC_DEPENDENCY_GRAPH_SCHEMA
    || graph.parser !== "typescript-compiler-api"
    || graph.scope !== "reachable_static_local_modules_plus_explicit_files") {
    fail("STATIC_DEPENDENCY_GRAPH_INVALID", "dependency graph identity drifted");
  }
  assertSortedUniqueStrings(graph.roots, "dependency_graph.roots");
  assertSortedUniqueStrings(graph.explicit_files, "dependency_graph.explicit_files", { allowEmpty: true });
  if (!Array.isArray(graph.unresolved_dynamic_loaders) || graph.unresolved_dynamic_loaders.length !== 0) {
    fail("STATIC_DEPENDENCY_DYNAMIC_LOADER", "dependency graph contains unresolved dynamic loaders");
  }
  if (!Array.isArray(graph.files) || graph.files.length === 0) fail("STATIC_DEPENDENCY_GRAPH_INVALID", "dependency graph file inventory is empty");
  const filePaths = graph.files.map((row) => row.path);
  assertSortedUniqueStrings(filePaths, "dependency_graph.files[].path");
  const fileSet = new Set(filePaths);
  for (const [index, row] of graph.files.entries()) {
    assertExactKeys(asRecord(row), ["path", "bytes", "sha256", "local_dependencies"], `dependency_graph.files[${index}]`);
    assertCount(row.bytes, `dependency_graph.files[${index}].bytes`);
    assertSha256(row.sha256, `dependency_graph.files[${index}].sha256`);
    assertSortedUniqueStrings(row.local_dependencies, `dependency_graph.files[${index}].local_dependencies`, { allowEmpty: true });
    for (const dependency of row.local_dependencies) {
      if (!fileSet.has(dependency)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", "local dependency is absent from graph closure", { file: row.path, dependency });
    }
  }
  for (const root of graph.roots) if (!fileSet.has(root)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", "graph root is absent from file inventory", { root });
  for (const explicit of graph.explicit_files) if (!fileSet.has(explicit)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", "explicit file is absent from file inventory", { explicit });
  for (const required of options.requiredPaths ?? []) if (!fileSet.has(required)) fail("STATIC_DEPENDENCY_REQUIRED_PATH_MISSING", "required dependency evidence path is missing", { required });
  const base = { ...graph } as Record<string, unknown>;
  delete base.graph_hash;
  assertSha256(graph.graph_hash, "dependency_graph.graph_hash");
  if (jcsSha256Hex(base) !== graph.graph_hash) fail("STATIC_DEPENDENCY_GRAPH_HASH_INVALID", "dependency graph hash mismatch");
}

function extractLocalDependencies(options: { repoRoot: string; file: string; source: string }): string[] {
  const sourceFile = ts.createSourceFile(options.file, options.source, ts.ScriptTarget.Latest, false, scriptKind(options.file));
  const specifiers: string[] = [];
  const jitiLoaderNames = collectJitiLoaderNames(sourceFile);

  const addLoaderSpecifier = (argument: ts.Expression | undefined, loader: string, node: ts.Node): void => {
    const resolved = loaderSpecifierText(options.repoRoot, argument);
    if (resolved === null) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      fail("STATIC_DEPENDENCY_DYNAMIC_LOADER", "reachable runtime graph contains a noncanonical dynamic loader", {
        file: relativeUnix(options.repoRoot, options.file),
        line: location.line + 1,
        column: location.character + 1,
        loader,
      });
    }
    specifiers.push(resolved);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        addLoaderSpecifier(node.arguments[0], "import", node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addLoaderSpecifier(node.arguments[0], "require", node);
      } else if (ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === "require"
        && node.expression.name.text === "resolve") {
        addLoaderSpecifier(node.arguments[0], "require.resolve", node);
      } else if (ts.isIdentifier(node.expression) && jitiLoaderNames.has(node.expression.text)) {
        addLoaderSpecifier(node.arguments[0], "jiti", node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const dependencies = specifiers
    .filter((specifier) => isLocalSpecifier(specifier))
    .map((specifier) => resolveLocalSpecifier(options.repoRoot, options.file, specifier))
    .sort(compareCodeUnits);
  return [...new Set(dependencies)];
}

function collectJitiLoaderNames(sourceFile: ts.SourceFile): Set<string> {
  const loaderNames = new Set<string>();
  const factoryNames = new Set<string>(["createJiti"]);
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)
      && ts.isStringLiteralLike(statement.moduleSpecifier)
      && statement.moduleSpecifier.text === "jiti"
      && statement.importClause) {
      if (statement.importClause.name) loaderNames.add(statement.importClause.name.text);
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if ((element.propertyName?.text ?? element.name.text) === "createJiti") factoryNames.add(element.name.text);
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const callee = declaration.initializer.expression;
      if (ts.isIdentifier(callee) && factoryNames.has(callee.text)) loaderNames.add(declaration.name.text);
    }
  }
  return loaderNames;
}

function literalText(value: ts.Expression | undefined): string | null {
  if (!value) return null;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  return null;
}

function loaderSpecifierText(repoRoot: string, value: ts.Expression | undefined): string | null {
  const literal = literalText(value);
  if (literal !== null) return literal;
  if (!value
    || !ts.isCallExpression(value)
    || !ts.isPropertyAccessExpression(value.expression)
    || !ts.isIdentifier(value.expression.expression)
    || value.expression.expression.text !== "path"
    || value.expression.name.text !== "join"
    || value.arguments.length < 2
    || !ts.isIdentifier(value.arguments[0]!)
    || value.arguments[0]!.text !== "repoRoot"
    || !value.arguments.slice(1).every((part) => ts.isStringLiteralLike(part))) return null;
  const absolute = path.join(repoRoot, ...value.arguments.slice(1).map((part) => (part as ts.StringLiteralLike).text));
  assertInsideRepo(repoRoot, absolute, "canonical dynamic loader");
  return absolute;
}

function resolveLocalSpecifier(repoRoot: string, importer: string, specifier: string): string {
  const base = path.isAbsolute(specifier) ? specifier : path.resolve(path.dirname(importer), specifier);
  const candidates = [base];
  if (!path.extname(base)) {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) fail("STATIC_DEPENDENCY_SYMLINK_REJECTED", "local dependency is a symlink", { importer: relativeUnix(repoRoot, importer), specifier });
    if (!stat.isFile()) continue;
    const absolute = path.resolve(candidate);
    assertInsideRepo(repoRoot, absolute, "local dependency");
    return relativeUnix(repoRoot, absolute);
  }
  fail("STATIC_DEPENDENCY_UNRESOLVED_LOCAL", "reachable local dependency cannot be resolved", { importer: relativeUnix(repoRoot, importer), specifier });
}

function normalizeInputPaths(repoRoot: string, inputs: readonly string[], label: string, options: { allowEmpty?: boolean } = {}): readonly string[] {
  if (!Array.isArray(inputs) || (!options.allowEmpty && inputs.length === 0)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${label} list must not be empty`);
  const normalized = inputs.map((input) => {
    if (typeof input !== "string" || !input) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${label} must be a non-empty string`);
    const absolute = path.resolve(repoRoot, input);
    assertInsideRepo(repoRoot, absolute, label);
    resolveRepoFile(repoRoot, relativeUnix(repoRoot, absolute), label);
    return relativeUnix(repoRoot, absolute);
  }).sort(compareCodeUnits);
  if (new Set(normalized).size !== normalized.length) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${label} list contains duplicates`);
  return Object.freeze(normalized);
}

function resolveRepoFile(repoRoot: string, relative: string, label: string): string {
  const absolute = path.resolve(repoRoot, ...relative.split("/"));
  assertInsideRepo(repoRoot, absolute, label);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (err) {
    fail("STATIC_DEPENDENCY_FILE_MISSING", `${label} is missing`, { path: relative, error: err instanceof Error ? err.message : String(err) });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("STATIC_DEPENDENCY_SYMLINK_REJECTED", `${label} is a symlink or non-file`, { path: relative });
  const real = fs.realpathSync(absolute);
  assertInsideRepo(repoRoot, real, `${label} realpath`);
  if (real !== absolute) fail("STATIC_DEPENDENCY_SYMLINK_REJECTED", `${label} realpath differs`, { path: relative, real });
  return absolute;
}

function assertDirectoryNoSymlink(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) fail("STATIC_DEPENDENCY_REPO_ROOT_INVALID", "dependency graph repo root is unsafe", { directory });
}

function assertInsideRepo(repoRoot: string, file: string, label: string): void {
  const relative = path.relative(repoRoot, file);
  if (relative === "" && file !== repoRoot) return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("STATIC_DEPENDENCY_PATH_ESCAPE", `${label} escapes repo root`, { file });
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || path.isAbsolute(specifier);
}

function scriptKind(file: string): ts.ScriptKind {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  if (extension === ".json") return ts.ScriptKind.JSON;
  return ts.ScriptKind.TS;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${at} has unexpected keys`, { actual, expected: wanted });
}

function assertSortedUniqueStrings(values: readonly unknown[], at: string, options: { allowEmpty?: boolean } = {}): void {
  if (!Array.isArray(values) || (!options.allowEmpty && values.length === 0)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${at} must not be empty`);
  if (values.some((value) => typeof value !== "string" || !value)
    || new Set(values).size !== values.length
    || values.some((value, index) => index > 0 && compareCodeUnits(values[index - 1] as string, value as string) >= 0)) {
    fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${at} must be unique non-empty strings in code-unit order`);
  }
}

function assertSha256(value: unknown, at: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${at} must be lowercase SHA-256`);
}

function assertCount(value: unknown, at: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("STATIC_DEPENDENCY_GRAPH_INVALID", `${at} must be a non-negative safe integer`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("STATIC_DEPENDENCY_GRAPH_INVALID", "expected object");
  return value as Record<string, unknown>;
}

function relativeUnix(parent: string, child: string): string {
  return path.relative(parent, child).split(path.sep).join("/");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(code: string, message: string, detail?: Record<string, unknown>): never {
  throw new StaticDependencyGraphError(code, message, detail);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
