const DEFAULT_ERROR_LENGTH = 4_096
const MAX_ERROR_DEPTH = 6
const MAX_ERROR_PROPERTIES = 24
const MAX_ERROR_ARRAY_ITEMS = 24
const MAX_ERROR_STRING_LENGTH = 1_024

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 15))}...[truncated]`
}

function diagnosticValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncate(value, MAX_ERROR_STRING_LENGTH)
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "undefined") return "[undefined]"
  if (typeof value === "symbol") return value.toString()
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`
  if (depth >= MAX_ERROR_DEPTH) return "[Max depth]"
  if (seen.has(value)) return "[Circular]"
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ERROR_ARRAY_ITEMS).map(item => diagnosticValue(item, depth + 1, seen))
    if (value.length > MAX_ERROR_ARRAY_ITEMS) items.push(`[${value.length - MAX_ERROR_ARRAY_ITEMS} more items]`)
    return items
  }

  const output: Record<string, unknown> = {}
  const reservedKeys = new Set<string>()
  if (value instanceof Error) {
    output.name = value.name
    output.message = truncate(value.message, MAX_ERROR_STRING_LENGTH)
    if (value.cause !== undefined) output.cause = diagnosticValue(value.cause, depth + 1, seen)
    reservedKeys.add("name")
    reservedKeys.add("message")
    reservedKeys.add("cause")
  }

  const descriptors = Object.getOwnPropertyDescriptors(value)
  const entries = Object.entries(descriptors)
    .filter(([key, descriptor]) => !reservedKeys.has(key) && "value" in descriptor)
    .slice(0, MAX_ERROR_PROPERTIES)
  entries.forEach(([key, descriptor]) => {
    output[key] = diagnosticValue(descriptor.value, depth + 1, seen)
  })
  const includedProperties = entries.length + [...reservedKeys].filter(key => key in descriptors).length
  if (Object.keys(descriptors).length > includedProperties) {
    output._truncated = `${Object.keys(descriptors).length - includedProperties} more properties`
  }
  return output
}

/** Render an unknown SDK or runtime failure without losing bounded structured diagnostics. */
export function renderError(error: unknown, maxLength = DEFAULT_ERROR_LENGTH): string {
  const limit = Math.max(32, maxLength)
  if (typeof error === "string") return truncate(error, limit)
  if (error instanceof Error && error.cause === undefined && Object.keys(error).length === 0) {
    return truncate(error.message, limit)
  }

  try {
    const rendered = JSON.stringify(diagnosticValue(error, 0, new WeakSet()))
    return truncate(rendered ?? String(error), limit)
  } catch {
    try {
      return truncate(String(error), limit)
    } catch {
      return "Unknown error"
    }
  }
}
