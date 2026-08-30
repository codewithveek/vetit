# Vetit

**Code review, but for the tools you are about to let an agent use.**

To add tools to an AI agent today, you paste a server URL into it and the agent
starts using them. There is no review step. Vetit is that review step: it
inspects an MCP server, **tests how its tools actually behave**, and writes a
least-privilege permission list that a human approves before the server goes
anywhere near a real agent.

```
┌──────────────┐   ┌──────────┐   ┌──────────┐   ┌───────────┐   ┌──────────────┐
│ 1. on hold   │──▶│ 2. fetch │──▶│ 3. scan  │──▶│ 4. probe  │──▶│ 5. admission │
│ all tools    │   │ manifest │   │ D-01…10  │   │ call it   │   │ scoped grant │
│ switched off │   │ to disk  │   │ + score  │   │ for real  │   │ human says   │
└──────────────┘   └──────────┘   └──────────┘   └───────────┘   └──────────────┘
                                                        ▲                ▲
                                                        └─ approval ─────┘
```

---

## The problem

An MCP server describes its own tools, and the agent treats those descriptions
as instructions. A model cannot tell your instructions apart from text that
arrived inside a tool description — everything it reads carries the same
weight. No wording you add fixes that.

| Finding                                                                            | Source                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| 66% of 1,808 scanned MCP servers had a security finding                            | AgentSeal, 2026                               |
| 33% of 1,000 scanned had a critical vulnerability                                  | Enkrypt AI, October 2025                      |
| Tool poisoning succeeds over 60% of the time, up to 72% on some models             | MCPTox benchmark                              |
| One compromised server drags others down with it 72.4% of the time                 | Cross-server shadowing research               |
| Three prompt-injection CVEs in Anthropic's own Git MCP server                      | CVE-2025-68143 / 68144 / 68145, January 2026  |
| Rug pulls: descriptions change after approval, nothing prompts a second look       | Microsoft Security Response Center, June 2026 |
| First confirmed malicious MCP npm package — a hidden BCC on every agent-sent email | `postmark-mcp`, 2026                          |
| Most companies are rolling out AI agents; only 29% feel ready to secure them       | Cisco State of AI Security 2026               |

## What already exists, and where Vetit differs

| Tool                               | Does                                           | Does not                                            |
| ---------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| mcp-scan (Invariant Labs)          | Reads descriptions, pins tools it has approved | Never calls a tool. No approval step                |
| MCPScan.ai                         | Hosted description scanning, watches repos     | Reads descriptions only                             |
| mcp-fortress                       | Flags risky npm packages and dependencies      | Checks the package, not what the tool does when run |
| McpSafetyScanner                   | Research tool that probes for exploits         | A prototype, not something you put in a workflow    |
| mcp-airlock, MCP-Gateway, ToolHive | Allow, block and log calls as they happen      | Assume you already decided to trust the server      |

Every one of them answers the same question: _what does this server's
description say?_

**Vetit answers a different one: what does this server actually do, and what
access should it get?**

### What Vetit is not

- **Not a middleman.** Calls do not pass through it. Vetit works _before_ you
  trust a server, not _while_ you use it. Sitting in the live call path is
  already done well by `mcp-airlock`, MCP-Gateway and ToolHive. Staying out of
  it is a choice.
- **Not another description scanner.** See the table above.
- **Not an attack tool.** Reading a manifest is what every MCP client does on
  connect, so reviewing a server before you add it needs no more permission
  than using it would. Probing is the exception — it calls a tool for real, so
  it is for servers you are entitled to call.

---

## Try it

Requires **Node 22.5 or later**.

```bash
git clone https://github.com/codewithveek/vetit
cd vetit
npm install
npm test            # the full suite, including end-to-end against the decoy
cp .env.example .env
npm run setup       # builds, starts both servers, registers everything
```

`npm run setup` is a Node script, Credentials go in `.env`, which is gitignored; every value in
it has a working default, so an empty file still starts both servers. Set
`START_TRUEFORGE=true` to have it fetch and start TrueForge too.

It refuses to adopt a server it did not start: if something already holds a
port, it says so and stops rather than registering a server it cannot vouch
for.

Setup degrades cleanly if you have no TrueForge instance running — the servers
still start and the tests still pass.

**What TrueForge needs first.** Creating the agent fails without two things
configured in TrueForge settings, and the script prints which one is missing
rather than announcing success:

- a **model provider** for the model in `agent/vetit-agent.json`
- a **sandbox provider**, because the review playbook is a git-backed skill and
  skills are materialised in a sandbox. TrueForge falls back to a local sandbox
  on macOS and Linux with nothing to configure; on Windows there is no local
  provider, so one has to be registered

