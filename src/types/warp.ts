/**
 * Type definitions for the Warp install target.
 *
 * Warp natively reads the Claude Code SKILL.md format (YAML frontmatter +
 * markdown body) under `.warp/skills/<name>/SKILL.md`. It does not expose a
 * named-subagent registry, so Claude agents are lowered to plain markdown
 * persona files under a shared `_ce-agents/` sibling directory; dispatching
 * skills reference them via relative paths. AGENTS.md is the canonical
 * project-context file in Warp (CLAUDE.md is rewritten on copy).
 *
 * MCP / hook configuration is intentionally absent from this bundle: Warp
 * users register MCP servers through the in-app UI rather than via files
 * checked into the repo, and Warp does not have a hooks primitive.
 */

export type WarpSkillDir = {
  name: string
  sourceDir: string
}

export type WarpAgentFile = {
  /** Sanitized agent name, used as the .md filename under `_ce-agents/`. */
  name: string
  /** Full markdown body (no frontmatter) to be written verbatim. */
  content: string
}

export type WarpProjectFiles = {
  /**
   * Optional AGENTS.md body to merge into the workspace root. When the user
   * already has an AGENTS.md, the writer appends a fenced section under a
   * known header so the merge is idempotent and human-reversible.
   */
  agentsMd?: string
}

export type WarpBundle = {
  pluginName?: string
  /** Pass-through skill directories. The writer copies each one and applies content rewrites to SKILL.md and reference .md files. */
  skillDirs: WarpSkillDir[]
  /** Lowered agent personas, written under `<root>/.warp/skills/_ce-agents/<name>.md`. */
  agents: WarpAgentFile[]
  /** Project-level files (AGENTS.md, etc.). */
  project: WarpProjectFiles
  /**
   * Names of MCP servers the plugin recommends. Surfaced as a postinstall
   * hint pointing the user at Warp's MCP UI; not written to disk.
   */
  recommendedMcpServers: string[]
}
