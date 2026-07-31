import { describe, expect, test } from "bun:test"
import { DASHBOARD_HEAD } from "../src/dashboard-html"
import {
  DASHBOARD_JS_CORE,
  deriveDashboardAttention,
  findDashboardAgentIndex,
  nextDashboardAgentIndex,
  nextDashboardConnection,
  shouldIgnoreDashboardShortcut,
} from "../src/dashboard-js-core"
import { DASHBOARD_JS_EVENTS } from "../src/dashboard-js-events"
import { DASHBOARD_JS_RENDER } from "../src/dashboard-js-render"

function colorToken(group: string, key: string): string {
  const match = DASHBOARD_HEAD.match(new RegExp(`${group}:\\{[^}]*${key}:'#([0-9a-f]{6})'`))
  if (!match?.[1]) throw new Error(`Missing color token ${group}.${key}`)
  return match[1]
}

function contrastRatio(foreground: string, background: string): number {
  const channel = (hex: string, index: number) => Number.parseInt(hex.slice(index, index + 2), 16) / 255
  const linear = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  const luminance = (hex: string) => (0.2126 * linear(channel(hex, 0))) + (0.7152 * linear(channel(hex, 2))) + (0.0722 * linear(channel(hex, 4)))
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe("dashboard UI contract", () => {
  test("attention items are risk-first and carry actionable targets", () => {
    const result = deriveDashboardAttention({
      members: [
        { name: "builder", status: "busy", executionStatus: "running" },
        { name: "reviewer", status: "error", executionStatus: "failed" },
      ],
      tasks: [
        { id: "assigned", status: "blocked", assignee: "builder", content: "Waiting for API" },
        { id: "unassigned", status: "blocked", assignee: null, content: "Needs owner" },
      ],
      messages: [{
        id: "blocker-assigned",
        fromName: "builder",
        timeCreated: 1,
        content: "<task-result><kind>blocker</kind><task_id>assigned</task_id><status>pending</status><summary>API contract is unavailable</summary><details>Waiting for owner decision</details></task-result>",
      }],
    })

    expect(result.map(item => item.kind)).toEqual(["智能体错误", "阻塞报告"])
    expect(result[0]?.target).toEqual({ type: "agent", id: "reviewer" })
    expect(result[1]?.target).toEqual({ type: "agent", id: "builder" })
    expect(result[1]?.detail).toContain("API contract is unavailable")
  })

  test("attention projects only unresolved latest structured states", () => {
    const messages = [
      { id: "task-a-block", fromName: "builder", timeCreated: 1, content: "<task-result><kind>blocker</kind><task_id>task-a</task_id><status>pending</status><summary>Stale task blocker</summary><details>private</details></task-result>" },
      { id: "task-b-block", fromName: "builder", timeCreated: 2, content: "<task-result><kind>blocker</kind><task_id>task-b</task_id><status>pending</status><summary>Still blocked</summary><details>private</details></task-result>" },
      { id: "task-a-progress", fromName: "builder", timeCreated: 3, content: "<task-result><kind>progress</kind><task_id>task-a</task_id><status>in_progress</status><summary>Resumed</summary><details>private</details></task-result>" },
      { id: "task-done-block", fromName: "reviewer", timeCreated: 4, content: "<task-result><kind>blocker</kind><task_id>task-done</task_id><status>pending</status><summary>Completed stale blocker</summary><details>private</details></task-result>" },
    ]
    const source = {
      tasks: [
        { id: "task-a", status: "in_progress", assignee: "builder", content: "A" },
        { id: "task-b", status: "in_progress", assignee: "builder", content: "B" },
        { id: "task-done", status: "completed", assignee: "reviewer", content: "Done" },
      ],
      messages,
    }

    const first = deriveDashboardAttention(source)
    const nextPoll = deriveDashboardAttention({ ...source, messages: messages.toReversed() })
    expect(first).toEqual(nextPoll)
    expect(first.map(item => item.detail)).toEqual(["Still blocked"])
    expect(first[0]?.target).toEqual({ type: "agent", id: "builder" })
  })

  test("global shortcuts ignore editable and interactive controls", () => {
    expect(shouldIgnoreDashboardShortcut("INPUT", false, false)).toBe(true)
    expect(shouldIgnoreDashboardShortcut("DIV", true, false)).toBe(true)
    expect(shouldIgnoreDashboardShortcut("BUTTON", false, true)).toBe(true)
    expect(shouldIgnoreDashboardShortcut("BODY", false, false)).toBe(false)
  })

  test("agent roving focus wraps in both directions", () => {
    expect(nextDashboardAgentIndex(-1, 3, 1)).toBe(0)
    expect(nextDashboardAgentIndex(2, 3, 1)).toBe(0)
    expect(nextDashboardAgentIndex(0, 3, -1)).toBe(2)
    expect(nextDashboardAgentIndex(0, 0, 1)).toBe(-1)
    expect(findDashboardAgentIndex(["reviewer", "builder"], "builder", 0)).toBe(1)
    expect(findDashboardAgentIndex(["reviewer", "builder"], "missing", 1)).toBe(1)
  })

  test("connection transitions distinguish initial failure, stale data, and recovery", () => {
    expect(nextDashboardConnection("loading", "failure", false)).toBe("error")
    expect(nextDashboardConnection("live", "failure", true)).toBe("stale")
    expect(nextDashboardConnection("stale", "success", true)).toBe("recovered")
    expect(nextDashboardConnection("recovered", "success", true)).toBe("live")
  })

  test("HTML shell exposes triage cockpit regions", () => {
    expect(DASHBOARD_HEAD).toContain('<html lang="zh-CN">')
    expect(DASHBOARD_HEAD).toContain('id="attention"')
    expect(DASHBOARD_HEAD).toContain('aria-label="团队关注事项"')
    expect(DASHBOARD_HEAD).toContain('aria-label="项目导航"')
    expect(DASHBOARD_HEAD).toContain('aria-label="智能体列表"')
    expect(DASHBOARD_HEAD).toContain('aria-label="任务看板"')
    expect(DASHBOARD_HEAD).toContain('aria-label="活动动态"')
    expect(DASHBOARD_HEAD).toContain('aria-label="事件时间线"')
    expect(DASHBOARD_HEAD).toContain('id="drawer-title"')
    expect(DASHBOARD_HEAD).toContain('id="drawer" class="scroll p-4" tabindex="-1" inert')
  })

  test("fixed dashboard chrome is constrained on narrow viewports", () => {
    expect(DASHBOARD_HEAD).toContain("px-3 sm:px-4")
    expect(DASHBOARD_HEAD).toContain("gap-2 sm:gap-3 min-w-0 flex-1")
    expect(DASHBOARD_HEAD).toContain('id="sum"')
    expect(DASHBOARD_HEAD).toContain("flex-wrap")
    expect(DASHBOARD_HEAD).not.toContain('id="sum" class="fixed')
    expect(DASHBOARD_HEAD).not.toContain("min-resolution:1.75dppx")
    expect(DASHBOARD_HEAD).toContain("minmax(min(300px,100%),1fr)")
  })

  test("project navigation uses docs-style outline semantics", () => {
    expect(DASHBOARD_HEAD).toContain('id="projects"')
    expect(DASHBOARD_JS_RENDER).toContain('<nav class="text-[12px]"')
    expect(DASHBOARD_JS_RENDER).toContain('class="project-link')
    expect(DASHBOARD_JS_RENDER).toContain('class="team-link')
    expect(DASHBOARD_JS_RENDER).toContain('border-l-2')
    expect(DASHBOARD_JS_RENDER).toContain("function renderProjectNavHeader")
    expect(DASHBOARD_JS_RENDER).toContain("function renderProjectButton")
    expect(DASHBOARD_JS_RENDER).toContain("function renderTeamLink")
    expect(DASHBOARD_JS_RENDER).toContain("[...teams].sort")
    expect(DASHBOARD_JS_RENDER).toContain("statusTitleProject")
    expect(DASHBOARD_JS_RENDER).toContain("statusTitleTeam")
    expect(DASHBOARD_JS_CORE).toContain("function projectLabel")
    expect(DASHBOARD_JS_EVENTS).toContain("function selectProject")
    expect(DASHBOARD_JS_EVENTS).toContain("function selectTeam")
  })

  test("project navigation can collapse", () => {
    expect(DASHBOARD_HEAD).not.toContain('<button id="nav-toggle"')
    expect(DASHBOARD_HEAD).toContain('id="project-rail"')
    expect(DASHBOARD_HEAD).toContain('id="nav-expand"')
    expect(DASHBOARD_JS_RENDER).toContain('id="nav-toggle"')
    expect(DASHBOARD_JS_RENDER).toContain('aria-label="隐藏项目导航"')
    expect(DASHBOARD_HEAD).toContain("#content.nav-collapsed")
    expect(DASHBOARD_HEAD).toContain("#projects[hidden]")
    expect(DASHBOARD_HEAD).toContain("#project-rail[hidden]")
    expect(DASHBOARD_JS_EVENTS).toContain("function applyNavCollapse")
    expect(DASHBOARD_JS_EVENTS).toContain("id==='nav-toggle'")
    expect(DASHBOARD_JS_EVENTS).toContain("aria-expanded")
    expect(DASHBOARD_JS_EVENTS).toContain("projects.hidden=navCollapsed")
    expect(DASHBOARD_JS_EVENTS).toContain("rail.hidden=!navCollapsed")
    expect(DASHBOARD_JS_EVENTS).toContain("expand.focus()")
    expect(DASHBOARD_JS_EVENTS).toContain("toggle.focus()")
    expect(DASHBOARD_JS_EVENTS).toContain("aria-hidden")
  })

  test("dashboard polls state relative to the served page", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("fetch('api/state')")
    expect(DASHBOARD_JS_EVENTS).not.toContain("fetch('/api/state')")
  })

  test("agent prioritization helpers are defined", () => {
    expect(DASHBOARD_JS_CORE).toContain("function rankAgent")
    expect(DASHBOARD_JS_CORE).toContain("function deriveAttention")
  })

  test("attention renderer exposes urgent triage copy", () => {
    expect(DASHBOARD_JS_RENDER).toContain("function rAttention")
    expect(DASHBOARD_JS_RENDER).toContain("需要关注")
    expect(DASHBOARD_JS_EVENTS).toContain("activateAttention")
    expect(DASHBOARD_JS_RENDER).toContain("data-attention-type")
    expect(DASHBOARD_JS_RENDER).toContain("break-words")
    expect(DASHBOARD_JS_RENDER).toContain("line-clamp-3")
  })

  test("connection UI preserves last-good data and announces state changes", () => {
    expect(DASHBOARD_HEAD).toContain('id="connection-state"')
    expect(DASHBOARD_HEAD).toContain('role="status"')
    expect(DASHBOARD_HEAD).toContain('aria-live="polite"')
    expect(DASHBOARD_JS_EVENTS).toContain("if(!res.ok)throw new Error")
    expect(DASHBOARD_JS_EVENTS).toContain("nextConnection(connectionMode,'failure',!!S)")
    expect(DASHBOARD_JS_CORE).toContain("pollInFlight=false")
    expect(DASHBOARD_JS_EVENTS).toContain("if(pollInFlight)return")
    expect(DASHBOARD_JS_EVENTS).toContain("finally{pollInFlight=false}")
    expect(DASHBOARD_JS_EVENTS).not.toContain("catch{if(++fails>=3)conn(false)}")
  })

  test("timeline and project navigation support touch, keyboard, and scale", () => {
    expect(DASHBOARD_HEAD).toContain("touch-action:pan-x")
    expect(DASHBOARD_HEAD).toContain("overflow-wrap:anywhere")
    expect(DASHBOARD_HEAD).toContain("max-h-[45vh]")
    expect(DASHBOARD_HEAD).toContain("lg:max-h-[calc(100vh-112px)]")
    expect(DASHBOARD_JS_RENDER).toContain('class="timeline-event')
    expect(DASHBOARD_JS_RENDER).toContain('tabindex="0"')
    expect(DASHBOARD_JS_RENDER).toContain("toggleTimelineEvent(this)")
    expect(DASHBOARD_JS_EVENTS).toContain("function toggleTimelineEvent")
    expect(DASHBOARD_JS_CORE).toContain("timelinePinned=null")
    expect(DASHBOARD_JS_EVENTS).toContain("timelinePinned=timelinePinned===id?null:id")
    expect(DASHBOARD_JS_RENDER).toContain("timelinePinned===key?'true':'false'")
    expect(DASHBOARD_HEAD).toContain("min-h-10")
  })

  test("adaptive workspace uses the full width without nested agent-card controls", () => {
    expect(DASHBOARD_HEAD).toContain('class="workspace grid grid-cols-1')
    expect(DASHBOARD_HEAD).toContain('class="triage-panels grid grid-cols-1 xl:grid-cols-2')
    expect(DASHBOARD_JS_RENDER).not.toContain('<details class="mt-1"><summary')
    expect(DASHBOARD_JS_RENDER).toContain("打开智能体详情查看完整消息")
    expect(DASHBOARD_JS_RENDER).not.toContain("openDrawer(this.dataset.card)}\"")
    expect(DASHBOARD_JS_RENDER).not.toContain("toggleTimelineEvent(this)}\"")
    expect(DASHBOARD_JS_CORE).toContain("selectedAgent=null")
    expect(DASHBOARD_JS_EVENTS).toContain("function restoreModalFocus")
    expect(DASHBOARD_JS_RENDER).toContain("focusedAgent")
    expect(DASHBOARD_JS_RENDER).toContain("focusedAgent===selectedAgent")
    expect(DASHBOARD_JS_RENDER).toContain("等待依赖")
  })

  test("runtime chips can shrink and wrap long identifiers", () => {
    expect(DASHBOARD_JS_CORE).toContain("max-w-full min-w-0")
    expect(DASHBOARD_JS_CORE).toContain("break-all whitespace-normal")
    expect(DASHBOARD_HEAD).toContain('id="ct" class="hidden sm:inline')
    expect(DASHBOARD_JS_RENDER).toContain("max-w-[7rem] truncate")
    expect(DASHBOARD_JS_RENDER).toContain('id="drawer-title" class="runtime-text')
    expect(DASHBOARD_JS_RENDER).toContain("max-w-full truncate text-txt-500")
    expect(DASHBOARD_JS_RENDER).toContain("max-w-[45%] truncate text-[11px]")
  })

  test("timeline events preserve source identity for stable interaction", () => {
    expect(DASHBOARD_JS_CORE).toContain("key:'member|'+m.name+'|spawn'")
    expect(DASHBOARD_JS_CORE).toContain("key:'message|'+m.id")
    expect(DASHBOARD_JS_CORE).toContain("key:'task|'+x.id+'|done'")
    expect(DASHBOARD_JS_CORE).toContain("const projected=new Map(projectR(t).map(x=>[x.messageId,x]))")
    expect(DASHBOARD_JS_CORE).toContain("if(p&&!projected.has(m.id))return")
    expect(DASHBOARD_JS_RENDER).toContain("const key=ev.key")
  })

  test("keyboard and accessibility hooks are present", () => {
    expect(DASHBOARD_JS_RENDER).toContain("onkeydown")
    expect(DASHBOARD_JS_RENDER).toContain("aria-expanded")
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='Enter'")
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='Escape'")
  })

  test("shortcut overlay exposes dialog semantics", () => {
    expect(DASHBOARD_HEAD).toContain('id="sco" role="dialog"')
    expect(DASHBOARD_HEAD).toContain('aria-modal="true"')
    expect(DASHBOARD_HEAD).toContain('aria-hidden="true"')
    expect(DASHBOARD_HEAD).toContain('aria-labelledby="shortcuts-title"')
    expect(DASHBOARD_HEAD).toContain('tabindex="-1"')
    expect(DASHBOARD_HEAD).toContain('id="shortcuts-title"')
  })

  test("shortcut overlay manages modal focus", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("function openShortcuts")
    expect(DASHBOARD_JS_EVENTS).toContain("function closeShortcuts")
    expect(DASHBOARD_JS_EVENTS).toContain("function setBackgroundInert")
    expect(DASHBOARD_JS_EVENTS).toContain("function modalOpen")
    expect(DASHBOARD_JS_EVENTS).toContain("function trapFocus")
    expect(DASHBOARD_JS_EVENTS).toContain("el.inert=locked")
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='Tab'")
    expect(DASHBOARD_JS_EVENTS).toContain("document.getElementById('sco').focus()")
    expect(DASHBOARD_JS_EVENTS).toContain("aria-hidden")
    expect(DASHBOARD_JS_EVENTS).toContain("if(!modalOpen())setBackgroundInert(false)")
  })

  test("agent drawer exposes named close control and modal focus handling", () => {
    expect(DASHBOARD_JS_RENDER).toContain('id="drawer-close"')
    expect(DASHBOARD_JS_RENDER).toContain('aria-label="关闭智能体详情"')
    expect(DASHBOARD_JS_RENDER).toContain("setBackgroundInert(true)")
    expect(DASHBOARD_JS_RENDER).toContain("drawer.inert=false")
    expect(DASHBOARD_JS_RENDER).toContain("drawer.inert=true")
    expect(DASHBOARD_JS_RENDER).toContain("drawer.focus()")
    expect(DASHBOARD_JS_RENDER).toContain("if(!modalOpen())setBackgroundInert(false)")
    expect(DASHBOARD_JS_EVENTS).toContain("trapFocus(document.getElementById('drawer'),e)")
    expect(DASHBOARD_JS_EVENTS).toContain("drawerOpen&&e.key==='?'")
  })

  test("small dashboard text tokens stay readable on dark surfaces", () => {
    const darkSurfaces = [colorToken("base", "950"), colorToken("base", "900")]
    const smallText = [colorToken("txt", "400"), colorToken("txt", "500")]

    for (const text of smallText) {
      for (const surface of darkSurfaces) {
        expect(contrastRatio(text, surface)).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test("agent cards do not dim operational text with whole-card opacity", () => {
    expect(DASHBOARD_JS_RENDER).not.toContain("opacity-50")
  })

  test("drawer includes activity timeline section", () => {
    expect(DASHBOARD_JS_RENDER).toContain("drawer-activity-list")
    expect(DASHBOARD_JS_RENDER).toContain("rDrawerActivityUpdate")
    expect(DASHBOARD_JS_RENDER).toContain("fetchActivity")
  })

  test("drawer has verbose toggle control", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("function toggleVerbose")
    expect(DASHBOARD_JS_RENDER).toContain("toggleVerbose()")
    expect(DASHBOARD_JS_RENDER).toContain("id=\"verbose-toggle\"")
    expect(DASHBOARD_JS_RENDER).toContain("aria-pressed")
    expect(DASHBOARD_JS_RENDER).toContain("详细模式：")
  })

  test("activity fetch uses relative path", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("fetch('api/session/'")
    expect(DASHBOARD_JS_EVENTS).not.toContain("fetch('/api/session/'")
  })

  test("verbose preference persists to localStorage", () => {
    expect(DASHBOARD_JS_CORE).toContain("localStorage.getItem('ensemble-verbose')")
    expect(DASHBOARD_JS_EVENTS).toContain("localStorage.setItem('ensemble-verbose'")
  })

  test("v keyboard shortcut toggles verbose", () => {
    expect(DASHBOARD_JS_EVENTS).toContain("e.key==='v'")
    expect(DASHBOARD_JS_EVENTS).toContain("toggleVerbose()")
  })

  test("v shortcut appears in shortcuts overlay", () => {
    expect(DASHBOARD_HEAD).toContain(">v</kbd>")
    expect(DASHBOARD_HEAD).toContain("切换详细模式")
  })

  test("activity timeline renders reasoning blocks", () => {
    expect(DASHBOARD_JS_RENDER).toContain("reasoning")
    expect(DASHBOARD_JS_RENDER).toContain("推理过程")
  })

  test("activity timeline renders file parts", () => {
    expect(DASHBOARD_JS_RENDER).toContain("file")
    expect(DASHBOARD_JS_RENDER).toContain("filePath")
  })

  test("activity timeline renders text prompts and responses", () => {
    expect(DASHBOARD_JS_RENDER).toContain("text")
    expect(DASHBOARD_JS_RENDER).toContain("提示词")
    expect(DASHBOARD_JS_RENDER).toContain("响应")
  })

  test("fixed dashboard copy and known enum labels are Simplified Chinese", () => {
    expect(DASHBOARD_HEAD).toContain("等待团队创建")
    expect(DASHBOARD_HEAD).toContain("键盘快捷键")
    expect(DASHBOARD_JS_CORE).toContain("function enumLabel")
    expect(DASHBOARD_JS_CORE).toContain("工作中")
    expect(DASHBOARD_JS_CORE).toContain("正在停止")
    expect(DASHBOARD_JS_CORE).toContain("已超时")
    expect(DASHBOARD_JS_CORE).toContain("高")
    expect(DASHBOARD_JS_RENDER).toContain("暂无任务")
    expect(DASHBOARD_JS_RENDER).toContain("等待智能体消息")
  })

  test("relative and duration time use Chinese units", () => {
    expect(DASHBOARD_JS_CORE).toContain("return'刚刚'")
    expect(DASHBOARD_JS_EVENTS).toContain("'刚刚更新'")
    expect(DASHBOARD_JS_CORE).toContain("秒前")
    expect(DASHBOARD_JS_CORE).toContain("分钟前")
    expect(DASHBOARD_JS_CORE).toContain("小时前")
    expect(DASHBOARD_JS_CORE).toContain("天前")
    expect(DASHBOARD_JS_CORE).toContain("秒")
    expect(DASHBOARD_JS_CORE).toContain("分钟")
    expect(DASHBOARD_JS_CORE).toContain("小时")
  })

  test("runtime-provided content remains escaped but otherwise verbatim", () => {
    expect(DASHBOARD_JS_RENDER).toContain("E(p.name||p.path||p.id)")
    expect(DASHBOARD_JS_RENDER).toContain("E(t.name)")
    expect(DASHBOARD_JS_RENDER).toContain("E(m.name)")
    expect(DASHBOARD_JS_RENDER).toContain("E(m.profile||m.agent)")
    expect(DASHBOARD_JS_RENDER).toContain("'runtime '+E(m.agent)")
    expect(DASHBOARD_JS_RENDER).toContain("E(m.model)")
    expect(DASHBOARD_JS_RENDER).toContain("md(m.prompt)")
    expect(DASHBOARD_JS_RENDER).toContain("md(am.content)")
    expect(DASHBOARD_JS_RENDER).toContain("E(a.error)")
    expect(DASHBOARD_JS_RENDER).toContain("E(a.command)")
    expect(DASHBOARD_JS_RENDER).toContain("E(fcontent)")
  })

  test("activity drawer exposes localized loading and error states", () => {
    expect(DASHBOARD_JS_RENDER).toContain("正在加载活动记录")
    expect(DASHBOARD_JS_RENDER).toContain("活动记录加载失败")
    expect(DASHBOARD_JS_EVENTS).toContain("drawerActivityError")
  })
})
