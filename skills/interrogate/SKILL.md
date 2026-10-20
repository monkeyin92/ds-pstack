---
name: interrogate
description: "Use for \"interrogate\", \"adversarial review\", \"multi-model review\", \"challenge this\", \"stress test this code\", \"find blind spots\", or \"tear this apart\". Multiple LLM reviewers challenge changes from independent angles."
disable-model-invocation: true
---

# Interrogate

Spawn several reviewers to adversarially review code changes. The adversarial signal comes from route diversity, supplied by the ds-pstack router's checked pool, plus a distinct lens per reviewer. It does not come from assigned personas, and no reviewer gets its model chosen by hand. The deliverable is a synthesized verdict. Do NOT auto-apply changes.

## Step 1, Scope

Identify what to review from context:

- If the user points at specific files or a diff, use that.
- If on a feature branch, run `git diff main...HEAD` (or the appropriate base branch) for the full changeset.
- If the user's message references recent work, gather the relevant files.

Package the diff or file contents with any surrounding context files the reviewers need to understand the code.

## Step 2, Intent

Before spawning reviewers, state the intent in one clear paragraph from the user's message, commit messages, the PR description if one exists, and the code. If you're unsure about the intent, ask the user before proceeding.

## Step 3, Spawn Reviewers

Launch all reviewers in a single message so they run concurrently, labeled Reviewer A, B, and so on. Their role is `interrogate reviewers`, and the ds-pstack router chooses each child's route from the models checked in Settings, Subagent model selection.

**Never pass `provider`, `model`, or `reasoning_effort` on a reviewer spawn.** Passing any of them opts that child out of routing, which collapses the panel onto one route that you chose instead of one the pool chose.

Two reviewers is the floor: one forensics reader and one design reader. Use three when the change spans layers or touches a security or data boundary. More than four rarely pays for itself, because each needs the full diff and the synthesis has to stay honest.

Each reviewer is a `subagent` whose brief says "do not edit files and do not apply changes"; check `git status` afterward. Because a fresh `subagent` does not see this conversation, every brief carries the intent paragraph, the diff or file contents, and the `<pstack>` base directory this skill reported.

Read `references/reviewer-prompt.md` and fill in the same template for every reviewer with the stated intent, the diff or file contents, the rubric from `references/rubric.md`, and the code-quality lens from `references/code-quality-review.md`. Name each reviewer's lens explicitly, so the panel is genuinely diverse rather than three copies of the same question.

## Step 4, Synthesize

As results come back, build a unified picture. Parse every reviewer's findings. Merge findings that describe the same issue differently, and note which reviewer raised each one. Findings two or more reviewers raised independently are the highest signal, because independence is what makes agreement mean anything. Read a lone reviewer's finding, but weight it accordingly. Note disagreements. If one reviewer flags something and another explicitly says the opposite, that is context for the verdict.

## Step 5, Lead Judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read `references/lead-judgment.md` for the full framework. Put every finding in one of four buckets, with the reviewer(s) that raised it and a one-line rationale.

- **Act on**. Real issues affecting correctness, security, or maintainability given the actual goals. They would block a real PR.
- **Consider**. Legitimate, but you're not sure they outweigh the cost of addressing them now. Worth the user's attention.
- **Noted**. Technically valid but not actionable. Context-dependent, premature optimization, or low-impact at this stage.
- **Dismissed**. Wrong, nitpicky, or missing context, with a brief reason.

## Output Format

### Intent
> [The stated intent paragraph from Step 2]

### Reviewers
- Reviewer [label]: [lens], [N findings], and the route the child ran on when the harness reports one (one bullet per reviewer)

### Act On
[Each: description, which reviewers raised it, why it matters.]

### Consider
[Each: description, which reviewers raised it, the tradeoff.]

### Noted
[Brief list.]

### Dismissed
[Each with a brief rationale.]

### Agreement Map
[Where reviewers agreed and diverged, and what that pattern tells us. Independent agreement across routes is the strongest signal here.]
