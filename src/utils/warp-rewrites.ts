/**
 * Data-driven text rewrites applied to Claude plugin content (skills, agents,
 * commands, project conventions) when targeting Warp.
 *
 * The Warp target is implemented as an additive converter — the upstream
 * SKILL.md format is already compatible, so we only need to translate
 * platform-specific divergences:
 *
 *   1. Project context file: `CLAUDE.md` → `AGENTS.md`. Warp reads project
 *      rules from AGENTS.md (or WARP.md for legacy projects).
 *   2. Per-platform config dirs: `.claude/` → `.warp/`, `~/.claude/` →
 *      `~/.warp/`. Mirrors the rewrite the OpenCode/Gemini converters do.
 *   3. The multi-platform Interaction Method preamble that names
 *      `AskUserQuestion` (Claude), `request_user_input` (Codex), `ask_user`
 *      (Gemini/Pi), etc. is collapsed to a single Warp-friendly line: Warp's
 *      agent surfaces blocking prompts natively without a tool name.
 *   4. Agent dispatch references — both fully-qualified
 *      (`compound-engineering:review:security-sentinel`) and bare
 *      (`Task security-sentinel(...)`, `@security-sentinel`) — are rewritten
 *      to instruct the model to read a co-located persona file under
 *      `_ce-agents/` and adopt the persona for the subtask. v0.2 will replace
 *      these with `/orchestrate` calls; v0.1 runs the personas serially.
 *
 * Rewrites are intentionally pure functions over strings so they can be unit
 * tested without filesystem state. The same module runs at write time over
 * each copied SKILL.md and at convert time over agent/project bodies.
 */

/**
 * Sentinel relative path used by skill bodies to reference a persona file.
 * Skills live at `<root>/.warp/skills/<skill-name>/SKILL.md`; agents live at
 * `<root>/.warp/skills/_ce-agents/<agent-name>.md`. Hence `../_ce-agents/`.
 */
export const WARP_AGENTS_RELATIVE_DIR = "../_ce-agents"

/**
 * Markers used to fence the compound-engineering section inside an existing
 * AGENTS.md so reinstalls update only the managed block.
 */
export const WARP_AGENTS_MD_BEGIN = "<!-- compound-engineering:begin -->"
export const WARP_AGENTS_MD_END = "<!-- compound-engineering:end -->"

/**
 * Best-effort regex matching the multi-platform Interaction Method block
 * that appears verbatim in many compound-engineering skill bodies. We do not
 * try to parse it; we just recognize the opening sentence and replace
 * everything up to and including the trailing "Never silently skip the
 * question." line that closes the block in the upstream content.
 */
const INTERACTION_METHOD_BLOCK = /^## Interaction Method\n[\s\S]*?Never silently skip the question\.[^\n]*\n?/m

const INTERACTION_METHOD_REPLACEMENT = `## Interaction Method

When asking the user a question, ask one focused question at a time and prefer single-select choices when natural options exist. Wait for the user's reply before proceeding. Warp surfaces blocking prompts natively, so no tool-specific schema needs to be loaded.
`

/**
 * Rewrite Claude-Code-flavored content into Warp-flavored content.
 *
 * Order matters: we rewrite the namespaced agent references before the bare
 * `@agent-suffix` form so we don't double-transform `@security-sentinel`
 * after it's already been linked.
 */
