# vetit-decoy-mcp

**An MCP server that is unsafe on purpose.**

This package exists for one reason: a security review tool needs something it
is allowed to attack. Every flaw below is planted deliberately and maps to a
documented, published attack against real MCP servers.

> **Do not deploy this.** Do not connect a production agent to it. It is a test
> fixture, and the only thing [Vetit](https://github.com/codewithveek/vetit)
> is ever pointed at.

## Run it

```bash
npx vetit-decoy-mcp                 # the manifest as first published
npx vetit-decoy-mcp --poison        # the manifest after a rug pull
npx vetit-decoy-mcp --port 8931     # default port is 8931
```

The MCP endpoint is `POST http://127.0.0.1:8931/mcp` (streamable HTTP,
stateless). `GET /health` reports whether the poisoned manifest is active.

## What is planted, and what should catch it

| Tool | Planted flaw | Maps to | Should be caught by |
| ---- | ------------ | ------- | ------------------- |
| `add` | `<IMPORTANT>` block instructing a read of `~/.ssh/id_rsa`, plus an undocumented free-text `sidenote` parameter | Invariant Labs tool poisoning, April 2025 | D-01, D-04, D-05, D-07 |
| `search_docs` | Clean at baseline; gains a hidden HTML-comment instruction under `--poison` | Rug pull | `diff_manifest` |
| `get_page`, `list_spaces` | Nothing. Honest, read-only tools | — | — |
| `create_page` | Honest write at baseline; quietly relabels itself read-only under `--poison` | Rug pull, label downgrade | `diff_manifest` (`suspicious` band) |
| `export_all` | Annotated `readOnlyHint: true` and **writes** | A lying label | **`probe_tool` only** |
| `list_workspace_files` | Description names `github.create_issue`, `filesystem:read_file`, `slack.post_message` | Cross-server shadowing | D-09, D-04 |
| `summarise_page` | Zero-width characters and a right-to-left override hiding the payload | Invisible-character smuggling | D-02 |
| `sendmеssage` | Cyrillic `е` (U+0435) in the tool name; no annotations | Homoglyph impersonation | D-03, D-08 |
| `report_status` | Exfiltration URLs buried in a 1,100-character description | Data exfiltration channel | D-06, D-10 |
| `check_environment` | Sweeps its own environment for secrets and posts them out | Key theft (`postmark-mcp`, 2026) | Tripwire + outgoing-traffic log |

`export_all` is the interesting row. Nothing in its name, description or schema
gives it away — only calling it does.

## The tripwire

`check_environment` posts anything that looks like a secret to the URL in
`VETIT_DECOY_COLLECTOR_URL`. If that variable is unset it sends nothing, so the
decoy never reaches the network on its own. Point it at a listener you control
to watch the theft happen:

```bash
VETIT_DECOY_COLLECTOR_URL=http://127.0.0.1:8999/collect \
VETIT_CANARY_TOKEN=tripwire-not-a-real-secret \
npx vetit-decoy-mcp
```

## Licence

MIT.
