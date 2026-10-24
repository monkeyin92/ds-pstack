---
name: poteto-help
description: Guides users through pstack setup, /poteto-mode, and picking the skill, playbook, or principle for a task. Type /poteto-help with a question.
disable-model-invocation: true
---

# Poteto help

Answer the user's question about pstack, hand them a prompt they can send, and link the file the answer came from. For a help question, don't start the work. The user asked how, and a pstack run spends real tokens, so let them send the prompt.

A message that asks for work, such as "use pstack to fix this bug", is not a help question. Read [`poteto-mode`](<pstack>/poteto-mode/SKILL.md), do the work under it, and mention once that starting each new task with `/poteto-mode` keeps the style on.

This file maps questions to the skills and docs that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. The links here point into this package, so give the user the path inside it, resolved against the `<pstack>` base directory the loaded skill reports.

## Find out what they need

Infer the need from the message and the conversation. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one multiple-choice question with these options, then answer only the section they pick:

- Get set up
- Start a task with `/poteto-mode`
- Pick a skill for a situation
- Fix a run that went wrong
- Make pstack my own

Check the state that changes the answer, and mention it only when it does:

- No `~/.dsh/ds-pstack-roles.json` means `/setup-pstack` hasn't run for this user, so the router routes every role from the checked pool at its own starting effort.
- No `verify-*` skill or other app harness in the project means agents have no scripted way to drive the app. Mention `/create-verification-skill` when the question is about proving a change works.
- No formal verification skill in the project means no property is checked past what tests reach. Mention `/create-formal-verification-skill` when the question is about a race, an invariant, or another case tests rarely hit. When one exists and the code it covers changed after the commit it records as last in sync, mention `/maintain-formal-verification-skill` if the question touches that code.

When the roles file is missing and it matters, ask whether the user wants to pin a route for each role and choose a reasoning budget now. It matters when the user is new, the question is about setup or cost, or the answer depends on which models run. Ask at most once per chat. If the need is also unclear, ask both questions together. Offer two choices:

- Now: give them `/setup-pstack` to type, and answer their question too.
- Later: answer their question, and add one line saying every role stays on the router's choice until they run `/setup-pstack`.

## Get set up

1. Install the package as a Harness bundle. `plugin_manager` with `install_bundle` against the package path adds the skills row and the router row to the profile.
2. Run [`/setup-pstack`](<pstack>/setup-pstack/SKILL.md). It reads the checked model pool, asks for a reasoning budget, pins a route for any role the user names, and writes `~/.dsh/ds-pstack-roles.json`. The file applies to new subagents. Then it offers once each to generate a verification skill and a formal verification skill for the project, unless the project already has one.
3. Start a real task with `/poteto-mode`, a goal, and a check that can pass or fail.

Installing changes nothing until the user invokes a skill. Only `/setup-pstack` loads from the user's words. The package README at `<pstack>/../README.md` has the details. Offer to word their first prompt with them, per [`<pstack>/poteto-help/references/prompting.md`](<pstack>/poteto-help/references/prompting.md).

If cost is the worry, say where the tokens go and how to spend fewer. pstack spends extra tokens on subagents and review panels. Rerun `/setup-pstack` and pick a smaller budget or a cheaper checked pool. A role left out of the file has no pin, so the router picks its route from the checked pool, which saves tokens when that pool has a cheap option. A shorter panel list runs fewer subagents, one for each entry. Save `/poteto-mode` for work that needs rigor.

This package is ds-pstack, the DeepSeek Harness port of pstack. The contract that maps every Cursor name to its Harness name is at `<pstack>/../docs/harness/deepseek-harness.md`. Read it before explaining any step that looks Cursor-shaped.

Other tools can read the skills, because they use the Agent Skills format. But most workflow skills, including `/poteto-mode`, `/how`, `/why`, and `/teach`, spawn subagents with per-role routes, and a step that needs a Cursor-only feature, such as Bugbot or Automations, is skipped with a one-line note.

## Start a task with `/poteto-mode`

`/poteto-mode` matches the task to a playbook, copies the playbook's steps into a `todo_write` list, and runs the other skills as the steps need them. A step it skips stays in the list as `skip: <reason>`. A good prompt states the goal and how to tell it's done. It doesn't list skills, because a hand-written sequence tends to drop or reorder steps the playbook would keep. Read [`<pstack>/poteto-help/references/prompting.md`](<pstack>/poteto-help/references/prompting.md) before you help word one. [`<pstack>/poteto-help/references/recipes.md`](<pstack>/poteto-help/references/recipes.md) has examples worth copying.

Whether `/poteto-mode` stays on depends on how the user starts it:

- Typing `/poteto-mode` attaches the skill to that turn. It fades as the chat moves on.
- There is no Custom Mode in DeepSeek Harness. To keep the style on, run each new task with `/poteto-mode`.

