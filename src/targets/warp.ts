/**
 * Filesystem writer for the Warp install target.
 *
 * Layout (workspace install):
 *   <root>/.warp/skills/<skill-name>/SKILL.md
 *   <root>/.warp/skills/<skill-name>/<reference files...>
 *   <root>/.warp/skills/_ce-agents/<agent-name>.md
 *   <root>/.warp/<plugin-name>/install-manifest.json
 *   <root>/AGENTS.md   (merged in-place with begin/end markers)
 *
 * Layout (global install):
 *   ~/.warp/skills/<skill-name>/SKILL.md
 *   ~/.warp/skills/_ce-agents/<agent-name>.md
 *   ~/.warp/<plugin-name>/install-manifest.json
 *
 * The write path mirrors the Gemini/Kiro targets:
 *   1. Resolve the .warp directory from `outputRoot` (basename detection
 *      matches `path/to/.warp` or appends `.warp` to a workspace root).
 *   2. Read the previous install manifest under `<root>/<plugin>/`. Use it
 *      to drop skill/agent directories that are no longer in the current
 *      bundle so removed components don't linger after upgrade.
 *   3. Copy each skill directory through `copySkillDir` with the Warp
 *      content transform applied to all markdown so reference files (not
 *      just SKILL.md) get the same `.claude/` -> `.warp/` and agent-link
 *      rewrites.
 *   4. Write each lowered agent persona under `_ce-agents/`.
 *   5. Merge the AGENTS.md snippet at the workspace root, fenced with the
 *      `compound-engineering:begin/end` markers so reinstalls update only
 *      the managed block.
 *   6. Print a postinstall hint with MCP-server registration guidance and
 *      the v0.1 limitations note.
 */

import path from "path"
import { backupFile, copySkillDir, ensureDir, pathExists, readText, sanitizePathName, writeText } from "../utils/files"
import {
  archiveLegacyInstallManifestIfOwned,
  cleanupCurrentManagedDirectory,
  cleanupRemovedManagedDirectories,
  cleanupRemovedManagedFiles,
  readManagedInstallManifestWithLegacyFallback,
  resolveManagedSegment,
  sanitizeManagedPluginName,
  writeManagedInstallManifest,
} from "./managed-artifacts"
import type { TargetScope } from "./index"
import type { WarpBundle } from "../types/warp"
import { transformContentForWarp, WARP_AGENTS_MD_BEGIN, WARP_AGENTS_MD_END } from "../utils/warp-rewrites"

/** Directory name used for the shared persona files referenced by skills. */
const AGENTS_DIR_NAME = "_ce-agents"

export async function writeWarpBundle(
  outputRoot: string,
  bundle: WarpBundle,
  _scope?: TargetScope,
): Promise<void> {
  const pluginName = bundle.pluginName ? sanitizeManagedPluginName(bundle.pluginName) : undefined
  const paths = resolveWarpPaths(outputRoot, pluginName)
  const manifest = pluginName
    ? await readManagedInstallManifestWithLegacyFallback(paths.managedDir, pluginName)
    : null

  const currentSkills = bundle.skillDirs.map((skill) => sanitizePathName(skill.name))
  const currentAgents = bundle.agents.map((agent) => `${sanitizePathName(agent.name)}.md`)

  await ensureDir(paths.warpDir)
  await ensureDir(paths.skillsDir)

  // Drop skills/agents recorded in the previous manifest that are no
  // longer in the current bundle. This is what makes upgrades safe: a
  // skill removed in plugin v3 won't linger from the install of plugin v2.
  await cleanupRemovedManagedDirectories(paths.skillsDir, manifest, "skills", currentSkills)
  await cleanupRemovedManagedFiles(paths.agentsDir, manifest, "agents", currentAgents)

  for (const skill of bundle.skillDirs) {
    const skillName = sanitizePathName(skill.name)
    const targetDir = path.join(paths.skillsDir, skillName)
    await cleanupCurrentManagedDirectory(targetDir, manifest, "skills", skillName)
    // Apply the Warp transform to every .md (not just SKILL.md) so
    // reference files inside a skill directory pick up agent-link and
    // path rewrites the same way the entry SKILL.md does.
    await copySkillDir(skill.sourceDir, targetDir, transformContentForWarp, true)
  }

  if (bundle.agents.length > 0) {
    await ensureDir(paths.agentsDir)
    for (const agent of bundle.agents) {
      const filename = `${sanitizePathName(agent.name)}.md`
      await writeText(path.join(paths.agentsDir, filename), agent.content)
    }
  }

  if (paths.workspaceRoot && bundle.project.agentsMd) {
    await mergeAgentsMd(paths.workspaceRoot, bundle.project.agentsMd)
  }

  if (pluginName) {
    await writeManagedInstallManifest(paths.managedDir, {
      version: 1,
      pluginName,
      groups: {
        skills: currentSkills,
        agents: currentAgents,
      },
    })
    await archiveLegacyInstallManifestIfOwned(paths.managedDir, pluginName)
  }

  printPostinstallHint(bundle, paths)
}

type WarpPaths = {
  /** The .warp/ directory itself. */
  warpDir: string
  /** Directory where managed install metadata lives. */
  managedDir: string
  /** .warp/skills directory. */
  skillsDir: string
  /** .warp/skills/_ce-agents directory. */
  agentsDir: string
  /**
   * Workspace root for AGENTS.md merge, or undefined when this is a global
   * install (~/.warp) — in that case the AGENTS.md snippet is skipped.
   */
  workspaceRoot: string | undefined
}

