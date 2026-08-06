import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { preflightRepositoryLocalTools } from "../src/tool-resolution"

describe("repository-local OpenCode tool resolution", () => {
  test("accepts tools with a locally installed workspace dependency", async () => {
    const root = await mkdtemp("/tmp/ensemble-tool-resolution-")
    try {
      await mkdir(path.join(root, ".opencode", "tools"), { recursive: true })
      await mkdir(path.join(root, "node_modules", "@acme", "shared-tool"), { recursive: true })
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        packageManager: "pnpm@10.0.0",
        dependencies: { "@acme/shared-tool": "workspace:*" },
      }))
      await writeFile(path.join(root, ".opencode", "tools", "inspect.ts"), 'import { helper } from "@acme/shared-tool"\nexport default helper\n')

      await expect(preflightRepositoryLocalTools(root)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails with isolated install guidance when a workspace dependency is absent", async () => {
    const root = await mkdtemp("/tmp/ensemble-tool-resolution-")
    try {
      await mkdir(path.join(root, ".opencode", "tools"), { recursive: true })
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        packageManager: "pnpm@10.0.0",
        dependencies: { "@acme/shared-tool": "workspace:*" },
      }))
      await writeFile(path.join(root, ".opencode", "tools", "inspect.ts"), 'import { helper } from "@acme/shared-tool"\nexport default helper\n')

      await expect(preflightRepositoryLocalTools(root)).rejects.toThrow(
        `Run "pnpm install --offline" from ${root}`,
      )
      await expect(preflightRepositoryLocalTools(root)).rejects.toThrow("will not share the lead repository's node_modules")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed manifests without exposing manifest contents", async () => {
    const root = await mkdtemp("/tmp/ensemble-tool-resolution-")
    try {
      await mkdir(path.join(root, ".opencode", "tools"), { recursive: true })
      await writeFile(path.join(root, "package.json"), '{ "dependencies": ["private-token-should-not-leak"')
      await writeFile(path.join(root, ".opencode", "tools", "inspect.ts"), 'export default {}\n')

      await expect(preflightRepositoryLocalTools(root)).rejects.toThrow("malformed package.json")
      await expect(preflightRepositoryLocalTools(root)).rejects.not.toThrow("private-token-should-not-leak")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("ignores repository-local tools with only relative and builtin imports", async () => {
    const root = await mkdtemp("/tmp/ensemble-tool-resolution-")
    try {
      await mkdir(path.join(root, ".opencode", "tool"), { recursive: true })
      await writeFile(path.join(root, "package.json"), JSON.stringify({
        packageManager: "pnpm@10.0.0",
        dependencies: { "@acme/shared-tool": "workspace:*" },
      }))
      await writeFile(path.join(root, ".opencode", "tool", "inspect.ts"), 'import path from "node:path"\nimport local from "./local"\nexport default { path, local }\n')

      await expect(preflightRepositoryLocalTools(root)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("requires package metadata when a repository-local tool imports a package", async () => {
    const root = await mkdtemp("/tmp/ensemble-tool-resolution-")
    try {
      await mkdir(path.join(root, ".opencode", "tools"), { recursive: true })
      await writeFile(path.join(root, ".opencode", "tools", "inspect.ts"), 'import helper from "unlisted-package"\nexport default helper\n')

      await expect(preflightRepositoryLocalTools(root)).rejects.toThrow("has no package.json")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
