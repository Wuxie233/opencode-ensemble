import { describe, expect, test } from "bun:test"
import { renderError } from "../src/error"

describe("renderError", () => {
  test("keeps ordinary Error messages concise", () => {
    expect(renderError(new Error("plain failure"))).toBe("plain failure")
  })

  test("renders nested values and cycles safely", () => {
    const error: { data: { message: string }; cause?: unknown } = {
      data: { message: "git failed" },
    }
    error.cause = error

    expect(renderError(error)).toBe('{"data":{"message":"git failed"},"cause":"[Circular]"}')
  })

  test("bounds large diagnostic payloads", () => {
    const rendered = renderError({ message: "x".repeat(10_000), stderr: "y".repeat(10_000) }, 256)

    expect(rendered.length).toBeLessThanOrEqual(256)
    expect(rendered).toEndWith("...[truncated]")
  })
})