Mid-chat, "new task" makes the mode match a fresh playbook. `/poteto-mode` already gives every subagent its playbook steps spawn the delegate brief from `<pstack>/../docs/poteto-agent.md`. To get the same style from a subagent of your own, prepend that same brief to the `subagent` prompt.

## Pick a skill

The default answer is `/poteto-mode`, which runs most of the others when its steps need them. Name a skill directly when the user wants more or less of something than the playbook gives. Read the skill before you recommend it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Do any non-trivial task with rigor | [`/poteto-mode`](<pstack>/poteto-mode/SKILL.md) |
| Check that the agent understood their goal and the problem before it starts | [`/in-your-own-words`](<pstack>/in-your-own-words/SKILL.md) |
| Get a prompt rewritten deeper, not bigger, before sending it: what a top professional would add, their raw material and methods, and an outside check. It returns the prompt and doesn't do the task | [`/sharpen`](<pstack>/sharpen/SKILL.md) |
| Know how code works now, or where new code should live | [`/how`](<pstack>/how/SKILL.md) |
| Know why code is shaped this way, or where a number came from | [`/why`](<pstack>/why/SKILL.md) |
| Understand a change or subsystem, explained plainly | [`/teach`](<pstack>/teach/SKILL.md) |
| Catch up on their own recent work on a topic | [`/recall`](<pstack>/recall/SKILL.md) |
| Catch up on what changed in this chat since their last message, in plain words and small visuals, with every item waiting on them listed and decidable from the reply alone | [`/ketchup`](<pstack>/ketchup/SKILL.md) |
| Catch up like `/ketchup`, in a short silent video of slides, with the waiting calls as text under it | [`/ketchup-video`](<pstack>/ketchup-video/SKILL.md) |
| Know what a small diff could break outside itself | [`/blast-radius`](<pstack>/blast-radius/SKILL.md) |
| Settle types and module shape before code that crosses a function boundary | [`/architect`](<pstack>/architect/SKILL.md) |
| Get several attempts at one brief, merged into the best one | [`/arena`](<pstack>/arena/SKILL.md) |
| Run parallel checks over slices, or race workers, each in its own worktree | [`/swarm`](<pstack>/swarm/SKILL.md) |
| Have different models review a diff and try to break it | [`/interrogate`](<pstack>/interrogate/SKILL.md) |
| Fix a bug test-first when a cheap local test exists | [`/tdd`](<pstack>/tdd/SKILL.md) |
| Apply TypeScript rules to `.ts` or `.tsx` work | [`/typescript-best-practices`](<pstack>/typescript-best-practices/SKILL.md) |
| Strip comments before review, using a reviewer that didn't write them | [`/no-comments`](<pstack>/no-comments/SKILL.md) |
| Clean AI tells out of prose | [`/unslop`](<pstack>/unslop/SKILL.md) |
| Write docs, an RFC, a README, a PR description, or a commit message to a standard | [`/technical-writing`](<pstack>/technical-writing/SKILL.md) |
| Hear the last reply again in plain words | [`/bro`](<pstack>/bro/SKILL.md) |
| Give agents a scripted way to drive the app and prove behavior | [`/create-verification-skill`](<pstack>/create-verification-skill/SKILL.md) |
| Bring a verification skill and its feature map back in line with the app | [`/maintain-verification-skill`](<pstack>/maintain-verification-skill/SKILL.md) |
| Formally verify a race, invariant, or other property that tests rarely reach | [`/create-formal-verification-skill`](<pstack>/create-formal-verification-skill/SKILL.md) |
| Bring a formal verification back in line after the code it covers changed, and learn whether a failure is drift or a bug | [`/maintain-formal-verification-skill`](<pstack>/maintain-formal-verification-skill/SKILL.md) |
| Show a PM or designer what the user sees as a chart checked by a model, with each bug drawn as a numbered path, turn an agreed chart into a TLA+ skeleton, or audit the code against its TLA+ spec | [`/statechart`](<pstack>/statechart/SKILL.md) |
| Vet a performance number before reporting or acting on it | [`/benchmark-checklist`](<pstack>/benchmark-checklist/SKILL.md) |
| Run a large or cross-cutting change, or one to review after stepping away | [`/figure-it-out`](<pstack>/figure-it-out/SKILL.md) |
| Keep a decision log during a run, and review it afterward | [`/show-me-your-work`](<pstack>/show-me-your-work/SKILL.md) |
| Pin a route for a role and pick a reasoning budget | [`/setup-pstack`](<pstack>/setup-pstack/SKILL.md) |
| Turn their own working habits into a personal mode skill | [`/automate-me`](<pstack>/automate-me/SKILL.md) |
| Turn what a finished task taught into skill edits | [`/reflect`](<pstack>/reflect/SKILL.md) |
| Stop agents from repeating the same mistakes in this repo | [`/correct`](<pstack>/correct/SKILL.md) |
| Build a page whose buttons wake a Grok Bot over a webhook | [`/make-bot-ui`](<pstack>/make-bot-ui/SKILL.md) |
| Find their way around pstack | `/poteto-help` |

