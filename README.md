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

| Finding | Source |
| ------- | ------ |
| 66% of 1,808 scanned MCP servers had a security finding | AgentSeal, 2026 |
| 33% of 1,000 scanned had a critical vulnerability | Enkrypt AI, October 2025 |
| Tool poisoning succeeds over 60% of the time, up to 72% on some models | MCPTox benchmark |
| One compromised server drags others down with it 72.4% of the time | Cross-server shadowing research |
| Three prompt-injection CVEs in Anthropic's own Git MCP server | CVE-2025-68143 / 68144 / 68145, January 2026 |
| Rug pulls: descriptions change after approval, nothing prompts a second look | Microsoft Security Response Center, June 2026 |
| First confirmed malicious MCP npm package — a hidden BCC on every agent-sent email | `postmark-mcp`, 2026 |
| Most companies are rolling out AI agents; only 29% feel ready to secure them | Cisco State of AI Security 2026 |

## What already exists, and where Vetit differs

| Tool | Does | Does not |
| ---- | ---- | -------- |
| mcp-scan (Invariant Labs) | Reads descriptions, pins tools it has approved | Never calls a tool. No approval step |
| MCPScan.ai | Hosted description scanning, watches repos | Reads descriptions only |
| mcp-fortress | Flags risky npm packages and dependencies | Checks the package, not what the tool does when run |
| McpSafetyScanner | Research tool that probes for exploits | A prototype, not something you put in a workflow |
| mcp-airlock, MCP-Gateway, ToolHive | Allow, block and log calls as they happen | Assume you already decided to trust the server |

Every one of them answers the same question: *what does this server's
description say?*

**Vetit answers a different one: what does this server actually do, and what
access should it get?**

### What Vetit is not

- **Not a middleman.** Calls do not pass through it. Vetit works *before* you
  trust a server, not *while* you use it. Sitting in the live call path is
  already done well by `mcp-airlock`, MCP-Gateway and ToolHive. Staying out of
  it is a choice.
- **Not another description scanner.** See the table above.
- **Not an attack tool.** It reviews servers you own, or ones you have written
  permission to check.

---

## The finding nothing else can produce

The decoy ships a tool called `export_all`. Its name is unremarkable. Its
description is honest. Its schema is clean. It is annotated
`readOnlyHint: true`.

All ten detectors pass it. There is a test asserting exactly that emptiness:

```ts
it('says nothing at all about export_all', () => {
  expect(detectorsFor('export_all')).toEqual([]);
});
```

Then you call it:

```
observed.wrote:  true
observed.how:    state visible through a read-only tool changed across the call
finding P-01:    critical — annotated readOnlyHint: true and observed to write.
                 The label is false, and no amount of reading the manifest
                 would have shown it.
```

That gap between the two tests is the argument for behaviour testing, written
as something that runs rather than something claimed.

---

## Try it

Requires **Node 22.5 or later**.

```bash
git clone https://github.com/codewithveek/vetit
cd vetit
npm install
npm test            # 241 tests, including end-to-end against the decoy
./scripts/setup.sh  # builds, starts both servers, creates the agent
```

`setup.sh` degrades cleanly if you have no TrueForge instance running — the
servers still start and the tests still pass.

Then ask the agent:

> review the MCP server at http://127.0.0.1:8931/mcp

Or drive the tools directly:

```bash
npx vetit-mcp                       # the review server, port 8930
npx vetit-decoy-mcp                 # the target, port 8931
npx vetit-decoy-mcp --poison        # the same target after a rug pull
```

### The tools

| Tool | Label | What it does |
| ---- | ----- | ------------ |
| `fetch_manifest` | read | Lists everything a target offers, writes it to disk, returns counts and hashes only |
| `scan_descriptions` | read | Runs the description and name detectors (D-01…D-06, D-10) |
| `analyze_schemas` | read | Finds free-text parameters built for moving data out (D-07) |
| `check_annotations` | read | Reports what each tool declares, and treats silence as a write (D-08) |
| `check_shadowing` | read | Finds descriptions naming other servers' tools (D-09) |
| `compute_risk` | read | Adds up the stored findings. Arithmetic, no model |
| `lookup_advisories` | read | Returns searches to run with `exa`. Never an advisory it made up |
| `probe_tool` | **destructive** | Calls one tool for real and compares behaviour with claims |
| `quarantine_server` | **write** | Stage 1: register with every tool switched off |
| `write_admission` | **destructive** | Stage 3: write the permission list |

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

## The two rules that do not bend

### Untrusted text never reaches the agent unwrapped

Tool descriptions *are* the attack. If they reach the reviewing agent as plain
text, the reviewer itself gets taken over. So:

