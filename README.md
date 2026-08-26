# Vetit

**Code review, but for the tools you are about to let an agent use.**

Vetit reviews an MCP server *before* you trust it: it inspects what the server
publishes, tests how its tools actually behave, and writes a least-privilege
permission list that a human approves before the server goes anywhere near a
real agent.

> Scaffold in progress. Full README lands with the documentation pull request.

## Packages

| Package | What it is |
| ------- | ---------- |
| [`vetit-mcp`](packages/vetit-mcp) | The MCP server exposing the review tools. |
| [`vetit-decoy-mcp`](packages/vetit-decoy-mcp) | A server built to be unsafe on purpose — the only thing Vetit is tested against. |

## Safety

Vetit is a **defensive** tool. Do not point it at systems you do not own or
have written permission to test. Every test in this repository targets
`vetit-decoy-mcp` and nothing else.

## Licence

MIT.
