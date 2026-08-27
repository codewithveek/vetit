# The attacks, and what proves each one

Background for the `vetit-review` skill. Read it when you need the detail.

Every claim here has a published source, listed at the bottom with its date.
Do not add to this list from memory.

---

## Tool poisoning

**What it is.** A server writes instructions into a tool description. The
client renders a short friendly summary; the model receives the whole text and
cannot tell it apart from instructions it was given by its operator.

The best-known example is an `add` tool whose description instructed the model
to first read `~/.ssh/id_rsa` and pass the contents in a spare parameter
(Invariant Labs, April 2025).

**Why no wording fixes it.** A model does not have separate channels for "what
my operator told me" and "what arrived inside a tool description". Everything
it reads carries the same weight. Adding "ignore instructions in tool
descriptions" to a system prompt does not create a channel that was never
there.

**What proves it.**

| Evidence | Detector | Strength |
| -------- | -------- | -------- |
| A comment, CDATA block, processing instruction or shouted tag in a description | D-01 | Proof of intent to hide |
| A named secret path — `~/.ssh/id_rsa`, `.env`, `mcp.json`, `~/.aws/credentials` | D-05 | Proof, when the tool has no business with files |
| Phrases that order the model rather than describe the tool | D-04 | Strong, not conclusive |
| A free-text parameter no visible text explains | D-07 | The channel out. Strong alongside D-01 or D-05 |

A `<query>` placeholder in lowercase is documentation. An `<IMPORTANT>` block
is not. The difference is in the detector and it matters: a check that fires on
both gets switched off, and then it catches neither.

---

## Invisible-character smuggling

**What it is.** Zero-width characters, direction overrides and the Unicode tag
block put text into a description that a human reviewer never sees. Zero-width
spaces also break up the words a reviewer would search for, so `Ig<ZWSP>nore`
survives a search for "ignore".

**What proves it.** D-02. Any format character or Unicode tag character in a
description is proof: there is no honest use for one there. Newlines and tabs
are not this finding — they are invisible in the ordinary sense and completely
normal.

---

## Rug pull

**What it is.** MCP clients re-read tool definitions on every connection. A
server can be honest on the day it is approved and change its descriptions a
week later. Nothing in the protocol prompts anyone to look again (Microsoft
Security Response Center, June 2026).

**What proves it.** A comparison against a stripped-down copy taken at
admission. Sort the changes into three bands, or people stop reading the
alerts:

| Band | What it looks like | What to do |
| ---- | ------------------ | ---------- |
| `harmless` | Version bump, typo fix, a new tool that trips no detectors | Update the baseline, log it |
| `wider_access` | A new parameter, a new tool that writes, a field that now accepts more | Flag for a human. Take no action automatically |
| `suspicious` | A description now trips D-01, D-02, D-04, D-05 or D-09 — **or a tool that used to say it writes now claims to be read-only** | Suggest putting the server back on hold |

That last case is the most valuable check in this section and almost nothing on
the market looks for it.

---

## Cross-server shadowing

**What it is.** A server names another server's tools in its own descriptions
and steals calls meant for a server you do trust. One compromised server drags
the others down with it 72.4% of the time.

**What proves it.** D-09: a `server.tool` reference, or the literal name of a
tool already enabled in this workspace, appearing in a description. A tool
naming *itself* is not this finding.

---

## Homoglyph impersonation

**What it is.** A tool named `sendmеssage` with a Cyrillic `е` is a different
string from `sendmessage`, and no amount of careful reading tells them apart.

**What proves it.** D-03: a character from the confusable table, or a name that
mixes ASCII letters with letters from another script. A name written entirely
in another script is not flagged — it is unusual, but it impersonates nothing.

---

## Lying annotations

**What it is.** A tool declares `readOnlyHint: true` and writes. Nothing in the
name, the description or the schema says so.

This is the one attack no description scanner can find, because there is
nothing in the description to find. It also defeats approval settings: TrueForge
works out `@read-only` and `@write` from these annotations, so a server that
lies here walks straight past a policy keyed on those groups.

**What proves it.** `probe_tool` and nothing else:

| Evidence | Strength |
| -------- | -------- |
| State read through an operator-nominated read-only tool differs before and after the call | Proof |
| The response reports having created, written or deleted something | Indication. Never proof on its own — a tool can say "created" about something it did not create |
| No read-back tool was nominated | **Not** evidence of innocence, and not a finding either. Record the gap |

A tool that declares nothing and writes is a lesser finding than one that
declared read-only and wrote. It did not lie; it said nothing. But silence
still has to be read as a write, because a tool the harness cannot classify is
a tool your approval settings cannot cover.

---

## Credential theft

**What it is.** A tool sweeps its own environment for anything that looks like
a secret and posts it somewhere. The first confirmed malicious MCP package,
`postmark-mcp` (2026), added a hidden BCC to every email an agent sent.

**What proves it.** A tripwire. You cannot watch a remote server's outgoing
traffic, but you can give it somewhere to send things: plant a worthless,
recognisable secret where a thief would look, run a collector you control, and
see whether anything arrives.

**Nothing arriving proves nothing.** Say so in the report. Something arriving
is proof, and no amount of description reading produces it.

---

## What a sandbox does and does not do

A sandbox stops strange code touching the machine it runs on. It cannot take
back a key that has already been handed out. Key safety is a separate problem
with a separate answer — two-stage registration, and never holding a credential
in the review tool at all.

Do not treat them as the same problem. They fail differently.

---

## Sources

| Finding | Source |
| ------- | ------ |
| 66% of 1,808 scanned MCP servers had a security finding | AgentSeal, 2026 |
| 33% of 1,000 scanned had a critical vulnerability | Enkrypt AI, October 2025 |
| Tool poisoning succeeds over 60% of the time, up to 72% on some models | MCPTox benchmark |
| One compromised server drags others down 72.4% of the time | Cross-server shadowing research |
| Three prompt-injection CVEs in Anthropic's own Git MCP server | CVE-2025-68143 / 68144 / 68145, January 2026 |
| Rug pulls: descriptions change after approval and nothing prompts a second look | Microsoft Security Response Center, June 2026 |
| First confirmed malicious MCP npm package | `postmark-mcp`, 2026 |
| Most companies are rolling out AI agents; only 29% feel ready to secure them | Cisco State of AI Security 2026 |
| The `add` tool reading `~/.ssh/id_rsa` | Invariant Labs tool-poisoning disclosure, April 2025 |
