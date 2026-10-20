---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
disable-model-invocation: true
---

# Swarm

## Start

Open a `todo_write` list with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
3. Workers fill the `swarm workers` role. The ds-pstack router chooses each worker's route from the models checked in Settings, Subagent model selection, and never pass `provider`, `model`, or `reasoning_effort` on a worker spawn: doing so opts that worker out of routing. A model race is not expressible through the router, so run a mixed-shape race by giving each arm a distinct brief and letting the router route each one; if the race genuinely needs a fixed model per arm, say so, pass that route explicitly, and accept that those arms are unrouted.
4. Give each worker its own writable output when it writes. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers as `subagent` calls in one assistant message so they run concurrently. `subagent` returns immediately and reports completion later, so there is nothing to pass for background execution. Each worker shares this filesystem, so a worker that writes gets its own directory or its own `git worktree add`; two workers must never write the same path.

When a worker must start from a non-default pushed branch, create the worktree from that branch with `bash` and name the path in its brief.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.
