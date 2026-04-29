import { describe, expect, test } from "bun:test"
import {
  WARP_AGENTS_MD_BEGIN,
  WARP_AGENTS_MD_END,
  WARP_AGENTS_RELATIVE_DIR,
  transformContentForWarp,
  warpAgentLink,
} from "../src/utils/warp-rewrites"

describe("transformContentForWarp", () => {
  test("rewrites CLAUDE.md prose mentions to AGENTS.md", () => {
    const result = transformContentForWarp(
      "Project conventions live in CLAUDE.md. Read CLAUDE.md before editing.",
    )
    expect(result).toContain("AGENTS.md")
    expect(result).not.toContain("CLAUDE.md")
  })

  test("preserves CLAUDE.md inside fenced code blocks", () => {
    const input = [
      "Outside the fence: CLAUDE.md",
      "```",
      "# Inside fenced block",
      "// Reference to CLAUDE.md preserved verbatim",
      "```",
      "After the fence: CLAUDE.md again",
    ].join("\n")

    const result = transformContentForWarp(input)
    // Outside-the-fence references rewritten.
    expect(result).toContain("Outside the fence: AGENTS.md")
    expect(result).toContain("After the fence: AGENTS.md again")
    // Inside-the-fence reference preserved.
    expect(result).toContain("// Reference to CLAUDE.md preserved verbatim")
  })

  test("rewrites .claude/ paths but leaves .claude-plugin/ untouched", () => {
    const result = transformContentForWarp(
      "Skills live under ~/.claude/skills/ and .claude/skills/. Manifest stays at .claude-plugin/plugin.json.",
    )
    expect(result).toContain("~/.warp/skills/")
    expect(result).toContain(".warp/skills/")
    expect(result).toContain(".claude-plugin/plugin.json")
    expect(result).not.toContain("~/.claude/skills/")
    expect(result).not.toContain(" .claude/skills/")
  })

  test("collapses the multi-platform Interaction Method preamble", () => {
    const input = [
      "## Interaction Method",
      "",
      "When asking the user a question, use the platform's blocking question tool: `AskUserQuestion` in Claude Code (call `ToolSearch` with `select:AskUserQuestion` first if its schema isn't loaded), `request_user_input` in Codex, `ask_user` in Gemini, `ask_user` in Pi (requires the `pi-ask-user` extension). Fall back to numbered options in chat only when no blocking tool exists in the harness or the call errors (e.g., Codex edit modes) — not because a schema load is required. Never silently skip the question.",
      "",
      "Ask one question at a time. Prefer a concise single-select choice when natural options exist.",
    ].join("\n")
    const result = transformContentForWarp(input)
    // The platform-specific tool names must be gone.
    expect(result).not.toContain("AskUserQuestion")
    expect(result).not.toContain("request_user_input")
    expect(result).not.toContain("ask_user")
    expect(result).not.toContain("ToolSearch")
    // The Warp-friendly replacement is in.
    expect(result).toContain("ask one focused question at a time")
    expect(result).toContain("Warp surfaces blocking prompts natively")
  })

  test("rewrites fully-qualified compound-engineering agent references to persona links", () => {
    const result = transformContentForWarp(
      "| `compound-engineering:review:security-sentinel` | Security review |",
    )
    expect(result).toContain(warpAgentLink("security-sentinel"))
    expect(result).not.toContain("compound-engineering:review:security-sentinel")
    // Sanity check: the link points at the colocated persona file.
    expect(result).toContain(`${WARP_AGENTS_RELATIVE_DIR}/security-sentinel.md`)
  })

  test("collapses Task <agent>(args) dispatch lines into adopt-the-persona directives", () => {
    const input = [
      "- Task security-sentinel(scan auth middleware)",
      "- Task compound-engineering:research:repo-research-analyst(feature_description)",
      "- Task code-simplicity-reviewer()",
    ].join("\n")

    const result = transformContentForWarp(input)
    expect(result).toContain(`Adopt the persona in ${warpAgentLink("security-sentinel")} and: scan auth middleware`)
    expect(result).toContain(`Adopt the persona in ${warpAgentLink("repo-research-analyst")} and: feature_description`)
    expect(result).toContain(`Adopt the persona in ${warpAgentLink("code-simplicity-reviewer")}`)
    expect(result).not.toContain("Task security-sentinel(")
    expect(result).not.toContain("Task compound-engineering:")
    expect(result).not.toContain("Task code-simplicity-reviewer(")
  })

  test("rewrites bare @<agent>-suffix references but leaves arbitrary @mentions alone", () => {
    const input = [
      "Spawn @security-sentinel and @performance-oracle.",
      "Mention @user-name in passing.",
    ].join("\n")

    const result = transformContentForWarp(input)
    expect(result).toContain(warpAgentLink("security-sentinel"))
    expect(result).toContain(warpAgentLink("performance-oracle"))
    // Non-agent @-mentions are left untouched.
    expect(result).toContain("@user-name")
  })

  test("AGENTS.md merge marker constants are stable strings", () => {
    // These strings get embedded in user AGENTS.md files; if they change in a
    // patch release, existing installs won't be able to find their managed
    // block. Lock them to the exact bytes the writer relies on.
    expect(WARP_AGENTS_MD_BEGIN).toBe("<!-- compound-engineering:begin -->")
    expect(WARP_AGENTS_MD_END).toBe("<!-- compound-engineering:end -->")
  })
})
