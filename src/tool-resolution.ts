import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"

interface PackageManifest {
  name?: unknown
  packageManager?: unknown
  workspaces?: unknown
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  optionalDependencies?: Record<string, unknown>
  peerDependencies?: Record<string, unknown>
}

interface ToolResolutionOptions {
  /** Override filesystem reads in focused tests. */
  readFile?: (filePath: string) => Promise<string>
  /** Override directory reads in focused tests. */
  readdir?: (directory: string) => Promise<string[]>
  /** Override stat calls in focused tests. */
  stat?: (filePath: string) => Promise<{ isDirectory(): boolean }>
}

const BUILTIN_PREFIXES = ["bun:", "node:"]
const TOOL_DIRECTORIES = [".opencode/tools", ".opencode/tool"]
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"])

/**
 * Check whether an isolated writer worktree can resolve its repository-local
 * OpenCode tools without borrowing the lead repository's dependencies.
 *
 * This deliberately performs no install, symlink, or environment fallback.
 * A missing local dependency is reported before session.create so the caller
 * can install dependencies in the worktree and retry without weakening CWD,
 * workspace, or permission isolation.
 */
export async function preflightRepositoryLocalTools(
  worktreeDirectory: string,
  options: ToolResolutionOptions = {},
): Promise<void> {
  const read = options.readFile ?? (filePath => readFile(filePath, "utf8"))
  const list = options.readdir ?? (async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory)
    return entries.map(String)
  })
  const inspect = options.stat ?? stat
  const manifestPath = path.join(worktreeDirectory, "package.json")
  const toolFiles = await discoverToolFiles(worktreeDirectory, list, inspect)
  if (toolFiles.length === 0) return
  const manifest = await readJson(read, manifestPath)

  const imports = new Set<string>()
  for (const filePath of toolFiles) {
    const source = await read(filePath)
    for (const imported of extractPackageImports(source)) imports.add(imported)
  }

  if (!manifest) {
    if (imports.size === 0) return
    throw new Error(
      `Repository-local OpenCode tools in ${toolFiles.map(filePath => path.relative(worktreeDirectory, filePath)).join(", ")} `
      + "import external packages but the isolated worktree has no package.json to verify their installation. "
      + `Add package metadata and install dependencies in ${worktreeDirectory}, then retry team_spawn. `
      + "Ensemble will not share the lead repository's node_modules or relax worktree permissions.",
    )
  }
  const localPackages = packageNames(manifest)
  const unresolved = (await Promise.all([...imports]
    .filter(imported => localPackages.has(imported))
    .map(async imported => {
      const packagePath = path.join(worktreeDirectory, "node_modules", ...imported.split("/"))
      try {
        await inspect(packagePath)
        return null
      } catch {
        return imported
      }
    }))).filter((name): name is string => name !== null)

  if (unresolved.length === 0) return
  const packageManager = packageManagerName(manifest)
  const installCommand = packageManager === "pnpm"
    ? "pnpm install --offline"
    : packageManager === "npm"
      ? "npm install --ignore-scripts"
      : packageManager === "yarn"
        ? "yarn install --immutable"
        : "bun install --frozen-lockfile"
  throw new Error(
    `Repository-local OpenCode tools in ${toolFiles.map(filePath => path.relative(worktreeDirectory, filePath)).join(", ")} `
    + `require unresolved workspace package(s): ${unresolved.join(", ")}. `
    + `The isolated writer worktree has no local dependency installation for these packages. `
    + `Run "${installCommand}" from ${worktreeDirectory}, then retry team_spawn. `
    + "Ensemble will not share the lead repository's node_modules or relax worktree permissions.",
  )
}

async function readJson(
  read: (filePath: string) => Promise<string>,
  filePath: string,
): Promise<PackageManifest | null> {
  let text: string
  try {
    text = await read(filePath)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw new Error(`Repository-local OpenCode tool preflight could not read ${path.basename(filePath)}: ${safeError(error)}`)
  }
  try {
    return JSON.parse(text) as PackageManifest
  } catch {
    throw new Error(
      `Repository-local OpenCode tool preflight found malformed ${path.basename(filePath)} in ${path.dirname(filePath)}. `
      + "Fix the manifest before retrying team_spawn; no shared dependency fallback is permitted.",
    )
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 240)
  return "the filesystem returned an unreadable error"
}

async function discoverToolFiles(
  root: string,
  list: (directory: string) => Promise<string[]>,
  inspect: (filePath: string) => Promise<{ isDirectory(): boolean }>,
): Promise<string[]> {
  const files: string[] = []
  for (const relativeDirectory of TOOL_DIRECTORIES) {
    await collectSourceFiles(path.join(root, relativeDirectory), list, inspect, files)
  }
  return files
}

async function collectSourceFiles(
  directory: string,
  list: (directory: string) => Promise<string[]>,
  inspect: (filePath: string) => Promise<{ isDirectory(): boolean }>,
  files: string[],
): Promise<void> {
  let entries: string[]
  try {
    entries = await list(directory)
  } catch {
    return
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry)
    let info: { isDirectory(): boolean }
    try {
      info = await inspect(filePath)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      await collectSourceFiles(filePath, list, inspect, files)
      continue
    }
    if (SOURCE_EXTENSIONS.has(path.extname(entry))) files.push(filePath)
  }
}

function extractPackageImports(source: string): string[] {
  const imports = new Set<string>()
  const patterns = [
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+[^"']*?from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const imported = match[1]
      if (!imported || imported.startsWith(".") || imported.startsWith("/") || BUILTIN_PREFIXES.some(prefix => imported.startsWith(prefix))) continue
      imports.add(packageName(imported))
    }
  }
  return [...imports]
}

function packageName(imported: string): string {
  if (imported.startsWith("@")) return imported.split("/", 2).join("/")
  return imported.split("/", 1)[0] ?? imported
}

function packageNames(manifest: PackageManifest): Set<string> {
  const names = Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  }).filter(([, version]) => typeof version === "string" && (version.startsWith("workspace:") || version.startsWith("file:") || version.startsWith("link:")))
  return new Set(names.map(([name]) => name))
}

function packageManagerName(manifest: PackageManifest): "pnpm" | "npm" | "yarn" | "bun" | undefined {
  if (typeof manifest.packageManager === "string") {
    if (manifest.packageManager.startsWith("pnpm@")) return "pnpm"
    if (manifest.packageManager.startsWith("npm@")) return "npm"
    if (manifest.packageManager.startsWith("yarn@")) return "yarn"
    if (manifest.packageManager.startsWith("bun@")) return "bun"
  }
  if (manifest.workspaces !== undefined) return "npm"
  return undefined
}
