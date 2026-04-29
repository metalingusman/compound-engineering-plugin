/**
 * Convert a parsed Claude plugin into a Warp install bundle.
 *
 * The Warp converter is intentionally light. Most of the work is in the
 * writer (`src/targets/warp.ts`), which copies skill directories
 * verbatim and applies the shared `transformContentForWarp` rewrites at
 * write time. The converter's job is to:
 *
 *   - Filter skills by `ce_platforms` so authors can opt skills out of Warp
 *     (mirrors the Gemini target).
 *   - Lower each Claude agent into a frontmatter-stripped persona markdown
 *     file under `_ce-agents/<name>.md`. Frontmatter (model, tools,
 *     description) is replaced with a one-line intro because Warp does not
 *     have a named-subagent registry — these files are read by the
 *     dispatching skill at runtime, not loaded by Warp itself.
 *   - Stage a static `AGENTS.md` snippet describing where compound-
 *     engineering artifacts land (docs/brainstorms, docs/plans,
 *     docs/solutions, todos/). The writer merges this into the workspace
 *     AGENTS.md inside fenced markers so reinstalls are idempotent and
 *     human-reversible.
 *   - Surface the names of recommended MCP servers so the writer can print
 *     a postinstall hint pointing the user at Warp's MCP UI.
 */

import { type ClaudeAgent, type ClaudePlugin, filterSkillsByPlatform } from "../types/claude"
import { sanitizePathName } from "../utils/files"
import { transformContentForWarp } from "../utils/warp-rewrites"
import type { ClaudeToOpenCodeOptions } from "./claude-to-opencode"
import type { WarpAgentFile, WarpBundle } from "../types/warp"

export type ClaudeToWarpOptions = ClaudeToOpenCodeOptions

const WARP_PLATFORM_KEY = "warp"

/**
 * Static AGENTS.md snippet appended to the workspace AGENTS.md by the
 * writer. Keep this a stable string so the begin/end markers around it can
 * be used to surgically replace the section on reinstall. It deliberately
 * does not duplicate the upstream `plugins/compound-engineering/CLAUDE.md`
 * — that file is part of the bundled plugin, not a Warp-specific
 * convention surface.
 */
const WARP_AGENTS_SNIPPET = `## Compound Engineering

This project uses the [compound-engineering](https://github.com/EveryInc/compound-engineering-plugin) plugin via the Warp target.

The core loop:

- \`/ce-brainstorm\` — Interactive Q&A to define what to build.
- \`/ce-plan\` — Turn brainstorms or rough ideas into structured plans.
- \`/ce-work\` — Execute plans with worktrees and task tracking.
- \`/ce-code-review\` — Multi-persona review before merging (v0.1: serial; v0.2: parallel via \`/orchestrate\`).
- \`/ce-compound\` — Codify learnings so the next cycle starts smarter.

Generated artifacts live under:

- \`docs/brainstorms/\` — requirements documents from \`/ce-brainstorm\`.
- \`docs/plans/\` — implementation plans from \`/ce-plan\`.
- \`docs/solutions/\` — institutional learnings from \`/ce-compound\`, organized by category with YAML frontmatter.
- \`todos/\` — review findings and prioritized work items.

Personas dispatched by review/work skills live at \`.warp/skills/_ce-agents/<name>.md\` and are referenced by the dispatching skill via relative paths. Do not invoke them as slash commands directly.
`

/**
 * Recommended MCP servers the upstream plugin uses. Surfaced as a
 * postinstall hint rather than written to disk because Warp configures MCP
 * in the in-app UI rather than via files in the repo.
 */
const RECOMMENDED_MCP_SERVERS = [
  "agent-browser",
  "XcodeBuildMCP",
]

export function convertClaudeToWarp(
  plugin: ClaudePlugin,
  _options: ClaudeToWarpOptions,
): WarpBundle {
  // Authors can opt skills out of Warp by setting ce_platforms in
  // frontmatter. Skills without that key are available everywhere.
  const platformSkills = filterSkillsByPlatform(plugin.skills, WARP_PLATFORM_KEY)

  const skillDirs = platformSkills.map((skill) => ({
    name: skill.name,
    sourceDir: skill.sourceDir,
  }))

  const agents = lowerAgents(plugin.agents)

  if (plugin.hooks && Object.keys(plugin.hooks.hooks).length > 0) {
    console.warn(
      "Warning: Warp does not have a hooks primitive. Hook definitions were skipped during conversion.",
    )
  }

  return {
    pluginName: plugin.manifest.name,
    skillDirs,
    agents,
    project: {
      agentsMd: WARP_AGENTS_SNIPPET,
    },
    recommendedMcpServers: pickRecommendedMcpServers(plugin),
  }
}

/**
 * Convert a Claude agent definition (frontmatter + persona body) into a
 * frontmatter-free persona markdown file. The first non-empty line of the
 * body is preceded by a synthesized intro that names the persona and
 * (when available) summarizes its description, so the dispatching skill's
 * agent has enough context after reading the file.
 */
function lowerAgents(agents: ClaudeAgent[]): WarpAgentFile[] {
  const seen = new Set<string>()
  const lowered: WarpAgentFile[] = []
  for (const agent of agents) {
    const safeName = sanitizePathName(agent.name)
    if (seen.has(safeName)) {
      console.warn(
        `Skipping agent "${agent.name}": sanitized name "${safeName}" collides with another agent.`,
      )
      continue
    }
    seen.add(safeName)
    const intro = renderAgentIntro(agent)
    const body = transformContentForWarp(agent.body.trim())
    const content = body.length > 0 ? `${intro}\n\n${body}\n` : `${intro}\n`
    lowered.push({ name: safeName, content })
  }
  return lowered
}

function renderAgentIntro(agent: ClaudeAgent): string {
  const description = agent.description?.trim()
  const heading = `# Persona: ${agent.name}`
  if (!description) return heading
  return `${heading}\n\n${description}`
}

/**
 * Cross-reference the plugin's declared MCP servers against our recommended
 * list so we only nag the user about ones the plugin actually requests.
 * Falls back to the static recommended list if the plugin manifest does not
 * declare any MCP servers (older bundled plugins, custom forks).
 */
function pickRecommendedMcpServers(plugin: ClaudePlugin): string[] {
  const declared = Object.keys(plugin.mcpServers ?? {})
  if (declared.length === 0) return RECOMMENDED_MCP_SERVERS.slice()
  const recommendedSet = new Set(RECOMMENDED_MCP_SERVERS)
  const ordered: string[] = []
  for (const name of declared) {
    if (recommendedSet.has(name)) ordered.push(name)
  }
  // Always include declared servers, even ones we haven't curated, so users
  // see the full picture. De-dupe while preserving insertion order.
  for (const name of declared) {
    if (!ordered.includes(name)) ordered.push(name)
  }
  return ordered
}
