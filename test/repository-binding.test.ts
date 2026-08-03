import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { verifyRepositoryRoot } from "../src/repository-binding"

const temporary: string[] = []

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ensemble-binding-"))
  temporary.push(directory)
  return directory
}

async function git(directory: string, args: string[]): Promise<void> {
  const process = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const exitCode = await process.exited
  if (exitCode !== 0) throw new Error(await new Response(process.stderr).text())
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("repository binding", () => {
  test("accepts an explicit nested repository root", async () => {
    const controller = await tempDir()
    const repository = path.join(controller, "nested")
    await mkdir(repository)
    await git(repository, ["init"])
    const binding = await verifyRepositoryRoot(repository, true)
    expect(binding.repositoryRoot).toBe(repository)
    expect(binding.gitIdentity).toBe(path.join(repository, ".git"))
  })

  test("implicit resolution canonicalizes a subdirectory to its Git root", async () => {
    const repository = await tempDir()
    await git(repository, ["init"])
    const child = path.join(repository, "src")
    await mkdir(child)
    expect((await verifyRepositoryRoot(child, false)).repositoryRoot).toBe(repository)
  })

  test("rejects relative, missing, file, non-repository, and explicit non-root paths", async () => {
    await expect(verifyRepositoryRoot("relative", true)).rejects.toThrow("absolute")
    const base = await tempDir()
    await expect(verifyRepositoryRoot(path.join(base, "missing"), true)).rejects.toThrow("does not exist")
    const file = path.join(base, "file")
    await writeFile(file, "x")
    await expect(verifyRepositoryRoot(file, true)).rejects.toThrow("directory")
    await expect(verifyRepositoryRoot(base, true)).rejects.toThrow("not inside a Git repository")
    await git(base, ["init"])
    const child = path.join(base, "child")
    await mkdir(child)
    await expect(verifyRepositoryRoot(child, true)).rejects.toThrow("exact Git repository root")
  })
})
