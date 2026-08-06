import { describe, expect, test } from "bun:test"
import { ActivityBuffer } from "../src/activity"
import type { Database } from "../src/db"
import { createLocalDisposer, createRuntimeCoordinator, startMainWatchdog } from "../src/runtime"

function fakeDb(onClose: () => void): Database {
  return {
    exec() {},
    query() {
      return { get() {}, all() { return [] }, run() {} }
    },
    run() {
      return { changes: 0 }
    },
    transaction(fn) {
      return fn
    },
    close: onClose,
  }
}

describe("process runtime lifecycle", () => {
  test("does not start a watchdog for a worktree directory instance", () => {
    let created = 0
    let started = 0

    const watchdog = startMainWatchdog(false, () => {
      created++
      return { start() { started++ } }
    })

    expect(watchdog).toBeUndefined()
    expect(created).toBe(0)
    expect(started).toBe(0)
  })

  test("shares one database and dashboard until the final directory releases them", async () => {
    let dbOpens = 0
    let dbCloses = 0
    let dashboardStarts = 0
    let dashboardStops = 0
    const runtime = createRuntimeCoordinator({
      openDb() {
        dbOpens++
        return fakeDb(() => dbCloses++)
      },
      async startDashboard() {
        dashboardStarts++
        return { stop() { dashboardStops++ } }
      },
    })

    const first = await runtime.acquire({ dbPath: "/tmp/ensemble.db", dashboardPort: 4747 })
    const second = await runtime.acquire({ dbPath: "/tmp/ensemble.db", dashboardPort: 4747 })

    expect(first.db).toBe(second.db)
    expect(first.activityBuffer).toBeInstanceOf(ActivityBuffer)
    expect(first.activityBuffer).toBe(second.activityBuffer)
    expect(dbOpens).toBe(1)
    expect(dashboardStarts).toBe(1)

    first.release()
    expect(dbCloses).toBe(0)
    expect(dashboardStops).toBe(0)

    second.release()
    expect(dbCloses).toBe(1)
    expect(dashboardStops).toBe(1)

    const third = await runtime.acquire({ dbPath: "/tmp/ensemble.db", dashboardPort: 4747 })
    expect(dbOpens).toBe(2)
    expect(dashboardStarts).toBe(2)
    third.release()
  })

  test("deduplicates concurrent recovery per project and retries after failure", async () => {
    let attempts = 0
    let unblock: (() => void) | undefined
    const runtime = createRuntimeCoordinator({
      openDb: () => fakeDb(() => {}),
      startDashboard: async () => null,
    })
    const firstHandle = await runtime.acquire({ dbPath: "/tmp/ensemble.db" })
    const secondHandle = await runtime.acquire({ dbPath: "/tmp/ensemble.db" })
    const first = firstHandle.recover(
      "/project/a",
      async () => {
        attempts++
        await new Promise<void>((resolve) => { unblock = resolve })
      },
    )
    const second = secondHandle.recover("/project/a", async () => { attempts++ })

    await Bun.sleep(0)
    expect(attempts).toBe(1)
    unblock?.()
    await Promise.all([first, second])

    const failure = new Error("recovery failed")
    await expect(firstHandle.recover("/project/b", async () => {
      attempts++
      throw failure
    })).rejects.toBe(failure)

    await firstHandle.recover("/project/b", async () => { attempts++ })
    expect(attempts).toBe(3)
    firstHandle.release()
    secondHandle.release()
  })

  test("keeps shared resources open until background recovery finishes", async () => {
    let closes = 0
    let unblock: (() => void) | undefined
    const runtime = createRuntimeCoordinator({
      openDb: () => fakeDb(() => closes++),
      startDashboard: async () => null,
    })
    const handle = await runtime.acquire({ dbPath: "/tmp/ensemble.db" })
    const recovery = handle.recover("/project/a", async () => {
      await new Promise<void>((resolve) => { unblock = resolve })
    })

    handle.release()
    expect(closes).toBe(0)

    unblock?.()
    await recovery
    expect(closes).toBe(1)
  })

  test("release is idempotent", async () => {
    let closes = 0
    const runtime = createRuntimeCoordinator({
      openDb: () => fakeDb(() => closes++),
      startDashboard: async () => null,
    })
    const handle = await runtime.acquire({ dbPath: "/tmp/ensemble.db" })
    handle.release()
    handle.release()
    expect(closes).toBe(1)
  })

  test("reports database startup failures once and preserves the rejection", async () => {
    const failure = new Error("file is not a database: /private/project/ensemble.db")
    let diagnostics = 0
    const runtime = createRuntimeCoordinator({
      openDb: () => { throw failure },
      startDashboard: async () => null,
    })

    await expect(runtime.acquire({
      dbPath: "/private/project/ensemble.db",
      onDatabaseInitializationError: (error) => {
        diagnostics++
        expect(error).toBe(failure)
      },
    })).rejects.toBe(failure)
    expect(diagnostics).toBe(1)
  })

  test("each directory dispose stops its own watchdog before releasing shared resources", () => {
    const calls: string[] = []
    const first = createLocalDisposer(
      { stop() { calls.push("watchdog:first") } },
      { release() { calls.push("runtime:first") } },
    )
    const second = createLocalDisposer(
      { stop() { calls.push("watchdog:second") } },
      { release() { calls.push("runtime:second") } },
    )

    first()
    second()
    first()

    expect(calls).toEqual([
      "watchdog:first",
      "runtime:first",
      "watchdog:second",
      "runtime:second",
    ])
  })
})
