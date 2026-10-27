---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
disable-model-invocation: true
---

# Arena

Open a `todo_write` list with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. The role is `arena runners`, and the ds-pstack router chooses each runner's route from the models checked in Settings, Subagent model selection. Never pass `provider`, `model`, or `reasoning_effort` on a runner spawn: doing so opts that runner out of routing, which is what reduces an arena to one model's opinion.

   Two runners is the floor, because an arena with one candidate is not an arena. Spawn three or more when the arena covers multiple design directions. When the work is generation-bound rather than judgment-sensitive, more runners on the same brief still help: each gets an independent brief and the router decides its route.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill.

## Phase B: Fan out

Spawn all N candidates as `subagent` calls in one assistant message so they run concurrently. Each brief gets the task, the path to the shared grounding, its own output path, and instructions to produce the artifact plus a short rationale naming the alternatives it considered and what it rejected. A fresh `subagent` does not see this conversation, so every brief is self-contained. Because candidates share this filesystem, each one writes only to its own output path.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, spawn one judge `subagent`. Role: `arena cross-judge pool`. Its brief says "do not edit files". The judge's value is a route other than the parent chat's own. The ds-pstack router picks from the checked pool and cannot exclude the parent's route, so when the checked pool holds a single route, skip the judge, pick the base alone in Phase D, and say so. Otherwise spawn it. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

   The judge's value comes from independence, so give it only the rubric and the paths, never your own read of the candidates.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge when Phase C ran one. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict or that Phase C skipped the judge, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.