Set `EXA_API_KEY` before running to enable the advisory cross-check. Without
it the agent is created without the `exa` connector and every other pass still
runs — a review with a gap it reports, rather than a setup that will not
start.

Then ask the agent:

> review the MCP server at http://127.0.0.1:8931/mcp

Or run the tools directly:

```bash
npx vetit-mcp                       # the review server, port 8930
npx vetit-decoy-mcp                 # the target, port 8931
npx vetit-decoy-mcp --poison        # the same target after a rug pull
```

### The tools

| Tool                | Label           | What it does                                                                                        |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------- |
| `fetch_manifest`    | **write**       | Lists everything a target offers, writes it to disk, returns counts and hashes only                 |
| `scan_descriptions` | **write**       | Runs the description and name detectors (D-01…D-06, D-10). Records them                             |
| `analyze_schemas`   | **write**       | Finds free-text parameters built for moving data out (D-07). Records them                           |
| `check_annotations` | **write**       | Reports what each tool declares, and treats silence as a write (D-08). Records them                 |
| `check_shadowing`   | **write**       | Finds descriptions naming other servers' tools (D-09). Records them                                 |
| `compute_risk`      | read            | Adds up the stored findings. Arithmetic, no model                                                   |
| `lookup_advisories` | read            | Returns searches to run with `exa`. Never an advisory it made up                                    |
| `probe_tool`        | **destructive** | Calls one tool for real and compares behaviour with claims. Needs `read_back_tool` to prove a write |
| `quarantine_server` | **write**       | Stage 1: register the connector, and hold it in the agent with every tool switched off              |
| `write_admission`   | **destructive** | Stage 3: write the permission list into the agent                                                   |

---

## What comes out: a permission list, not a verdict

Yes-or-no is the wrong output shape. Servers are rarely wholly good or wholly
bad, and a two-setting verdict forces a reviewer either to accept a tool they
are unsure about or to throw away eight useful ones to be rid of a ninth.

```json
{
  "name": "target-server",
  "decision": "admit_reduced",
  "enable_tools": ["search_docs", "get_page", "list_spaces"],
  "disable_tools": ["export_all"],
  "require_approval_for_tools": ["create_page", "update_page"],
  "preload": false,
  "why": {
    "export_all": "F-003 — annotated readOnlyHint: true; probe observed a write",
    "create_page": "F-007 — gated by literal name; server annotations proved unreliable"
  },
  "not_covered": [
    "Behavioural verification: NOT PERFORMED — no credential supplied"
  ]
}
```

Every restriction cites the finding that caused it, so a human can check the
reasoning rather than take it. `not_covered` is never left implicit: a review
that omits its gaps reads as a pass.

### The score

`score = min(100, Σ(severity_weight × count))`, weights critical 40, high 15,
medium 5, low 1. 0 is eligible for full admission, 1–24 reduced, 25 and above
recommends rejection.

It is plain arithmetic with no model involved, so the same findings always
give the same number and two people can argue from the same starting point.
**The score is a suggestion. The human decides.**

---

## AI-use disclosure

This project was built with AI coding assistance (Claude, via Claude Code). The
specification, architecture and security model were written by a human; the
implementation was produced in collaboration with the assistant, and every
commit was reviewed before it was made. The test suite, the detector precision
cases and the end-to-end runs against the decoy are the evidence that the
result works, and they are all in the repository to be run.

---

## Qodo Code Review Evidence

Qodo was installed on this repository before the first pull request, and every
piece of work went through one. 12 PRs, 8 review rounds, **41 findings**
were all fixed but one, which was dismissed with a reason in the thread.

