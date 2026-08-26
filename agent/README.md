# The Vetit agent

`vetit-agent.json` is the manifest. Create the agent with:

```bash
curl -X POST http://localhost:8790/api/v1/agents \
  -H 'content-type: application/json' \
  -d "{\"name\":\"vetit\",\"manifest\":$(cat agent/vetit-agent.json)}"
```

`scripts/setup.sh` does this for you, along with starting both servers.

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
