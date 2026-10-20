# ds-pstack

[pstack](https://github.com/cursor/plugins/tree/main/pstack) for DeepSeek Harness. pstack is Lauren Tan's set of agent workflows: write less code, but higher quality code, and parallelize with confidence.

This port keeps pstack's playbooks, principles, and prose rules. Two things change, because DeepSeek Harness works differently from Cursor.

**The skills are the same skills.** All 56 of them, in the `/` menu under their pstack names. `/poteto-mode` runs the playbook, `/interrogate` runs the adversarial review, `/how` explains a subsystem, and the 24 `principle-*` skills carry the reasoning pstack is built on.

**The models are chosen for you, out of your own list.** pstack on Cursor names a model slug per role. ds-pstack cannot do that, because a Harness profile's models are whatever you configured and checked. So the router reads the child's task, decides what kind of work it is, and picks the best route from the models you checked for subagents. You never name a model, and neither does a skill.

## Install

The package installs as a Harness bundle, straight from this repository:

```
plugin_manager install_bundle github:monkeyin92/ds-pstack#main
```

That adds two plugin rows to the profile. Disable either one to keep the other.

| Row | What it does when disabled |
| --- | --- |
| `ds-pstack-skills` | pstack's skills leave the catalog; routing still works |
| `ds-pstack-router` | every child runs on the route it inherited; skills still work |

### Updates

Installing from the repository means updates are a pull, not a reinstall. The profile records a git dependency, so the next fetch picks up whatever is on `main`:

```
dsh plugin --profile <profile> update @local/ds-pstack
```

The profile's package manager resolves the branch to a commit and records both. Skill text reloads from disk on its own; the router's JavaScript is a separate module generation, so restart the Harness app after an update that changes `lib/`.

To stay on a fixed release instead of tracking `main`, install a tag:

```
plugin_manager install_bundle github:monkeyin92/ds-pstack#v0.1.0
```

A tag pins that commit until you install again. New tags are published as `v<version>` when the version in `package.json` changes.

## The model pool is yours


ds-pstack chooses only from the routes checked in **Settings → Subagent model selection** (`subagent-model-selection-settings.allowedModels`). That setting is the authorization boundary, so the router never widens it: a model you did not check is never sent, even when it would suit the task better.

Checking one model means every child runs on that model with a routing-chosen effort. Checking several means the router can match a cheap fast model to mechanical work and a strong one to review. Starting from a single model is fine and is how the router behaves before you add any.

To check models, open Settings, find Subagent model selection, enable it, and select the routes you want available.

## How a child's route is chosen

Every delegated child makes a model request. Before the first one, the router:

1. reads the delegation prompt, which is the brief the parent wrote;
2. classifies the work into one of eight intents (`planning`, `coding`, `debugging`, `review`, `research`, `analysis`, `writing`, `mechanical`) and reads its difficulty;
3. picks an effort from your pstack budget and that intent;
4. ranks the checked models for that intent and takes the best;
5. snaps the effort onto one the chosen route actually advertises.

The decision is cached for that child, so one subagent keeps one route for all of its requests. The journal at `~/.dsh/ds-pstack-router.jsonl` records every decision and every skip.

Three rules bound the guess:

- **An explicit request wins.** A parent that passes `provider`/`model`/`reasoning_effort`, or a skill that pins a route, is left alone. The router only fills a choice nobody made.
- **The pool is the authority.** No route outside the checked set is ever sent.
- **Routing never breaks delegation.** No pool, an unreadable setting, a failing model, or a classification that finds nothing leaves the child on the route it would have had. The journal says which happened.

### Classification is deterministic

`scores` in the journal explain every decision. A phrase-hint score decides the intent, with ties going to the more specific reading: "rename the util file" is mechanical work, not a feature, even though it names a file. No model request is spent classifying, because a child should not wait on a judgement call before it starts.

### Budgets

pstack's four budget labels still apply. `/setup-pstack` writes the one you choose:

| Budget | Base effort | Effect |
| --- | --- | --- |
| `unlimited` | `max` | everything thinks as hard as its route allows |
| `large` | `xhigh` | the pstack default |
| `medium` | `high` | cheaper, still thorough |
| `small` | `medium` | cheapest; mechanical work drops to `low` |

The intent shifts the base: implementation, debugging, and research start at the budget, review and prose one step below, mechanical edits two steps below. A task that reads hard goes up one step, an explicitly trivial one goes down one.

## Configuring roles

Run `/setup-pstack`. It reads your checked pool, asks for a budget, and writes `~/.dsh/ds-pstack-roles.json`:

```json
{
  "budget": "large",
  "intents": {
    "feature": "example-provider/example-model",
    "interrogate reviewers": "example-provider/stronger-model @ high"
  }
}
```

Keys are pstack role names from the mode skill (`feature`, `bug-fix`, `how explorer`, `swarm workers`, `interrogate reviewers`, `arena runners`, and the rest), or an intent id directly. A value is a full `provider/model` route and an optional `@ effort`.

A pin wins over classification, which is what letting a human decide means. A pin whose route is no longer checked is treated as stale and ignored rather than sent, so unchecking a model also unpins it.

## Verification skills

`/create-verification-skill` and `/create-formal-verification-skill` generate project-local skills, so agents can prove a change works instead of asserting it. They write to `.dsh/skills/` in the project, which Harness scans, and project skills outrank ds-pstack's own.

## What did not port

Cursor-only machinery: Automations, the Bugbot feed, cloud agents, and `-fast` speed selection. Where a playbook step needs one, the skill says so in one line and continues. The full mapping is in [docs/harness/deepseek-harness.md](docs/harness/deepseek-harness.md).

## Upstream

pstack is MIT licensed by Lauren Tan. Its license is kept in [LICENSE.pstack](LICENSE.pstack), and the unmodified upstream README is in [README.pstack.md](README.pstack.md). Skill text is pstack's, adapted only where a Cursor-specific name had to become a Harness one.

## Development

```
node --test "test/*.test.js"
```

93 tests cover classification and its positional weighting, delegate-preamble stripping, effort mapping, model ranking, pool enforcement, pin conflicts, fork protection, quarantine policy, privacy redaction, failure recovery, frontmatter parsing, and catalog publication. They run with no build step and no dependencies. The `skills/poteto-mode/scripts/` tooling has its own 73-test Bun suite, and `.github/workflows/ci.yml` runs both plus `tsc` and `bash -n`.