If a skill directory next to this one is missing from the table, read its frontmatter and route by its description. The `principle-*` directories are covered under principles below.

Close calls:

- `/how` explains what the code does. `/why` explains the reasons. `/teach` runs one or both and explains the result plainly.
- `/arena` gives every worker the same brief and merges the best parts. `/swarm` splits work into slices or a race and returns one report.
- `/architect` implements right after it settles the design. Add "with checkpoint" to review the design before it writes code.
- `/interrogate` reviews the diff. `/blast-radius` looks for breakage outside the diff and proves the one fact that makes the change safe.
- `/recall` rebuilds context across recent chats. `/ketchup` covers only this chat since the user's last message. Resuming one specific chat or branch is the Session pickup playbook.
- `/figure-it-out` designs one rigorous run. The Orchestrate playbook runs a program that spans days and many PRs. The Autonomous run playbook drives one task to a finish condition.

Not in ds-pstack:

- `/deslop`, `control-cli`, and `control-ui` ship in Cursor's `cursor-team-kit` plugin, which has no DeepSeek Harness counterpart. Substitute the **unslop** skill for `/deslop`, and drive the surface from `bash` or with the browser-driving skill the profile installs.
- `/create-skill` is a Cursor built-in with no counterpart here, so authoring a skill follows the frontmatter rules in the Authoring playbook instead.
- pstack has no `/orchestrate` skill. Orchestrate is a `/poteto-mode` playbook. If the slash menu shows `/orchestrate`, another plugin provides it.
- `/add-plugin` and Custom Modes are Cursor features. A Harness profile installs this package as a bundle through `plugin_manager`.

## Playbooks and principles

Playbooks are step lists inside `/poteto-mode`, not skills, so they have no slash command. Inside `/poteto-mode`, describing the task picks one, and these phrases name one directly:

- "babysit this pr" or "check on pr 123" runs Babysit. It drives the PR to merge-ready and stops there. It doesn't merge unless the user asks to merge, land, or ship.
- "land the stack" runs Shipping.
- "take over this branch" runs Session pickup.
- "pause safely" runs Pause safely.
- "full autopilot on this queue" runs Autopilot-full. "stack them, don't ship" runs Autopilot-stack.
- "run the eval playbook" runs Eval.

Without `/poteto-mode`, a phrase such as "babysit this pr" can start another installed skill for the same job instead. Say you are running the Babysit playbook when that happens. The Playbooks section of [`poteto-mode`](<pstack>/poteto-mode/SKILL.md) lists every playbook and when it applies.

pstack has no planning skill. For work that spans phases or stacked PRs, asking `/poteto-mode` for a plan runs the [Multi-phase plan playbook](<pstack>/poteto-mode/playbooks/multi-phase-plan.md), which writes the plan and doesn't implement it. For a design question, the Prototype playbook or `/architect` settles it in code first.

Principles are one-rule skills that `/poteto-mode` reads and cites in its replies. The user rarely invokes one. They steer with the names instead, as in "apply prove it works. show me the real output." Typing `/principle-<name>` still loads one on demand.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| The mode stopped applying after a few turns | DeepSeek Harness has no Custom Mode, so the skill attaches to one turn. Start each task with `/poteto-mode`. |
| A question got treated as the next step of the last task | Say "new task", or say the turn doesn't need the mode. |
| A new model choice had no effect | The file from `/setup-pstack` routes new subagents, and a running child keeps its route. Start a new delegation. |
| Runs cost more than expected | See the cost paragraph under Get set up. |
| A skill didn't load on its own | Only `/setup-pstack` loads from the user's words. The others load when the user types them or when `/poteto-mode` runs them, and it doesn't run every skill. |
| Parallel agents overwrote each other | Children share the filesystem, so give each one its own `git worktree add` tree. |
| An overnight run moved but finished nothing | `create_goal` needs a check that can pass or fail, not a duration. Give it the predicate. |
| The reply claims success from a green build | Ask for the real command, flow, stored value, or profile. That's the prove-it-works principle. |

For a run that drifts, [`<pstack>/poteto-help/references/prompting.md`](<pstack>/poteto-help/references/prompting.md) has one-line steers. [`<pstack>/poteto-help/references/recipes.md`](<pstack>/poteto-help/references/recipes.md) has the recipes worth copying.

## Make pstack my own

- [`/automate-me`](<pstack>/automate-me/SKILL.md) drafts a personal mode skill from the user's own history, to use alongside `/poteto-mode`.
- [`/reflect`](<pstack>/reflect/SKILL.md) after a session turns its lessons into skill edits the user approves.
- `/poteto-mode write a skill for <workflow>` runs the authoring playbook. The eval playbook tests a skill change blind.
- Fix a misbehaving skill in its own PR, not inside the feature work where it went wrong.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [`<pstack>/poteto-help/references/recipes.md`](<pstack>/poteto-help/references/recipes.md) when one fits, then the link to that file. Keep it short unless the user asked for the whole map.