- every tool writes the full text to a file and returns findings only
- snippets are cut to 120 characters, comment and tag delimiters are replaced
  with visible labels, invisible characters are named rather than dropped, and
  the whole thing is wrapped and prefixed `UNTRUSTED_TEXT:`
- a final gate at the transport boundary guards *every* string leaving *every*
  tool, including tool names and object keys
- "nothing found" comes back in the same wrapped shape as everything else

Pattern checks run in code, not in the model — same input, same answer, every
time. Only genuinely judgement-shaped questions go to a model, and those go to
subagents with an empty context, no keys, and no tools that can change
anything.

### Vetit never holds your keys

TrueForge keeps credentials on its own server and never returns them when you
read a connector. Vetit builds on that and stores nothing:

1. **Hold it.** Register the target with `disable_tools: ["@all"]`. The harness
   stores the key; no agent can call anything.
2. **Review it.** Ask the harness for the tool list. It resolves the credential
   server-side and hands back tools. The key never reaches Vetit.
3. **Let it in.** After a human approves, write the permission list.

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
  not zero. Only point Vetit at servers you own.
- **A clean review is not a guarantee.** It means the checks that ran found
  nothing. Behaviour is only verified for tools that were actually probed, and
  the report names the rest.
- **The tripwire proves guilt, not innocence.** Nothing arriving at the
  collector means nothing arrived at *that* collector, during *that* call.
- **Vetit is itself an MCP server**, so it has the same trust problem it
  solves. What we can offer: it is open source, its own tool descriptions are
  short and contain no instructions, its annotations are honest and tested, and
  you can run it against itself. That is the same answer we would accept from
  anybody else, which is why we are not asking for more.
- **A read-back needs a read-only tool to exist.** Where a target has none, a
  write can happen unobserved. The probe says so rather than reporting a clean
  result.

## Scope

Vetit is a **defensive** tool. Do not point it at systems you do not own or
have written permission to test.

Every test and every demonstration in this repository targets
[`vetit-decoy-mcp`](packages/vetit-decoy-mcp) — a server we wrote to be unsafe
on purpose — and nothing else.

---

## Layout

```
packages/vetit-mcp/          the review server
  src/features/
    manifest/                fetch, stable snapshot, hashing
    detection/               D-01…D-10, scoring, findings store
    probing/                 probe_tool, tripwire collector, analysis
    admission/               quarantine, scoped grant, write_admission
  src/shared/
    redaction/               the only path untrusted text may take
    mcp-client/              talking to servers we do not trust
    trueforge-client/        admin API. Holds no credentials
packages/vetit-decoy-mcp/    the server we are allowed to attack
skills/vetit-review/         the playbook, loaded on demand
agent/vetit-agent.json       the agent manifest
docs/ARCHITECTURE.md         the security model, restated for readers
```

Grouped by what it does, not by what kind of code it is. Features reach each
other only through an `index.ts`, and `shared/` never reaches into a feature.

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

## AI-use disclosure

This project was built with AI coding assistance (Claude, via Claude Code). The
specification, architecture and security model were written by a human; the
implementation was produced in collaboration with the assistant, and every
commit was reviewed before it was made. The test suite, the detector precision
cases and the end-to-end runs against the decoy are the evidence that the
result works, and they are all in the repository to be run.

## Qodo Code Review Evidence

> **To complete before submission.** Qodo runs on every pull request in this
> repository. Fill in the merged-PR link and the finding summary below once the
> first review has landed.

**Merged pull request containing hackathon code:** _<link to be added once the
first PR is merged>_

**What Qodo flagged, and what changed:** _<one or two sentences: the finding,
and whether it was fixed or dismissed with a reason in the Qodo thread>_

**Review history:** every branch below was opened as its own pull request, so
the trail runs through the build rather than being bolted on at the end.

| Branch | What it adds |
| ------ | ------------ |
| `chore/repo-scaffold` | Strict TypeScript, ESLint, CI — before any feature code |
| `feat/decoy-mcp` | The server we are allowed to attack |
| `feat/redaction` | Cleaning untrusted text before it can reach the agent |
| `feat/manifest` | Listing a target and hashing what matters |
| `feat/detection` | D-01 to D-10 and the risk score |
| `feat/review-tools` | The Vetit server and its seven read tools |
| `feat/admission` | Quarantine, scoped grant, `write_admission` |
| `feat/probing` | `probe_tool` and the tripwire |
| `feat/agent-and-skill` | Agent manifest, review playbook, setup script |
| `docs/readme` | This file and `docs/ARCHITECTURE.md` |

High-severity Qodo findings are fixed, or dismissed in the Qodo thread with a
reason. Medium and low are judged case by case.

---

## Licence

MIT. Both packages are public and unscoped:
[`vetit-mcp`](packages/vetit-mcp) and
[`vetit-decoy-mcp`](packages/vetit-decoy-mcp).
