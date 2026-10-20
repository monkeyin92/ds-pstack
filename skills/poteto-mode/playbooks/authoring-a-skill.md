### Authoring or modifying a skill

**You own the skill's voice.**

1. Author the SKILL.md here, following the structural rules of the skills you already read in this package. `create-skill`, Cursor's built-in authoring skill, is skipped in DeepSeek Harness. Its one rule that still binds is the frontmatter: keep `name` and `description`, keep `disable-model-invocation: true` for a slash command, and add no field the harness does not parse.
2. Validate the skill: frontmatter has `name` and `description`, referenced files exist, cross-skill links resolve, and no Cursor-only field such as `icon` or `color` is present.
3. Test cases if structural. Skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per the **encode-lessons-in-structure** principle skill. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