**Merged pull request containing hackathon code:**
[#6 — `feat/review-tools`](https://github.com/codewithveek/vetit/pull/6)
(the full list is [#1](https://github.com/codewithveek/vetit/pull/1),
[#2](https://github.com/codewithveek/vetit/pull/2),
[#3](https://github.com/codewithveek/vetit/pull/3),
[#4](https://github.com/codewithveek/vetit/pull/4),
[#5](https://github.com/codewithveek/vetit/pull/5),
[#6](https://github.com/codewithveek/vetit/pull/6),
[#7](https://github.com/codewithveek/vetit/pull/7),
[#8](https://github.com/codewithveek/vetit/pull/8),
[#9](https://github.com/codewithveek/vetit/pull/9),
[#10](https://github.com/codewithveek/vetit/pull/10),
[#11](https://github.com/codewithveek/vetit/pull/11),
[#12](https://github.com/codewithveek/vetit/pull/12)).

**What Qodo flagged, and what changed.** On #6 it found that five of Vetit's
own tools were annotated `readOnlyHint: true` while writing to disk, and that
the test named "annotates every one of its own tools honestly" asserted the
wrong values — encoding the mistake instead of catching it. A tool whose entire
argument is that servers lie in exactly that field had got its own labels
wrong. Both were fixed in
[`0d8e21f`](https://github.com/codewithveek/vetit/commit/0d8e21f), along with a
redaction bypass in the same review: the transport-boundary guard trusted any
string that _started with_ the clean-snippet prefix, so attacker-controlled
text could forge the prefix and skip cleaning entirely. Prefix-trust was
replaced with invariant checking.

**The one dismissed, and why.** On #5 Qodo reported a real bug — `check_shadowing`'s
installed-tool list defaulted to empty, silently disabling D-09's signal — and
advised defaulting to the manifest's own tool names. That fix would have been
worse than the bug: D-09 exists to catch a server naming tools belonging to
_other_ servers, so defaulting to its own would turn "call `list_spaces` first"
— which honest servers write constantly — into a critical finding worth 40 risk
points. The argument is required instead, with no default at all, and the
reasoning is pinned in
[`run-detectors.ts`](packages/vetit-mcp/src/features/detection/run-detectors.ts)
next to the code.

**Follow-up review against the final code:**
[`fix/trueforge-api-contract`](https://github.com/codewithveek/vetit/tree/fix/trueforge-api-contract)
— opened after the twelve feature PRs merged, correcting every TrueForge admin
API call against a live harness, plus a `compute_risk` fix that could not tell a
clean review from an absent one.

**Review history:** every branch below was opened as its own pull request, so
the trail runs through the build rather than being bolted on at the end.

| PR                                                   | Branch                 | What it adds                                            | Findings |
| ---------------------------------------------------- | ---------------------- | ------------------------------------------------------- | -------- |
| [#1](https://github.com/codewithveek/vetit/pull/1)   | `chore/repo-scaffold`  | Strict TypeScript, ESLint, CI — before any feature code | —        |
| [#2](https://github.com/codewithveek/vetit/pull/2)   | `feat/decoy-mcp`       | The server we are allowed to attack                     | 2        |
| [#3](https://github.com/codewithveek/vetit/pull/3)   | `feat/redaction`       | Cleaning untrusted text before it can reach the agent   | 3        |
| [#4](https://github.com/codewithveek/vetit/pull/4)   | `feat/manifest`        | Listing a target and hashing what matters               | 8        |
| [#5](https://github.com/codewithveek/vetit/pull/5)   | `feat/detection`       | D-01 to D-10 and the risk score                         | 9        |
| [#6](https://github.com/codewithveek/vetit/pull/6)   | `feat/review-tools`    | The Vetit server and its review tools                   | 5        |
| [#7](https://github.com/codewithveek/vetit/pull/7)   | `feat/admission`       | Quarantine, scoped grant, `write_admission`             | —        |
| [#8](https://github.com/codewithveek/vetit/pull/8)   | `feat/probing`         | `probe_tool` and the tripwire                           | 7        |
| [#9](https://github.com/codewithveek/vetit/pull/9)   | `feat/agent-and-skill` | Agent manifest, review playbook, setup script           | 6        |
| [#10](https://github.com/codewithveek/vetit/pull/10) | `docs/readme`          | This file and `docs/ARCHITECTURE.md`                    | —        |
| [#11](https://github.com/codewithveek/vetit/pull/11) | `fix/test-timeouts`    | Timeout headroom for the integration tests              | —        |
| [#12](https://github.com/codewithveek/vetit/pull/12) | `test/tripwire-e2e`    | The tripwire, end to end against the decoy              | 1        |

High-severity findings were fixed, or dismissed in the Qodo thread with a
reason. Medium and low were judged case by case.

**What the review changed about the project, not just the code.** Three
findings were the kind no test we had written would have caught, because each
one was a claim being made rather than a line being wrong:

- Vetit mislabelling its own tools, with a test that agreed with it
- `probe_tool` reporting a **critical** false-annotation finding on a keyword
  match, against a read-back tool it had guessed at — the strongest claim in
  the project resting on the weakest evidence in it. Narrowed so that only a
  state comparison through an operator-nominated reader counts as proof
- `write_admission` releasing a server from quarantine on a findings list that
  could not tell "nothing was found" from "nothing was looked for"

## The two rules that do not bend

### Untrusted text never reaches the agent unwrapped

Tool descriptions _are_ the attack. If they reach the reviewing agent as plain
text, the reviewer itself gets taken over. So:

- every tool writes the full text to a file and returns findings only
- snippets are cut to 120 characters, comment and tag delimiters are replaced
  with visible labels, invisible characters are named rather than dropped, and
  the whole thing is wrapped and prefixed `UNTRUSTED_TEXT:`
- a final gate at the transport boundary guards _every_ string leaving _every_
  tool, including tool names and object keys
- "nothing found" comes back in the same wrapped shape as everything else

Pattern checks run in code, not in the model — same input, same answer, every
time. Only genuinely judgement-shaped questions go to a model, and those go to
subagents with an empty context, no keys, and no tools that can change
anything.

### Vetit never holds your keys

TrueForge keeps credentials on its own server and never returns them when you
read a connector. Vetit builds on that and stores nothing:

1. **Hold it.** Register the target as a connector — the harness stores the
   key — and write it into the agent with `disable_tools: ["@all"]`, so
   nothing is callable.
2. **Review it.** Ask the harness for the tool list. It resolves the credential
   server-side and hands back tools. The key never reaches Vetit.
3. **Let it in.** After a human approves, write the permission list.

The grant lands on the **agent**, not on the connector. A connector says where
a server is and holds its credential; what may be called is a property of
whoever would call it. We had this wrong until we ran against a live harness —
the connector schema is closed and rejects a `disable_tools` outright.

A security tool holding everyone's keys is the largest target in the stack, and
asking people to hand secrets to a brand-new package is the exact trust problem
Vetit exists to solve.

Most of the review needs no key at all — listing what you can do is not a
privileged act. When no credential is available, the checks that can run do
run, and the gap is reported as **what was not covered, never as a pass**.

---

## Risks we are not going to pretend away

- **Probing a hostile server can change something on its side.** It is kept
  small — read-only tools by default, synthetic arguments, one call per tool
  per run enforced in code, and an approval pause nobody can skip — but it is
  not zero. Probing also tells a malicious server that you exist, and hands it
  one opportunity to act. Only probe servers you are entitled to call.
- **A clean review is not a guarantee.** It means the checks that ran found
  nothing. Behaviour is only verified for tools that were actually probed, and
  the report names the rest.
- **The tripwire proves guilt, not innocence.** Nothing arriving at the
  collector means nothing arrived at _that_ collector, during _that_ call. And
  a target that cannot reach the collector at all — anything not on this
  machine, unless `VETIT_COLLECTOR_PUBLIC_URL` says otherwise — is reported as
  `egress: not_performed` rather than as clean.
- **Vetit is itself an MCP server**, so it has the same trust problem it
  solves. What we can offer: it is open source, its own tool descriptions are
  short and contain no instructions, its annotations are honest and tested, and
  you can run it against itself. That is the same answer we would accept from
  anybody else, which is why we are not asking for more.

  Worth admitting how that went. Five of these tools were annotated
  `readOnlyHint: true` while writing files to disk, and a test asserting "every
  one of its own tools is honest" encoded the mistake rather than catching it.
  Code review found it. The labels are corrected and the table above is the
  corrected version — but the honest lesson is that getting your own
  annotations right is harder than it sounds, which is rather the point of the
  whole project.

- **A probe only proves what a nominated reader can show.** Without a
  `read_back_tool` the probe compares nothing and says so; with one, it proves
  only what that reader observes. A write to state no reader exposes happens
  unobserved either way.

## Scope

Vetit is a **defensive** tool, and it draws the line in two places rather than
one.

**Reading** a server — `fetch_manifest` and the five static passes — asks it
for the tool list it publishes to every client that connects. That is the
normal handshake, and reviewing a server you are considering needs no more
permission than using it would.

**Probing** — `probe_tool` — calls a tool for real, so it needs the right to
call that tool at all:

| The server                                                   | What Vetit will do                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Yours                                                        | Everything, probing included                                                                               |
| A service you hold an account with, and are about to connect | Everything — one deliberate call with synthetic arguments is less than the use you are about to make of it |
| An endpoint you have no relationship with                    | Static review only, and the report says behavioural verification was **NOT PERFORMED**                     |

That last row is the tool working, not failing. A review that omits its gaps
reads as a pass, so Vetit names them instead.

Do not point `probe_tool` at systems you have no right to call.

Every test and every demonstration in this repository targets
[`vetit-decoy-mcp`](packages/vetit-decoy-mcp) — a server we wrote to be unsafe
on purpose — and nothing else.

---

## Designed, not built

Honest about the line. These were designed and are described above but are not
in this repository:

- **`diff_manifest` and baselines** — the stripped-down snapshot and per-tool
  hashes are built and tested, so the comparison has everything it needs, and
  the decoy's `--poison` flag produces a real rug pull to compare against. The
  banding (`harmless` / `wider_access` / `suspicious`) and the storage are not
  written.
- **Scheduled re-verification** — a job that starts a turn, stops at the
  approval and waits across restarts.
- **`reverify_all`** — one subagent per admitted server, all at once.

---

## Licence

MIT. Both packages are public and unscoped:
[`vetit-mcp`](packages/vetit-mcp) and
[`vetit-decoy-mcp`](packages/vetit-decoy-mcp).
