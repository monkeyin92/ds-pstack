---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
disable-model-invocation: true
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, find this conversation's session record. Sessions live under `~/.dsh/sessions/--<slug>--/<session-id>/`, where `<slug>` is the workspace path with the leading slash dropped and each "/" turned into "-" (so `/Users/you/proj` becomes `--Users-you-proj--`). Stay inside this workspace's slot. Do not list `~/.dsh/sessions/*/`. That crosses workspace boundaries and reads private chats from unrelated projects.

```bash
ls -t ~/.dsh/sessions/--<slug>--/*/session.v*.jsonl.zstd 2>/dev/null | head -10
```

Each file is a zstd stream of JSON lines, one line per session event, so decompress before reading, as in `zstd -dc <file> | head -5`. The first line is the session header and carries `id` and `cwd`. Take the file whose `cwd` is this workspace and whose first `user/message` event contains the conversation's opening user prompt. Recent sessions write `session.v4.jsonl.zstd`; older ones may hold a lower version, so match any `session.v*.jsonl.zstd`. If none matches, pass a tight digest of the session instead.

## 2. Spawn three reviewers in parallel

One message, three `subagent` calls, spawned together so they run concurrently. Reviewers need MCP access to look up the tickets, chat threads, and observability traces the transcript references, so keep their full tool surface and say "do not edit files" in each brief instead of stripping tools. Check `git status` afterward.

Each reviewer and the synthesizer fill a pstack role. The ds-pstack router chooses that child's route from the models checked in Settings, Subagent model selection. Never pass `provider`, `model`, or `reasoning_effort` on a spawn: doing so opts that child out of routing. Pick the reasoning level by choosing the role and letting the router apply the budget.

A fresh `subagent` does not see this conversation, so each brief stands alone. Give it the `<pstack>` base directory this skill reported, the transcript path or digest, and the template path it must read.

| Lens | Role | Prompt template |
|---|---|---|
| Judgment | `reflect judgment` | `<pstack>/reflect/references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `<pstack>/reflect/references/tooling-reviewer.md` |
| Divergent | `reflect judgment` | `<pstack>/reflect/references/divergent-reviewer.md` |

Three lenses, three seats, one reviewer each. The judgment and divergent lenses read the same judgment role because that is the work they do, not because they share a model: the router routes each child separately, so their routes can still differ.

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final message.

## 3. Synthesize

One `subagent` call on the `reflect judgment` role, with its full tool surface so it can spot-verify citations through MCP, and "do not edit files" in the brief. Never pass `provider`, `model`, or `reasoning_effort`. Give it the `<pstack>` base directory and pass `<pstack>/reflect/references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): author it here, following `<pstack>/poteto-mode/playbooks/authoring-a-skill.md`. That playbook owns the structural rules, the frontmatter validation, and the test-then-iterate loop this step used to delegate to a separate authoring skill.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): rewrite the `description` field yourself against the same playbook's frontmatter rule, front-loading the trigger words and keeping `name` and `description` exactly as the harness parses them.
- `new skill via authoring playbook: <kebab-name>`: create it yourself under `<pstack>/<kebab-name>/SKILL.md`, following `authoring-a-skill.md`. Do not invent the shape ad hoc.

Skipped in DeepSeek Harness: Cursor's built-in `create-skill`. It ships no authoring skill here, so the parent does that work directly against the authoring playbook.

Check every touched skill before declaring done: frontmatter has `name` and `description`, `disable-model-invocation: true` is still on a slash command, every referenced file exists, and no Cursor-only field such as `icon`, `color`, or `paths` remains.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
