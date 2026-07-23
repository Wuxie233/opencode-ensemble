import { parseTaskResult } from "./result-parser"

export interface StructuredResultMessage {
  id: string
  fromName: string
  content: string
  timeCreated: number
}

export interface StructuredResultTask {
  id: string
  status: string
}

export interface ProjectedStructuredResult {
  key: string
  messageId: string
  fromName: string
  timeCreated: number
  result: {
    kind: "progress" | "result" | "blocker"
    taskId?: string
    status: string
    summary: string
  }
}

/** Project the latest meaningful structured state for each task or member. */
export function projectStructuredResults(
  _messages: StructuredResultMessage[],
  _tasks: StructuredResultTask[] = [],
): ProjectedStructuredResult[] {
  const taskStatuses = new Map(_tasks.map(task => [task.id, task.status]))
  const latest = new Map<string, ProjectedStructuredResult>()
  const ordered = _messages.toSorted((left, right) =>
    right.timeCreated - left.timeCreated || right.id.localeCompare(left.id)
  )

  ordered.forEach(message => {
    const parsed = parseTaskResult(message.content)
    if (!parsed?.kind) return
    const key = parsed.taskId ? `task:${parsed.taskId}` : `member:${message.fromName}`
    if (latest.has(key)) return
    if (parsed.kind === "blocker" && parsed.taskId && taskStatuses.get(parsed.taskId) === "completed") return
    latest.set(key, {
      key,
      messageId: message.id,
      fromName: message.fromName,
      timeCreated: message.timeCreated,
      result: {
        kind: parsed.kind,
        taskId: parsed.taskId,
        status: parsed.status,
        summary: parsed.summary,
      },
    })
  })

  return [...latest.values()]
}
