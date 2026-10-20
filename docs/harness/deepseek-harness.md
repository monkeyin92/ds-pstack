# pstack on DeepSeek Harness

ds-pstack ports [pstack](https://github.com/cursor/plugins/tree/main/pstack) to DeepSeek Harness. The skills keep pstack's playbooks, principles, and prose rules. This file is the contract for every name that had to change.

Read it before editing any text in `skills/`. A skill that uses a Cursor-only name is a bug in this port.

## Skills are slash commands

Every pstack skill ships with `disable-model-invocation: true`, so it stays out of the model's `<available_skills>` catalog and appears in the `/` menu instead. The user types `/poteto-mode`, `/how`, `/interrogate` and the harness injects the skill body into that turn. That is pstack's own model, unchanged.

The loaded body starts with a `<skill_resources>` block naming this package's `skills/` directory. Treat that absolute path as `<pstack>` and resolve every relative reference against it:

- `<pstack>/<name>/SKILL.md` is a sibling skill's body.
- `<pstack>/poteto-mode/playbooks/<name>.md` is a playbook.

A subagent reads those files with the `read` tool. There is no named subagent type and no plugin prefix, so a delegate brief names the exact path it must read.

## Tools

| pstack (Cursor) | DeepSeek Harness |
| --- | --- |
| `Task` | `subagent` for a fresh child, `subagent_fork` for one seeded with this conversation |
| `subagent_type: poteto-agent` | No named agent types. Prepend the delegate brief in `<pstack>/../agents/poteto-agent.md` to the `subagent` prompt instead. |
| `subagent_type: generalPurpose` | `subagent` |
| `readonly: true` | Keep `subagent` and say "do not edit files" in the brief; confirm with `git status` after it returns. A child shares the parent's sandbox and approval policy. |
| `run_in_background: true` | Nothing to pass. `subagent` publishes the child, returns its id immediately, and reports completion later. Start independent delegations in one assistant message. |
| `resume` / follow-up on a live child | `send_message` to the child id. pstack still prefers a fresh child with consolidated scope. |
| `interrupt` | `interrupt_agent` for a teammate, `send_message` steering for a child |
| `AskQuestion` | `ask_user_question` |
| Open a todolist | `todo_write` |
| `Read`, `Write`, `Edit` | `read`, `write`, `edit` |
| `Grep`, `Glob` | `grep`, `glob` |
| `Bash` | `bash` |
| Slash-command skill (`/name`) | Unchanged for the user. A skill telling an agent to run another skill says "read `<pstack>/<name>/SKILL.md` and follow it". |
| `~/.cursor/rules/pstack-models.mdc` | `~/.dsh/ds-pstack-roles.json`, written by `/setup-pstack` |
| Transcripts in `~/.cursor/projects/<slug>/agent-transcripts/` | Sessions in `~/.dsh/sessions/` |
| `/loop until X` | `create_goal` with the predicate as its objective |
| Cursor cloud agents, `environment: "cloud"`, `cloud_base_branch` | `git worktree add` from `bash`. Children share the filesystem, so the separate-before-serializing-shared-state principle still decides whether to isolate at all. |
| Bugbot, Cursor Automations, `.cursor/plugins/` | Absent. A step that needs one gets a single line in the reply, `Skipped in DeepSeek Harness: <step>. <reason>.`, and the run continues. |

## Models

pstack on Cursor names model slugs. ds-pstack does not name models anywhere, because the routing plugin owns that choice:

1. The candidate pool is the model list checked under Settings, Subagent model selection (`subagent-model-selection-settings.allowedModels`). Checking a model there adds it to the pool; unchecking removes it.
2. The router classifies each delegated child's task and picks one route out of that pool, then sets the child's reasoning effort. one decision per child, reused for all of its requests.
3. Delegating agents therefore never pass `provider`, `model`, or `reasoning_effort`. Passing them opts that child out of routing, because an explicit request wins over an automatic one.

A skill says which *role* the work needs, not which model. The roles are the pstack role lines:

`feature`, `refactoring`, `bug-fix`, `perf-issue`, `hillclimb`, `judgment and prose`, `hardest tasks`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment`, `arena runners`, `arena cross-judge pool`, `swarm workers`, `architect runners`, `interrogate reviewers`.

`/setup-pstack` maps roles onto intents and may pin a role to one exact route. Do not reintroduce model slugs into a skill body; they are not portable across profiles.

## What did not port

- Cursor Automations and the `automations/benny` tree. It needs Cursor's automation runtime.
- Bugbot triage as an automated feed. The triage judgment survives in `references/bugbot-triage.md`; the trigger does not.
- `-fast` speed selection, which pstack uses by slug suffix. Reasoning effort still applies; speed does not.
- The `harness/pstack/` generated copy and its CI check.
