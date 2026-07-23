import { describe, expect, test } from "bun:test"
import { projectStructuredResults } from "../src/structured-result-projection"

function message(id: string, fromName: string, taskId: string | null, kind: "blocker" | "progress" | "result", summary: string, timeCreated: number) {
  const task = taskId ? `<task_id>${taskId}</task_id>` : ""
  return {
    id,
    fromName,
    timeCreated,
    content: `<task-result><kind>${kind}</kind>${task}<status>in_progress</status><summary>${summary}</summary><details>private evidence</details></task-result>`,
  }
}

describe("projectStructuredResults", () => {
  test("later progress and result resolve an earlier blocker", () => {
    const projected = projectStructuredResults([
      message("blocker-a", "alice", "task-a", "blocker", "Old blocker", 1),
      message("progress-a", "alice", "task-a", "progress", "Work resumed", 2),
      message("blocker-b", "bob", "task-b", "blocker", "Another blocker", 3),
      message("result-b", "bob", "task-b", "result", "Delivered", 4),
    ])

    expect(projected.map(item => [item.key, item.result.kind, item.result.summary])).toEqual([
      ["task:task-b", "result", "Delivered"],
      ["task:task-a", "progress", "Work resumed"],
    ])
  })

  test("completed tasks resolve their latest blocker while unresolved blockers remain visible", () => {
    const projected = projectStructuredResults([
      message("done-blocker", "alice", "task-done", "blocker", "Stale blocker", 2),
      message("open-blocker", "alice", "task-open", "blocker", "Still blocked", 1),
    ], [
      { id: "task-done", status: "completed" },
      { id: "task-open", status: "in_progress" },
    ])

    expect(projected.map(item => item.result.summary)).toEqual(["Still blocked"])
  })

  test("retains a latest result for a completed task", () => {
    const projected = projectStructuredResults([
      message("old-blocker", "alice", "task-done", "blocker", "Old blocker", 1),
      message("final-result", "alice", "task-done", "result", "Delivered", 2),
    ], [{ id: "task-done", status: "completed" }])

    expect(projected.map(item => [item.messageId, item.result.kind])).toEqual([["final-result", "result"]])
  })

  test("keeps independent task and member fallback states", () => {
    const projected = projectStructuredResults([
      message("alice-a", "alice", "task-a", "blocker", "Task A", 1),
      message("alice-b", "alice", "task-b", "blocker", "Task B", 2),
      message("alice-member", "alice", null, "blocker", "Alice fallback", 3),
      message("bob-member", "bob", null, "blocker", "Bob fallback", 4),
      message("alice-resume", "alice", null, "progress", "Alice resumed", 5),
    ])

    expect(projected.map(item => item.key)).toEqual(["member:alice", "member:bob", "task:task-b", "task:task-a"])
    expect(projected.find(item => item.key === "member:alice")?.result.summary).toBe("Alice resumed")
  })

  test("uses time and stable message id rather than input order", () => {
    const messages = [
      message("z-later-id", "alice", "task-a", "result", "Stable winner", 10),
      message("a-earlier-id", "alice", "task-a", "blocker", "Same timestamp loser", 10),
      message("newer", "bob", "task-b", "progress", "Newest task", 11),
    ]

    const first = projectStructuredResults(messages)
    const nextPoll = projectStructuredResults(messages.toReversed())
    expect(first).toEqual(nextPoll)
    expect(first.map(item => item.messageId)).toEqual(["newer", "z-later-id"])
  })
})