function resolveWarpPaths(outputRoot: string, pluginName?: string): WarpPaths {
  const managedSegment = resolveManagedSegment(pluginName)
  const base = path.basename(outputRoot)
  // When the caller already passed a path ending in `.warp`, treat it as the
  // .warp dir directly (matches the Gemini target's basename heuristic).
  if (base === ".warp") {
    return {
      warpDir: outputRoot,
      managedDir: path.join(outputRoot, managedSegment),
      skillsDir: path.join(outputRoot, "skills"),
      agentsDir: path.join(outputRoot, "skills", AGENTS_DIR_NAME),
      // Walk up one level to find the workspace root candidate. For global
      // installs (~/.warp) we don't want to touch ~/AGENTS.md, so the caller
      // signals that case via TargetScope below — but at this layer we
      // simply check whether the parent looks like the user's home dir and
      // skip the merge if so. The test for that is in mergeAgentsMd's caller.
      workspaceRoot: deriveWorkspaceRootFromWarpDir(outputRoot),
    }
  }
  // Otherwise treat `outputRoot` as a workspace root and nest under .warp/.
  const warpDir = path.join(outputRoot, ".warp")
  return {
    warpDir,
    managedDir: path.join(warpDir, managedSegment),
    skillsDir: path.join(warpDir, "skills"),
    agentsDir: path.join(warpDir, "skills", AGENTS_DIR_NAME),
    workspaceRoot: outputRoot,
  }
}

/**
 * For an outputRoot that ends in `.warp`, infer whether the parent directory
 * is a workspace (project) root or a home directory. Global installs target
 * `~/.warp`, in which case we do not write AGENTS.md (~/AGENTS.md is a
 * user-level file we would not want to clobber). Workspace installs target
 * `<repo>/.warp`, in which case the parent is the workspace root.
 */
function deriveWorkspaceRootFromWarpDir(warpDir: string): string | undefined {
  const parent = path.dirname(warpDir)
  // `os.homedir()` would be canonical, but we avoid importing `os` here so
  // the comparison stays based on the resolved warpDir we were given. The
  // caller — typically `resolveTargetOutputRoot` — passes either a resolved
  // workspace root or the user's home; if the parent of warpDir matches the
  // user's home as recorded in HOME, we treat that as a global install.
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home && path.resolve(parent) === path.resolve(home)) {
    return undefined
  }
  return parent
}

/**
 * Idempotently merge `snippet` into `<workspaceRoot>/AGENTS.md`.
 *
 * - If AGENTS.md does not exist, write it with the begin/end markers around
 *   the snippet.
 * - If AGENTS.md exists and already contains a managed block, replace the
 *   block in place (preserving everything outside the markers).
 * - If AGENTS.md exists but does not contain a managed block, append the
 *   block to the end of the file. Back the original up before any edit.
 */
async function mergeAgentsMd(workspaceRoot: string, snippet: string): Promise<void> {
  const target = path.join(workspaceRoot, "AGENTS.md")
  const block = `${WARP_AGENTS_MD_BEGIN}\n${snippet.trim()}\n${WARP_AGENTS_MD_END}\n`

  if (!(await pathExists(target))) {
    await writeText(target, block)
    return
  }

  const existing = await readText(target)
  const beginIdx = existing.indexOf(WARP_AGENTS_MD_BEGIN)
  const endIdx = existing.indexOf(WARP_AGENTS_MD_END)

  // If both markers are present and well-ordered, surgically replace the
  // managed block in place. Otherwise back up and append.
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx)
    // Skip past the closing marker line so the replacement keeps the file's
    // newline cadence intact.
    const afterStart = endIdx + WARP_AGENTS_MD_END.length
    const after = existing.slice(afterStart).replace(/^\n/, "")
    const updated = `${before}${block}${after}`
    if (updated === existing) return
    await backupFile(target)
    await writeText(target, updated)
    return
  }

  await backupFile(target)
  // Ensure exactly one blank line between the user's content and the
  // appended managed block, regardless of how the existing file ends.
  const trimmed = existing.replace(/\s+$/, "")
  const updated = `${trimmed}\n\n${block}`
  await writeText(target, updated)
}

function printPostinstallHint(bundle: WarpBundle, paths: WarpPaths): void {
  console.log(`Installed ${bundle.skillDirs.length} skill(s) and ${bundle.agents.length} persona(s) to ${paths.skillsDir}`)
  if (paths.workspaceRoot) {
    console.log(`Updated AGENTS.md at ${path.join(paths.workspaceRoot, "AGENTS.md")} (managed block fenced by compound-engineering markers).`)
  }
  console.log(`Slash commands are available in Warp via /<skill-name> (e.g. /ce-brainstorm, /ce-plan, /ce-compound).`)
  if (bundle.recommendedMcpServers.length > 0) {
    console.log(
      `Recommended MCP servers (configure via Warp's MCP UI): ${bundle.recommendedMcpServers.join(", ")}.`,
    )
  }
  console.log(
    "v0.1 note: review pipelines (/ce-code-review, /ce-doc-review) run reviewer personas serially. v0.2 will lower them to /orchestrate for parallel execution.",
  )
}