export function transformContentForWarp(input: string): string {
  let out = input

  // 1. Drop the multi-platform Interaction Method preamble.
  out = out.replace(INTERACTION_METHOD_BLOCK, INTERACTION_METHOD_REPLACEMENT)

  // 2. Project-context file: CLAUDE.md -> AGENTS.md.
  //
  //    We rewrite outside fenced code blocks only. Inside code blocks the
  //    original CLAUDE.md filename may be the literal subject of an example
  //    (e.g. "create CLAUDE.md with..."). The block-level walk below reuses
  //    a simple state machine because the regex flavor we have here doesn't
  //    support look-around across multi-line code fences.
  out = rewriteOutsideFencedBlocks(out, (chunk) =>
    chunk.replace(/\bCLAUDE\.md\b/g, "AGENTS.md"),
  )

  // 3. Per-platform config dirs.
  //
  //    We deliberately do NOT rewrite the literal `.claude-plugin/` segment,
  //    which names the plugin manifest directory and is part of the Claude
  //    Code plugin spec rather than a user-facing path.
  out = out
    .replace(/~\/\.claude\//g, "~/.warp/")
    .replace(/(?<!\.claude-plugin)\.claude\/(?!plugin)/g, ".warp/")

  // 4. Bare `Task <agent>(<args>)` dispatch lines (the Claude Code Task
  //    tool's invocation grammar), used in skills like ce-review and
  //    ce-doc-review. We collapse them to a directive that tells the Warp
  //    agent to read the persona file and adopt it. This MUST run before the
  //    namespaced-reference rewrite below: if the namespaced form
  //    `compound-engineering:<category>:<agent>` were rewritten first, the
  //    Task regex would no longer recognize the line because the agent name
  //    would already be a markdown link.
  out = out.replace(
    /(^|\n)(\s*-?\s*)Task\s+([a-z][a-z0-9:-]*)\(([^)]*)\)/g,
    (_match, lead: string, prefix: string, agentName: string, args: string) => {
      const finalSegment = agentName.includes(":")
        ? agentName.split(":").pop()!
        : agentName
      const trimmed = args.trim()
      const directive = trimmed
        ? `Adopt the persona in ${warpAgentLink(finalSegment)} and: ${trimmed}`
        : `Adopt the persona in ${warpAgentLink(finalSegment)}`
      return `${lead}${prefix}${directive}`
    },
  )

  // 5. Fully-qualified agent references:
  //    `compound-engineering:<category>:<agent-name>` →
  //    a markdown link to the colocated persona file. Catches in-prose and
  //    table-cell references that didn't go through a Task dispatch.
  out = out.replace(
    /compound-engineering:[a-z][a-z0-9-]*:([a-z][a-z0-9-]*)/g,
    (_match, agentName: string) => warpAgentLink(agentName),
  )

  // 6. Bare `@agent-suffix` references (security-sentinel, performance-oracle,
  //    *-reviewer, *-researcher, etc.) that are not already inside a markdown
  //    link. Same suffix list as the Gemini converter so we catch the same
  //    set of agent names without false positives on `@username`-style
  //    mentions in prose.
  const bareAgentRef = /(?<!\]\()@([a-z][a-z0-9-]*-(?:agent|reviewer|researcher|analyst|specialist|oracle|sentinel|guardian|strategist))\b/gi
  out = out.replace(bareAgentRef, (_match, agentName: string) => {
    return warpAgentLink(agentName)
  })

  return out
}

/**
 * Render a markdown link to the persona file for `agentName`. Centralizing
 * this keeps the relative-path layout in one place; if v0.2 moves agents
 * elsewhere or replaces them with `/orchestrate` calls, only this function
 * changes.
 */
export function warpAgentLink(agentName: string): string {
  return `[${agentName}](${WARP_AGENTS_RELATIVE_DIR}/${agentName}.md)`
}

/**
 * Apply `transform` to every chunk of `input` that lives outside a fenced
 * markdown code block. Fences are detected by a leading run of backticks at
 * the start of a line (same heuristic CommonMark uses for fenced code); we
 * deliberately don't try to support arbitrary indentation because skill
 * content authored in this plugin always starts fences at column zero.
 */
function rewriteOutsideFencedBlocks(input: string, transform: (chunk: string) => string): string {
  const fenceRegex = /^(`{3,}|~{3,})/m
  let out = ""
  let remaining = input
  let inFence = false
  let fenceMarker = ""
  while (remaining.length > 0) {
    if (!inFence) {
      const match = remaining.match(fenceRegex)
      if (!match || match.index === undefined) {
        out += transform(remaining)
        break
      }
      out += transform(remaining.slice(0, match.index))
      fenceMarker = match[1]
      inFence = true
      // Include the opening fence line verbatim.
      const newlineIdx = remaining.indexOf("\n", match.index)
      const fenceLineEnd = newlineIdx === -1 ? remaining.length : newlineIdx + 1
      out += remaining.slice(match.index, fenceLineEnd)
      remaining = remaining.slice(fenceLineEnd)
      continue
    }
    // Inside a fence — find the matching closing fence at column zero.
    const closingPattern = new RegExp(`^${fenceMarker}\\s*$`, "m")
    const close = remaining.match(closingPattern)
    if (!close || close.index === undefined) {
      // Unterminated fence — emit the rest verbatim.
      out += remaining
      break
    }
    const newlineIdx = remaining.indexOf("\n", close.index)
    const closeEnd = newlineIdx === -1 ? remaining.length : newlineIdx + 1
    out += remaining.slice(0, closeEnd)
    remaining = remaining.slice(closeEnd)
    inFence = false
    fenceMarker = ""
  }
  return out
}
