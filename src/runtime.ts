import { ActivityBuffer } from "./activity"
import { createDb, type Database } from "./db"
import { startDashboard, type DashboardServer } from "./dashboard"
import type { PluginClient } from "./types"

interface RuntimeDependencies {
  openDb(path: string): Database
  startDashboard(
    db: Database,
    port: number,
    options?: { activityBuffer?: ActivityBuffer; client?: PluginClient },
  ): Promise<DashboardServer | null>
}

interface AcquireOptions {
  dbPath: string
  dashboardPort?: number
  dashboardClient?: PluginClient
}

export interface RuntimeHandle {
  db: Database
  activityBuffer: ActivityBuffer
  recover(projectKey: string, recover: (db: Database) => Promise<void>): Promise<void>
  release(): void
}

export function createLocalDisposer(
  watchdog: { stop(): void },
  runtime: { release(): void },
): () => void {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    watchdog.stop()
    runtime.release()
  }
}

export function createRuntimeCoordinator(dependencies: RuntimeDependencies) {
  let db: Database | undefined
  let dbPath: string | undefined
  let references = 0
  let dashboard: DashboardServer | null | undefined
  let dashboardStart: Promise<DashboardServer | null> | undefined
  let dashboardPort: number | undefined
  let activityBuffer: ActivityBuffer | undefined
  let background = 0
  const recoveries = new Map<string, Promise<void>>()

  const closeIfIdle = () => {
    if (references !== 0 || background !== 0) return
    dashboard?.stop(true)
    dashboard = undefined
    dashboardStart = undefined
    dashboardPort = undefined
    db?.close()
    db = undefined
    dbPath = undefined
    activityBuffer = undefined
    recoveries.clear()
  }

  const runRecovery = (projectKey: string, recover: () => Promise<void>) => {
    const existing = recoveries.get(projectKey)
    if (existing) return existing
    background++
    const current = recover()
      .catch((error) => {
        recoveries.delete(projectKey)
        throw error
      })
      .finally(() => {
        background--
        closeIfIdle()
      })
    recoveries.set(projectKey, current)
    return current
  }

  const acquire = async (options: AcquireOptions): Promise<RuntimeHandle> => {
    if (db && dbPath !== options.dbPath) {
      throw new Error(`Ensemble runtime already owns database ${dbPath}`)
    }
    if (!db) {
      db = dependencies.openDb(options.dbPath)
      dbPath = options.dbPath
    }
    if (!activityBuffer) activityBuffer = new ActivityBuffer()
    const currentDb = db
    const currentActivityBuffer = activityBuffer
    references++

    try {
      if (options.dashboardPort && options.dashboardPort !== 0) {
        if (dashboardPort !== undefined && dashboardPort !== options.dashboardPort) {
          throw new Error(`Ensemble dashboard already uses port ${dashboardPort}`)
        }
        if (!dashboardStart) {
          dashboardPort = options.dashboardPort
          dashboardStart = dependencies
            .startDashboard(currentDb, options.dashboardPort, {
              activityBuffer: currentActivityBuffer,
              client: options.dashboardClient,
            })
            .then((server) => {
              dashboard = server
              return server
            })
            .catch((error) => {
              dashboardStart = undefined
              dashboardPort = undefined
              throw error
            })
        }
        await dashboardStart
      }
    } catch (error) {
      references--
      closeIfIdle()
      throw error
    }

    let released = false
    return {
      db: currentDb,
      activityBuffer: currentActivityBuffer,
      recover(projectKey, recover) {
        if (released) return Promise.reject(new Error("Ensemble runtime handle already released"))
        return runRecovery(projectKey, () => recover(currentDb))
      },
      release() {
        if (released) return
        released = true
        references--
        closeIfIdle()
      },
    }
  }

  return { acquire }
}

export const processRuntime = createRuntimeCoordinator({
  openDb: createDb,
  startDashboard,
})
