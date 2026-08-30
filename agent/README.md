# The Vetit agent

`vetit-agent.json` is the manifest. Two registrations have to happen, in this
order.

Both need TrueForge to have a **model provider** and a **sandbox provider**
configured first. Skills are materialised in a sandbox, so an agent naming one
is rejected outright without it — on macOS and Linux a local sandbox is used
automatically, and Windows has no local provider and needs one registered.

**First the skill.** The manifest's `skills` block says `{"name":
"vetit-review"}` and nothing more — that is a *reference*. Until the skill is
registered from git, that name resolves to nothing and agent creation fails.

```bash
curl -X POST http://localhost:8790/api/v1/settings/skills \
  -H 'content-type: application/json' \
  -d '{"manifest":{"type":"git",
                   "name":"vetit-review",
                   "url":"https://github.com/<you>/vetit",
                   "path":"skills/vetit-review",
                   "ref":"main",
                   "description":"Review an MCP server before it is trusted."}}'
```

Every settings write is wrapped in `manifest`, and the schema is closed: an
unrecognised key is a 400, not an ignored field.

**Then the agent.**

```bash
curl -X POST http://localhost:8790/api/v1/agents \
  -H 'content-type: application/json' \
  -d "{\"name\":\"vetit\",\"manifest\":$(cat agent/vetit-agent.json)}"
```

`scripts/setup.sh` does both, in that order, along with starting both servers.
It derives the repository url from `origin` and the ref from the current
branch; override either with `VETIT_SKILL_REPO_URL` and `VETIT_SKILL_REF`.
Because the skill is fetched from git rather than from disk, the branch you
point at has to be pushed — a skill registered against an unpushed ref will
fail to resolve when the agent first reaches for it.

## Two choices made on purpose

**`require_approval_for_tools` lists literal tool names, not `@write`.**
TrueForge works out the `@write` group from each tool's `readOnlyHint` and
`destructiveHint` annotations. This project exists because servers lie in
exactly those fields — so relying on them for Vetit's *own* approval settings
would mean the review agent's safety rail is built from the thing it is meant
to distrust. Naming `probe_tool`, `quarantine_server` and `write_admission`
outright costs three lines and depends on nothing a server can influence.

**`preload: true` on `vetit`, `preload: false` on `exa`.**
The Vetit server is small and used on every single run, so its manifest is
worth carrying in context from the start. `exa` is used occasionally, at the
cross-check step, and preloading it would spend context on tools most runs
never touch. This is the trade-off the TrueForge docs describe, decided
deliberately rather than left at whatever the default happens to be.

## Why the playbook is a skill and not `instructions`

The full review playbook — the attack list, the severity rules, the pass
order, the report format — runs to several pages. Put in `instructions`, it
would sit in the context window of every turn, including the ones that never
review anything. As a git-registered skill it loads only when the agent
decides it needs it. The cost of the playbook is then paid once, by the run
that uses it.
