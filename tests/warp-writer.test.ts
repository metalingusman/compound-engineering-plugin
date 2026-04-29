import { describe, expect, test } from "bun:test"
import { promises as fs } from "fs"
import path from "path"
import os from "os"
import { writeWarpBundle } from "../src/targets/warp"
import {
  WARP_AGENTS_MD_BEGIN,
  WARP_AGENTS_MD_END,
} from "../src/utils/warp-rewrites"
import type { WarpBundle } from "../src/types/warp"

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function makeSourceSkill(parent: string, name: string, body: string): Promise<string> {
  const dir = path.join(parent, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "SKILL.md"), body)
  return dir
}

describe("writeWarpBundle", () => {
  test("writes skills, agents, and AGENTS.md at the workspace root", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "warp-write-"))
    const sourceParent = await fs.mkdtemp(path.join(os.tmpdir(), "warp-source-"))
    const skillDir = await makeSourceSkill(
      sourceParent,
      "ce-plan",
      `---
name: ce-plan
description: Planning skill
---

Read CLAUDE.md before editing. Use \`compound-engineering:review:security-sentinel\` for security review.
`,
    )

    const bundle: WarpBundle = {
      pluginName: "compound-engineering",
      skillDirs: [{ name: "ce-plan", sourceDir: skillDir }],
      agents: [
        { name: "security-sentinel", content: "# Persona: security-sentinel\n\nReview for vulnerabilities.\n" },
      ],
      project: { agentsMd: "## Compound Engineering\n\nCustom snippet for tests." },
      recommendedMcpServers: ["agent-browser"],
    }

    await writeWarpBundle(tempRoot, bundle)

    // Filesystem layout.
    expect(await exists(path.join(tempRoot, ".warp", "skills", "ce-plan", "SKILL.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".warp", "skills", "_ce-agents", "security-sentinel.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".warp", "compound-engineering", "install-manifest.json"))).toBe(true)
    expect(await exists(path.join(tempRoot, "AGENTS.md"))).toBe(true)

    // SKILL.md content was rewritten on copy.
    const installedSkill = await fs.readFile(
      path.join(tempRoot, ".warp", "skills", "ce-plan", "SKILL.md"),
      "utf8",
    )
    expect(installedSkill).toContain("Read AGENTS.md before editing")
    expect(installedSkill).toContain("../_ce-agents/security-sentinel.md")
    expect(installedSkill).not.toContain("compound-engineering:review:security-sentinel")
    expect(installedSkill).not.toContain("CLAUDE.md")

    // Agent persona file is written verbatim.
    const persona = await fs.readFile(
      path.join(tempRoot, ".warp", "skills", "_ce-agents", "security-sentinel.md"),
      "utf8",
    )
    expect(persona).toContain("Review for vulnerabilities.")

    // AGENTS.md is fenced with the managed-block markers.
    const agentsMd = await fs.readFile(path.join(tempRoot, "AGENTS.md"), "utf8")
    expect(agentsMd).toContain(WARP_AGENTS_MD_BEGIN)
    expect(agentsMd).toContain(WARP_AGENTS_MD_END)
    expect(agentsMd).toContain("Custom snippet for tests.")
  })

  test("merges into an existing AGENTS.md without an existing managed block", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "warp-merge-"))
    const existing = "# My project\n\nUser-authored notes.\n"
    await fs.writeFile(path.join(tempRoot, "AGENTS.md"), existing)

    const bundle: WarpBundle = {
      pluginName: "compound-engineering",
      skillDirs: [],
      agents: [],
      project: { agentsMd: "## Compound Engineering\n\nManaged content." },
      recommendedMcpServers: [],
    }

    await writeWarpBundle(tempRoot, bundle)

    const merged = await fs.readFile(path.join(tempRoot, "AGENTS.md"), "utf8")
    expect(merged).toContain("User-authored notes.")
    expect(merged).toContain(WARP_AGENTS_MD_BEGIN)
    expect(merged).toContain("Managed content.")
    // The user's content stays before the managed block.
    expect(merged.indexOf("User-authored notes.")).toBeLessThan(merged.indexOf(WARP_AGENTS_MD_BEGIN))

    // Backup of the original was made.
    const entries = await fs.readdir(tempRoot)
    expect(entries.some((e) => e.startsWith("AGENTS.md.bak."))).toBe(true)
  })

  test("replaces an existing managed block in AGENTS.md surgically", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "warp-replace-"))
    const existing = [
      "# My project",
      "",
      "Before block.",
      "",
      WARP_AGENTS_MD_BEGIN,
      "## Compound Engineering",
      "",
      "Old managed snippet.",
      WARP_AGENTS_MD_END,
      "",
      "After block.",
      "",
    ].join("\n")
    await fs.writeFile(path.join(tempRoot, "AGENTS.md"), existing)

    const bundle: WarpBundle = {
      pluginName: "compound-engineering",
      skillDirs: [],
      agents: [],
      project: { agentsMd: "## Compound Engineering\n\nNew managed snippet." },
      recommendedMcpServers: [],
    }

    await writeWarpBundle(tempRoot, bundle)

    const merged = await fs.readFile(path.join(tempRoot, "AGENTS.md"), "utf8")
    expect(merged).toContain("Before block.")
    expect(merged).toContain("After block.")
    expect(merged).toContain("New managed snippet.")
    expect(merged).not.toContain("Old managed snippet.")
  })

  test("global install (~/.warp) skips AGENTS.md merge", async () => {
    // Simulate a global install by passing an outputRoot whose parent is the
    // current process's HOME. The writer infers global vs workspace from the
    // env-derived HOME.
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "warp-home-"))
    const originalHome = process.env.HOME
    process.env.HOME = tempHome
    try {
      const warpRoot = path.join(tempHome, ".warp")
      const bundle: WarpBundle = {
        pluginName: "compound-engineering",
        skillDirs: [],
        agents: [],
        project: { agentsMd: "## Compound Engineering\n\nShould not appear in $HOME/AGENTS.md." },
        recommendedMcpServers: [],
      }

      await writeWarpBundle(warpRoot, bundle)

      // Files land under ~/.warp/skills/ regardless.
      expect(await exists(path.join(warpRoot, "skills"))).toBe(true)
      // ~/AGENTS.md is NOT touched.
      expect(await exists(path.join(tempHome, "AGENTS.md"))).toBe(false)
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
    }
  })

  test("reinstall removes skills and agents that disappeared from the bundle", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "warp-upgrade-"))
    const sourceParent = await fs.mkdtemp(path.join(os.tmpdir(), "warp-upgrade-source-"))
    const skillA = await makeSourceSkill(sourceParent, "ce-plan", `---\nname: ce-plan\n---\nA`)
    const skillB = await makeSourceSkill(sourceParent, "ce-old", `---\nname: ce-old\n---\nB`)

    // First install: both skills present, two agents.
    await writeWarpBundle(tempRoot, {
      pluginName: "compound-engineering",
      skillDirs: [
        { name: "ce-plan", sourceDir: skillA },
        { name: "ce-old", sourceDir: skillB },
      ],
      agents: [
        { name: "security-sentinel", content: "# Persona: security-sentinel\n" },
        { name: "old-reviewer", content: "# Persona: old-reviewer\n" },
      ],
      project: { agentsMd: "## Compound Engineering" },
      recommendedMcpServers: [],
    })

    expect(await exists(path.join(tempRoot, ".warp", "skills", "ce-old", "SKILL.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".warp", "skills", "_ce-agents", "old-reviewer.md"))).toBe(true)

    // Second install: ce-old and old-reviewer removed.
    await writeWarpBundle(tempRoot, {
      pluginName: "compound-engineering",
      skillDirs: [{ name: "ce-plan", sourceDir: skillA }],
      agents: [{ name: "security-sentinel", content: "# Persona: security-sentinel\n" }],
      project: { agentsMd: "## Compound Engineering" },
      recommendedMcpServers: [],
    })

    expect(await exists(path.join(tempRoot, ".warp", "skills", "ce-plan", "SKILL.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".warp", "skills", "ce-old"))).toBe(false)
    expect(await exists(path.join(tempRoot, ".warp", "skills", "_ce-agents", "security-sentinel.md"))).toBe(true)
    expect(await exists(path.join(tempRoot, ".warp", "skills", "_ce-agents", "old-reviewer.md"))).toBe(false)
  })

  test("does not double-nest when output root is already .warp", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "warp-nest-"))
    const warpRoot = path.join(tempRoot, ".warp")
    const sourceParent = await fs.mkdtemp(path.join(os.tmpdir(), "warp-nest-source-"))
    const skill = await makeSourceSkill(sourceParent, "ce-plan", `---\nname: ce-plan\n---\nbody`)

    await writeWarpBundle(warpRoot, {
      pluginName: "compound-engineering",
      skillDirs: [{ name: "ce-plan", sourceDir: skill }],
      agents: [],
      project: { agentsMd: "## Compound Engineering" },
      recommendedMcpServers: [],
    })

    expect(await exists(path.join(warpRoot, "skills", "ce-plan", "SKILL.md"))).toBe(true)
    expect(await exists(path.join(warpRoot, ".warp"))).toBe(false)
  })
})
