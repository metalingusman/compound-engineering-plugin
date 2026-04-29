# Warp install target

This is the design and reference doc for the `--to warp` install target in
this fork. The target is **experimental** and lives only in
[`metalingusman/compound-engineering-plugin`](https://github.com/metalingusman/compound-engineering-plugin),
not in the upstream `EveryInc` repository.

For the user-facing install commands, see the
[Warp section of the root README](../README.md#warp-experimental-fork-only).

## Why a separate target

Warp natively reads the same `SKILL.md` format Claude Code uses, so skills
copy across with only minor text rewrites. What it does **not** have is a
named-subagent registry: Claude's `Task(subagent_type=...)` dispatch
primitive has no Warp counterpart. Three knock-on choices follow from that:

- **Reviewer personas are written as plain markdown files** under
  `.warp/skills/_ce-agents/<name>.md` (no `SKILL.md`, no slash command).
  Skills reference them via relative paths and instruct the model to adopt
  the persona for the subtask. Warp's skill discovery requires `SKILL.md`
  in each skill directory, so plain-`.md` persona files are intentionally
  invisible to slash-command resolution.
- **Project context lives in `AGENTS.md`** (Warp's canonical project rules
  file), not `CLAUDE.md`. The text rewrite pipeline rewrites `CLAUDE.md` to
  `AGENTS.md` outside fenced code blocks. Inside fenced blocks the original
  string is preserved because it usually appears as a literal example of
  output the agent is asked to emit.
- **MCP servers are not written to disk.** Warp registers MCP servers
  through its in-app UI, not via a JSON config file in the repo. The
  postinstall hint lists the recommended servers and points the user at
  Warp's MCP UI; the install does not touch any MCP config.

## Filesystem layout

Workspace install (`--scope workspace`, the default):

```
<repo>/
  .warp/
    skills/
      ce-brainstorm/SKILL.md
      ce-plan/SKILL.md
      ce-code-review/SKILL.md
      ... (one directory per skill)
      _ce-agents/
        ce-security-sentinel.md
        ce-architecture-strategist.md
        ... (one file per persona)
    compound-engineering/
      install-manifest.json
  AGENTS.md   (managed block fenced by markers - see below)
```

Global install (`--scope global`):

```
~/.warp/
  skills/
    ce-brainstorm/SKILL.md
    ...
    _ce-agents/
      ...
  compound-engineering/
    install-manifest.json
```

The global install deliberately does **not** touch `~/AGENTS.md`. The
AGENTS.md merge is a workspace concern; Warp does not have a global rules
file at `~/AGENTS.md`.

## AGENTS.md merge semantics

The writer merges the Compound Engineering snippet into the workspace
`AGENTS.md` using a fenced managed block:

```
<!-- compound-engineering:begin -->
## Compound Engineering
...managed content...
<!-- compound-engineering:end -->
```

Three cases:

1. **No `AGENTS.md` exists** -- the writer creates one containing only the
   managed block.
2. **`AGENTS.md` exists with no managed block** -- the writer backs up the
   original to `AGENTS.md.bak.<timestamp>` and appends the managed block at
   the end. User content stays untouched.
3. **`AGENTS.md` exists with a managed block** -- the writer surgically
   replaces the block in place, preserving everything outside the markers.
   A backup is taken only if the new content differs from the existing
   block.

The marker strings are exported from `src/utils/warp-rewrites.ts` as
`WARP_AGENTS_MD_BEGIN` and `WARP_AGENTS_MD_END` and are locked by tests.
Bumping them in a patch release would orphan existing installs, so they are
treated as a stable contract.

## Skill body rewrites

Every `SKILL.md` and reference `.md` file inside a skill directory is run
through `transformContentForWarp` (`src/utils/warp-rewrites.ts`) at write
time. The rewrite pipeline is:

1. **Drop the multi-platform Interaction Method preamble** that names
   `AskUserQuestion` (Claude), `request_user_input` (Codex), `ask_user`
   (Gemini/Pi), etc. Replace it with a single Warp-friendly line: Warp
   surfaces blocking prompts natively, so no tool-specific schema needs to
   be loaded.
2. **`CLAUDE.md` -> `AGENTS.md`** outside fenced code blocks. Inside fenced
   blocks the original is preserved because it is usually a literal
   example of output the agent is meant to emit.
3. **`.claude/` -> `.warp/`** (and `~/.claude/` -> `~/.warp/`). The
   `.claude-plugin/` manifest segment is exempt from the rewrite -- it is
   part of the Claude plugin spec, not a user-facing path.
4. **`Task <agent>(<args>)` dispatch lines** are collapsed to
   `Adopt the persona in [<agent>](../_ce-agents/<agent>.md) and: <args>`.
   The Task regex handles both bare names (`Task security-sentinel(...)`)
   and namespaced names
   (`Task compound-engineering:research:repo-research-analyst(...)`), and
   runs **before** the namespaced-reference rewrite below so it doesn't
   trip over already-rewritten links.
5. **`compound-engineering:<category>:<agent>`** in prose, table cells, and
   anywhere else -> a markdown link to `../_ce-agents/<agent>.md`. The
   two-segment `compound-engineering:<skill>` form is intentionally
   preserved -- it refers to skill namespaces (a discussion topic), not
   agent dispatch.
6. **Bare `@<agent-suffix>` references** (e.g. `@security-sentinel`,
   `@performance-oracle`) -> markdown links to the persona file. The
   suffix list mirrors the Gemini converter so we don't false-match on
   `@username`-style mentions in prose.

## Agent lowering (v0.1)

Each Claude agent under `plugins/compound-engineering/agents/<category>/<name>.md`
becomes a frontmatter-stripped markdown file at
`<.warp/skills>/_ce-agents/<sanitized-name>.md`. The first line is a
synthesized intro:

```
# Persona: <agent-name>

<one-line description from the source frontmatter>

<original persona body, transformed by transformContentForWarp>
```

The dispatching skill reads this file and instructs the model to adopt the
persona for the duration of the subtask. v0.1 runs persona dispatches
serially -- in skills like `/ce-code-review` and `/ce-doc-review` the
reviewers iterate one after another rather than running in parallel.

### Why the lossy parallelism is acceptable for v0.1

v0.1 prioritizes shipping a working baseline. Persona fidelity is preserved
exactly because the original prompt body is copied verbatim. Throughput is
the only thing that suffers, and the alternative -- lowering each dispatch
to Warp's `/orchestrate` primitive -- has design questions (does
`/orchestrate` accept arbitrary structured subtask specs? how does the
calling skill consume orchestrated outputs?) that warrant a deliberate
v0.2 rather than blocking v0.1.

## Reinstall and uninstall

The writer keeps a manifest at
`<warp-root>/<plugin-name>/install-manifest.json` listing the skills and
agents written in the most recent install. On reinstall:

- Skills present in the previous manifest but absent from the current
  bundle are removed (recursive `fs.rm`).
- Agent persona files in the same situation are removed (file `fs.rm`).
- Skills present in both lists are overwritten in place.

The manifest is namespaced under the plugin name, so a fork that installs
multiple Compound Engineering plugins into the same Warp root keeps each
manifest independent.

To back up a previous install before reinstalling, use the cleanup command:

```bash
bunx github:metalingusman/compound-engineering-plugin cleanup --target warp
```

Cleanup reads the manifest and moves every recorded artifact into
`<warp-root>/<plugin-name>/legacy-backup/<timestamp>/`. If no manifest
exists the cleanup is a safe no-op -- the cleanup deliberately does **not**
scan `.warp/skills/` for things that look CE-shaped, because that directory
is shared with user-authored skills and a name collision is not a strong
enough ownership signal.

## Comparison with other targets

The Warp target is most structurally similar to the **Gemini** target:
both are workspace-default, both pass through skill directories with a
content transform, both write a managed install manifest under a
plugin-named subdirectory, and both rely on the shared `managed-artifacts`
machinery for reinstall semantics.

The differences:

- **Gemini writes commands** as TOML files under `.gemini/commands/`. Warp
  has no separate commands surface -- every skill becomes a
  `/<skill-name>` slash command automatically.
- **Gemini writes agents** as separate `.md` files under
  `.gemini/agents/`. Warp has no native agent-as-resource concept, so
  agent personas live inside the skills tree as inert reference files.
- **Gemini writes MCP server config** to `settings.json`. Warp configures
  MCP through its in-app UI; the install only surfaces a postinstall hint.
- **Gemini's AGENTS.md story** is whatever the user already maintains.
  Warp's writer actively merges a Compound Engineering snippet into the
  workspace's `AGENTS.md`, fenced with stable markers so reinstalls are
  idempotent.

## Roadmap

- **v0.2:** Lower persona dispatches to Warp's `/orchestrate` primitive
  so multi-reviewer pipelines run in parallel. Switch the package to npm
  (`@metalingusman/compound-plugin`) and drop the `bunx github:` install
  path from documentation.
- **v0.3:** Warp-native polish -- Tab Configs for `/ce-worktree`, Warp
  Drive Prompt seeding, Oz scheduled-agent recipes for
  `/ce-compound-refresh` and `/ce-clean-gone-branches`, code-review pane
  integration so `/ce-code-review` findings land as inline review comments.
- **v0.4 (optional):** MCP-backed agent dispatch server for users who want
  true persona parallelism without `/orchestrate`. This is gated on usage
  data showing v0.2's `/orchestrate` lowering is insufficient.

## Filing issues

Warp-specific bugs and feature requests go in this fork's tracker rather
than upstream. Tag issues with `target:warp` so they're easy to filter.

If a bug reproduces on multiple targets (e.g. a skill body issue that
affects Warp, Gemini, and OpenCode equally), file it upstream against
[`EveryInc/compound-engineering-plugin`](https://github.com/EveryInc/compound-engineering-plugin)
-- those skills are owned by the upstream maintainers, and Warp picks them
up via rebases.
