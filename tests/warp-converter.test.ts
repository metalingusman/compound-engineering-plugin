import { describe, expect, test } from "bun:test"
import { convertClaudeToWarp } from "../src/converters/claude-to-warp"
import type { ClaudePlugin } from "../src/types/claude"

const fixturePlugin: ClaudePlugin = {
  root: "/tmp/plugin",
  manifest: { name: "fixture", version: "1.0.0" },
  agents: [
    {
      name: "security-sentinel",
      description: "Performs security audits and OWASP-aligned vulnerability assessments.",
      model: "inherit",
      body: "You are an Application Security Specialist. Focus on vulnerabilities first.",
      sourcePath: "/tmp/plugin/agents/review/security-sentinel.md",
    },
    {
      name: "code-simplicity-reviewer",
      body: "Final pass for simplicity and minimalism.",
      sourcePath: "/tmp/plugin/agents/review/code-simplicity-reviewer.md",
    },
  ],
  commands: [],
  skills: [
    {
      name: "ce-plan",
      description: "Planning skill",
      sourceDir: "/tmp/plugin/skills/ce-plan",
      skillPath: "/tmp/plugin/skills/ce-plan/SKILL.md",
    },
    {
      name: "claude-only",
      description: "Skill that only ships on Claude Code",
      ce_platforms: ["claude"],
      sourceDir: "/tmp/plugin/skills/claude-only",
      skillPath: "/tmp/plugin/skills/claude-only/SKILL.md",
    },
  ],
  hooks: undefined,
  mcpServers: {
    "agent-browser": { command: "agent-browser", args: ["server"] },
    "untracked-server": { command: "echo" },
  },
}

const baseOptions = {
  agentMode: "subagent" as const,
  inferTemperature: true,
  permissions: "none" as const,
  codexIncludeSkills: false,
}

describe("convertClaudeToWarp", () => {
  test("filters out skills not flagged for warp", () => {
    const bundle = convertClaudeToWarp(fixturePlugin, baseOptions)
    expect(bundle.skillDirs.map((s) => s.name)).toEqual(["ce-plan"])
  })

  test("lowers each agent into a frontmatter-stripped persona file", () => {
    const bundle = convertClaudeToWarp(fixturePlugin, baseOptions)
    expect(bundle.agents).toHaveLength(2)
    const sentinel = bundle.agents.find((a) => a.name === "security-sentinel")
    expect(sentinel).toBeDefined()
    // No YAML frontmatter on the lowered file — the file is read by the
    // dispatching skill at runtime, not loaded by Warp's skill discovery.
    expect(sentinel!.content.startsWith("---")).toBe(false)
    // The synthesized intro names the persona and includes the description.
    expect(sentinel!.content).toContain("# Persona: security-sentinel")
    expect(sentinel!.content).toContain("Performs security audits")
    // Original body is preserved.
    expect(sentinel!.content).toContain("Application Security Specialist")
  })

  test("agent without description still gets a heading-only intro", () => {
    const bundle = convertClaudeToWarp(fixturePlugin, baseOptions)
    const reviewer = bundle.agents.find((a) => a.name === "code-simplicity-reviewer")
    expect(reviewer).toBeDefined()
    expect(reviewer!.content).toContain("# Persona: code-simplicity-reviewer")
    expect(reviewer!.content).toContain("Final pass for simplicity and minimalism.")
  })

  test("declared MCP servers are preserved in postinstall hint order", () => {
    const bundle = convertClaudeToWarp(fixturePlugin, baseOptions)
    // Recommended-list servers come first when present, then everything else
    // declared by the manifest, deduped.
    expect(bundle.recommendedMcpServers).toContain("agent-browser")
    expect(bundle.recommendedMcpServers).toContain("untracked-server")
  })

  test("falls back to the recommended list when the plugin declares no MCP servers", () => {
    const plugin: ClaudePlugin = { ...fixturePlugin, mcpServers: undefined }
    const bundle = convertClaudeToWarp(plugin, baseOptions)
    expect(bundle.recommendedMcpServers.length).toBeGreaterThan(0)
    // The bundled recommended list lives in the converter; it always
    // includes agent-browser, which is the most user-visible recommendation.
    expect(bundle.recommendedMcpServers).toContain("agent-browser")
  })

  test("AGENTS.md snippet describes the canonical compound-engineering layout", () => {
    const bundle = convertClaudeToWarp(fixturePlugin, baseOptions)
    expect(bundle.project.agentsMd).toBeDefined()
    const snippet = bundle.project.agentsMd!
    // Sanity-check that the snippet links to the install repo and names the
    // canonical artifact directories. If these strings drift we want the
    // test to fail so the AGENTS.md contract stays explicit.
    expect(snippet).toContain("compound-engineering")
    expect(snippet).toContain("docs/brainstorms/")
    expect(snippet).toContain("docs/plans/")
    expect(snippet).toContain("docs/solutions/")
    expect(snippet).toContain("/ce-brainstorm")
    expect(snippet).toContain("/ce-plan")
  })

  test("collisions in sanitized agent names produce a warning, not duplicates", () => {
    const plugin: ClaudePlugin = {
      ...fixturePlugin,
      agents: [
        { name: "ce:plan", body: "First", sourcePath: "/tmp/plugin/agents/a.md" },
        { name: "ce-plan", body: "Second", sourcePath: "/tmp/plugin/agents/b.md" },
      ],
    }
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (msg: string) => warnings.push(msg)
    try {
      const bundle = convertClaudeToWarp(plugin, baseOptions)
      expect(bundle.agents).toHaveLength(1)
      expect(bundle.agents[0].name).toBe("ce-plan")
      // Both ce:plan and ce-plan sanitize to the same on-disk filename, so
      // the second one is dropped with a warning.
      expect(warnings.some((w) => w.includes("collides"))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })
})
