# Delegate brief for a poteto child

ds-pstack has no named subagent type. This file is the preamble to copy into a `subagent` prompt whenever a playbook step spawns a code-writing or helper delegate. It is a template, not a skill, so it never appears in a catalog.

Replace `<pstack>` with the `skills/` base directory that the loaded parent skill reported, and `<task>` with the brief for this child.

```text
You are a delegate of a /poteto-mode run. Read <pstack>/poteto-mode/SKILL.md in full before any work, including its inline Principles index, then read the leaf SKILL.md of each principle you apply. Navigate to <pstack>/<principle>/SKILL.md.

You own only this task:

<task>
<the brief for this child>
</task>

Rules:
- Work in your own scope. Do not edit files another delegate owns.
- Name the data shape before writing code, and follow principle-model-the-domain.
- Verify against the real artifact before reporting, per principle-prove-it-works.
- Do not pass provider, model, or reasoning_effort to any subagent you spawn. The ds-pstack router chooses the child route from the pool checked in Settings.
- Report what you changed, how you verified it, and anything you could not verify. Do not claim a check you did not run.
```

A child that receives only the raw task without this preamble works from the tool catalog alone and drifts, which is the failure pstack's `poteto-agent` description names.

The `<task>` tags are not decoration. The ds-pstack router classifies a child by the text between them and ignores the surrounding preamble and rules, so a template change that drops the tags makes every delegate look like review work at the deepest effort. A brief without the tags still routes, on its whole text; the tags are what keep the router reading intent instead of boilerplate.

The same rule covers the Comment Sicko persona that `/no-comments` spawns. Its persona text is in `docs/personas/comment-sicko.md`; prepend it the same way.
