# ds-pstack

[![GitHub stars](https://img.shields.io/github/stars/monkeyin92/ds-pstack?style=social)](https://github.com/monkeyin92/ds-pstack)

**把 pstack 的 57 个严谨工程 skill 搬到 DeepSeek Harness，子 agent 的模型自动从你勾选的模型里挑，分类不另打一次模型。**

Lauren Tan's [pstack](https://github.com/cursor/plugins/tree/main/pstack) agent workflows, ported to DeepSeek Harness. Same 57 skills, plus a deterministic router that picks each subagent's model from the models *you* checked.

## 和原版 pstack 有什么不同 / What's different

| | pstack (Cursor) | ds-pstack (DeepSeek Harness) |
| --- | --- | --- |
| Skills | 57 skills, `/poteto-mode` etc. | 同样的 57 个，名字不变 / the same 57, same names |
| 子 agent 模型 / Subagent model | 每个角色写死一个模型 slug / a model slug per role | 按任务意图从你勾选的模型池里自动挑 / routed by task intent from your checked pool |
| 分类开销 / Routing cost | n/a | 确定性规则分类，分类不调用模型 / deterministic classification, no model call |
| 越权 / Pool boundary | n/a | 路由器只从勾选池里选 / the router only selects from the checked pool |

## 快速安装 / Quick install

```
plugin_manager install_bundle github:monkeyin92/ds-pstack#main
```

然后 / then:

1. Settings → Subagent model selection，打开并勾选你想给子 agent 用的模型 / enable it and check the models you want
2. 运行 `/setup-pstack` 选预算 / pick a budget
3. 开干 / go:

```
/poteto-mode this pr has a subtle bug where the scroll drifts every 750ms even when idle. repro first, then fix and verify.
```

其他常用 / Other handy skills: `/interrogate` 对抗式 review，`/how` 讲清一个子系统，`/poteto-help` 不知道用哪个时问它。

---


[pstack](https://github.com/cursor/plugins/tree/main/pstack) for DeepSeek Harness. pstack is Lauren Tan's set of agent workflows: write less code, but higher quality code, and parallelize with confidence.

This port keeps pstack's playbooks, principles, and prose rules. Two things change, because DeepSeek Harness works differently from Cursor.

**The skills are the same skills.** All 57 of them, in the `/` menu under their pstack names. `/poteto-mode` runs the playbook, `/interrogate` runs the adversarial review, `/how` explains a subsystem, and the 24 `principle-*` skills carry the reasoning pstack is built on.

**The models are chosen for you, out of your own list.** pstack on Cursor names a model slug per role. ds-pstack cannot do that, because a Harness profile's models are whatever you configured and checked. So the router reads the child's task, decides what kind of work it is, and picks the best route from the models you checked for subagents. A skill never names a model. The router picks from that checked pool, and `/setup-pstack` is the only place a route is pinned.

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

The profile's package manager resolves the branch to a commit and records both. Skill text reloads from disk on its own. The router's JavaScript is a separate module generation, so after an update that changes `lib/` the plugin has to be re-mounted: toggle the `ds-pstack-router` row off and on in Plugin Manager, which re-imports the module. A full app restart also works, and is the simpler option if you are unsure.

To develop against a checkout instead of the published copy, install it by path (`plugin_manager install_bundle /absolute/path`) and reinstall from the git spec when you are done.

To stay on a fixed release instead of tracking `main`, install a tag:

```
plugin_manager install_bundle github:monkeyin92/ds-pstack#v0.1.0
```

A tag pins that commit until you install again. New tags are published as `v<version>` when the version in `package.json` changes.

## The model pool is yours


ds-pstack chooses only from the routes checked in **Settings → Subagent model selection** (`subagent-model-selection-settings.allowedModels`). That setting is the authorization boundary, so the router never widens it: the route it selects is always one you checked, even when another model would suit the task better.

Checking one model means each routed child runs on that model with a routing-chosen effort. Checking several means the router can match a cheap fast model to mechanical work and a strong one to review. With none checked, the router leaves each child on the route it inherited. A forked child keeps its inherited route unless `routeForkedChildren` is turned on, and a delegation that already names `provider`, `model`, or `reasoning_effort` is left alone.

To check models, open Settings, find Subagent model selection, enable it, and select the routes you want available.

## How a child's route is chosen

Every delegated child makes a model request. Before the first one, the router:

1. reads the delegation prompt, which is the brief the parent wrote;
2. classifies the work into one of eight intents (`planning`, `coding`, `debugging`, `review`, `research`, `analysis`, `writing`, `mechanical`) and reads its difficulty;
3. picks an effort from your pstack budget, that intent, and that difficulty;
4. ranks the checked models for that intent and takes the best;
5. snaps the effort onto one the chosen route actually advertises.

The decision made from the child's own prompt is cached, so later requests from that subagent reuse it until the checked pool drops that route or the route fails. A guess borrowed from the parent task is not cached. The journal at `~/.dsh/ds-pstack-router.jsonl` records every decision and every skip.

Three rules bound the guess:

- **An explicit request wins.** A parent that passes `provider`/`model`/`reasoning_effort` is left alone, including a skill that puts those fields on the delegation. The router only fills a choice nobody made. A pin in `~/.dsh/ds-pstack-roles.json` is a different decision: the router applies it, and it wins over classification.
- **The pool is the authority.** The router never selects a route outside the checked set.
- **Routing never breaks delegation.** No checked pool, an unreadable subagent-model setting, no task text, a catalogue error, or no usable checked route leaves the child on the route it inherited. A failed routed request is retried, up to `maxRouteRetries`. A route-level failure is quarantined so the next choice skips it. Once retries are exhausted, that request fails. The journal says which happened.

### Classification is deterministic

`scores` in the journal explain every decision. Phrase hints score the intent. The opening instruction outweighs later context, a hard or easy read can move the score, and ties go to the more specific reading: "rename the util file" is mechanical work, not a feature, even though it names a file. No model request is spent classifying, because a child should not wait on a judgement call before it starts. When every hint scores zero and the task is not marked hard or easy, the fallback intent is coding, and the child is still routed.

### Budgets

pstack's four budget labels still apply. `/setup-pstack` writes the one you choose:

| Budget | Base effort | Effect |
| --- | --- | --- |
| `unlimited` | `max` | everything thinks as hard as its route allows |
| `large` | `xhigh` | the router default |
| `medium` | `high` | cheaper, still thorough |
| `small` | `medium` | cheapest; mechanical work lands on `low` |

The intent shifts the base: planning, coding, debugging, research, and analysis start at the budget, review and writing sit one step below, and mechanical edits sit two steps below. A task that reads hard goes up one step, and an explicitly trivial one goes down one. The requested effort never goes below `low`, and it then snaps to an effort the chosen route advertises.

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

`/create-verification-skill` and `/create-formal-verification-skill` generate project-local skills, so agents can prove a change works instead of asserting it. `/create-verification-skill` writes `.dsh/skills/verify-<app>/`, which Harness scans. `/create-formal-verification-skill` writes a project-local skill and does not name a directory. A project skill of the same name outranks ds-pstack's own.

## What did not port

Cursor-only machinery: Automations, the Bugbot feed, cloud agents, and `-fast` speed selection. Where a playbook step needs one, the skill says so in one line and continues. The full mapping is in [docs/harness/deepseek-harness.md](docs/harness/deepseek-harness.md).

## Upstream

pstack is MIT licensed by Lauren Tan. Its license is kept in [LICENSE.pstack](LICENSE.pstack), and the unmodified upstream README is in [README.pstack.md](README.pstack.md). Skill text is pstack's, adapted where a Cursor-specific name had to become a Harness one. Where a step needs Cursor-only machinery, the skill says so in one line and continues.

## Development

```
node --test "test/*.test.js"
```

99 tests cover classification and its positional weighting, delegate-preamble stripping, path stripping, effort mapping, model ranking, pool enforcement, pin conflicts, fork protection, quarantine policy, privacy redaction, failure recovery, frontmatter parsing, and catalog publication. They run with no build step and no dependencies. The `skills/poteto-mode/scripts/` tooling has its own 73-test Bun suite, and `.github/workflows/ci.yml` runs both plus `bun run typecheck` and `bash -n`.
