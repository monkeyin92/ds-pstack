---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget. Reads the models checked for subagents, asks for a budget, and writes ~/.dsh/ds-pstack-roles.json, which the ds-pstack router reads. Use for /setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack

Write `~/.dsh/ds-pstack-roles.json`, the file that maps each pstack role to the intent route it should use, with the reasoning budget recorded alongside.

DSH's subagent router already chooses a route for every child from the model pool the user checked in Settings, Subagent model selection (`subagent-model-selection-settings.allowedModels`). This file records the budget that shapes those choices, and it pins a route for any role the user wants fixed. A skill body never names a model. This file is the one place a route may be pinned, and only from that checked pool.

## Steps

### 1. Read the checked model pool

The pool is the model list checked under Settings, Subagent model selection. Read it from the profile's patch layer, `~/.dsh/profiles/<profile>/cordis.patch.yml`, under the `subagent-model-selection-settings` entry, key `allowedModels`. Each entry has a `provider` and a `model`, and its route id is `<provider>/<model>`, exactly as the settings card displays it. A provider or model id may itself contain a `/`, so copy the pair rather than guessing where the split falls. The GUI shows the same list. If you cannot read the file, ask the user to paste the checked routes, or to check at least one model in that Settings section. Never write a route you have not confirmed is checked.

### 2. Load current state

If `~/.dsh/ds-pstack-roles.json` already exists, read it and treat its `budget` and its `intents` values as the current choices. Otherwise start from the role list in step 5 with no pins, which means the router decides every role from the pool. An intent whose id is not in step 5, such as `how critics`, is from a retired role. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget.** Prefer `ask_user_question` over free text. Offer these four options with these exact labels, and name the current budget when the file records one. With no file, say that `large` matches the router's starting level.

- `unlimited — max reasoning`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Apply it.** `unlimited`, `large`, `medium`, and `small` set the router's base reasoning effort for every role to `max`, `xhigh`, `high`, or `medium`, and each intent shifts from that base. Write the label into the file as `budget`, because it is the input the router reads. A pinned route is a separate decision, made in step (c). Do not rewrite a pin's effort suffix to chase the budget. A pin names one exact route from the pool, and the router honours it as written.

**(c) Show the roles and confirm.** Show every role from step 5 with its state, which is either `router` (no entry, the router picks from the pool) or the pinned route. Ask whether to accept as-is or pin specific roles, offering the checked pool as the options. Prefer `ask_user_question` over free text. There is no inherit alias in this file. Leaving a role out is how it inherits, because the router then classifies that child and picks from the pool. A pin is one route string per role. For a panel role (arena runners, architect runners, interrogate reviewers, arena cross-judge pool) that one pin is the route every member of the panel runs on, and the skill still decides how many members to spawn.

**(d) Validate every pinned route against the pool.** Each pin must be an exact `<provider>/<model>` string in the checked pool. If a chosen route is not in the pool, stop and ask again. Checking the model in Settings first is the fix, and it is the user's click, not yours. A pin that no longer matches the pool is ignored by the router rather than sent, so a stale pin fails safe, but do not leave one in the file.

### 4. Write the file

Write `~/.dsh/ds-pstack-roles.json`. Valid JSON, no comments, no other keys. Overwrite the whole file so re-runs stay idempotent. Shape:

```json
{
  "budget": "large",
  "intents": {
    "feature": "example-provider/example-model",
    "interrogate reviewers": "example-provider/stronger-model @ high"
  }
}
```

`budget` is one of `unlimited`, `large`, `medium`, `small`. `intents` maps an intent id to one route. An intent with no entry stays on the router's own choice, so leave a role out rather than writing a placeholder. A value may carry an effort as `<route> @ <effort>`, as in `"interrogate reviewers": "example-provider/stronger-model @ high"`. Replace the sample routes above with ids from the checked pool. Keep the shape exactly `{"budget":"<label>","intents":{"<intent>":"<route>"}}`.

### 5. The intent ids

These are the roles from the pstack role lines, and they are the ids `intents` accepts. Keep the spelling exactly as written, spaces included.

```
feature
refactoring
bug-fix
perf-issue
hillclimb
judgment and prose
hardest tasks
how explorer
how explainer
why investigators
why synthesizer
reflect tooling
reflect judgment
arena runners
arena cross-judge pool
swarm workers
architect runners
interrogate reviewers
```

Each code playbook reads its own id (`feature, refactoring`, `bug-fix`, `perf-issue`, `hillclimb`). The hardest changes read `hardest tasks`, and prose and judgment read `judgment and prose`. A role with no entry is routed by the router from the pool, at the budget recorded above.

Several roles share one intent, which is why the router resolves a role name through its intent. A pin is stored per intent, so pinning any role in a group pins the whole group. Say this out loud when the user pins one, so a pin is not a surprise later. The groups are:

- `coding` — `feature`, `refactoring`, `swarm workers`
- `debugging` — `bug-fix`, `perf-issue`
- `analysis` — `hillclimb`, `why synthesizer`, `reflect tooling`
- `writing` — `judgment and prose`, `how explainer`
- `planning` — `hardest tasks`, `arena runners`, `architect runners`
- `research` — `how explorer`, `why investigators`
- `review` — `reflect judgment`, `arena cross-judge pool`, `interrogate reviewers`

Two roles in one group cannot carry different routes. If the user asks for that, explain the grouping and offer a different role for one of them, or leave both unpinned so the router decides. The router keeps the first pin it reads and ignores a later conflicting one with a warning in `~/.dsh/ds-pstack-router.jsonl`; it does not silently merge them. Write one entry per intent so the file never contains a pin the router will drop.

### 6. Confirm

Tell the user which file was written, its budget, and which roles are pinned. It applies to new subagents, so a running child keeps the route it already has. Re-running this skill updates it.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, read `<pstack>/create-verification-skill/SKILL.md` and follow it. On no, move on without pushing.

### 8. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, read `<pstack>/create-formal-verification-skill/SKILL.md` and follow it. On no, move on without pushing.
