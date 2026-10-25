<div align="center">
  <h1>@cyanheads/us-lobbying-mcp-server</h1>
  <p><b>Search US lobbying disclosures and foreign-agent registrations via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools (+1 opt-in)</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/us-lobbying-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/us-lobbying-mcp-server) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/us-lobbying-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/us-lobbying-mcp-server/releases/latest/download/us-lobbying-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=us-lobbying-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXMtbG9iYnlpbmctbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22us-lobbying-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fus-lobbying-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

US federal lobbying disclosures from the Senate's LDA API and foreign-agent registrations from the Department of Justice's FARA records. Search filings, resolve client relationships, inspect lobbyist and contribution disclosures, and analyze reported amounts with optional local SQL. No API key required.

### Tools

| Tool | Description |
|:---|:---|
| `uslobbying_search_filings` | Search registrations and activity reports, retaining original and amended filings |
| `uslobbying_get_client_profile` | Resolve client relationships, then analyze explicitly selected IDs and years |
| `uslobbying_get_issue_spending` | Analyze reported amounts on quarterly filings mentioning an issue |
| `uslobbying_search_lobbyists` | Find lobbyists and retrieve filing-specific activity and covered-position evidence |
| `uslobbying_get_contributions` | Retrieve LD-203 reports with complete contribution lists, PAC disclosures, and certifications |
| `uslobbying_search_foreign_agents` | Search FARA snapshots or retrieve a registration's chosen live detail collection |
| `uslobbying_list_reference` | Look up official codes, identifiers, methodology, and source limitations |
| `uslobbying_dataframe_query` | Materialize a read-only SQL result and page its complete rows |
| `uslobbying_dataframe_describe` | Inspect staged table schemas, counts, lifecycle, and provenance |
| `uslobbying_dataframe_drop` | Remove a staged table; opt-in |

## Capability reference

### `uslobbying_search_filings` <sub>tool</sub>

- Supply at least one upstream filter: `filing_year` (1999–current UTC year), `client_id`, `registrant_id`, `lobbyist_id`, `client_name`, `registrant_name`, `filing_type`, `filing_period`, or `specific_issues`. Optional `issue_code` is applied locally and cannot narrow upstream requests.
- Returns complete `filings` with `amendment_policy: "all_versions"`, separate nullable USD decimal-string `income` / `expenses`, document links, and nested disclosures. Shared acquisition and record-window rules appear under Features.

---

### `uslobbying_get_client_profile` <sub>tool</sub>

- `mode: "resolve"` (default) requires `client_name`; `mode: "profile"` requires explicit `client_ids` and `years` (1999–current UTC year). IDs identify relationships with registrants; candidates are never automatically merged into a corporate identity.
- Profile returns `status: "collecting"` until acquisition completes, then typed `annual_ledgers`, `selections`, `firms`, `issue_codes`, `targeted_entities`, `selected_filings`, `activities`, and `raw_filings` across output windows. `row_set_totals` / `row_set_offsets` describe each list's delivery.
- With `CANVAS_PROVIDER_TYPE=duckdb`, completed analysis also returns a `dataset` containing all acquired filings, selected filings, and selected activities. Optional `canvas_id` reuses an existing canvas; an expired token fails `canvas_not_found`.

---

### `uslobbying_get_issue_spending` <sub>tool</sub>

- Requires `issue_code` and explicit `years`; optional `client_id` / `registrant_id` narrow upstream acquisition. All versions are acquired before latest-period selection and local issue filtering; broad scans can take hours.
- Returns the same collecting/final analytical lists and optional dataset as profile mode, with `attribution_basis: "whole_filing_mentions_issue"`. Whole-filing amounts overlap across issue buckets and are not allocated issue spending.

---

### `uslobbying_search_lobbyists` <sub>tool</sub>

- `mode: "search"` (default) requires `name`, `registrant_name`, or `registrant_id`; `mode: "activity"` requires `lobbyist_id` and `filing_year`, with optional `client_id` and `covered_positions_only`.
- Returns identity `lobbyists` or filing-scoped `evidence`, including the matching participant, complete activity, original indexes, and filing UUID/document. Covered positions are disclosed text, not verified current employment.

---

### `uslobbying_get_contributions` <sub>tool</sub>

- Requires `filing_year` (2008–current UTC year); optional `filing_period` (`mid_year` / `year_end`), registrant/lobbyist selectors, `contribution_type`, `contributor`, `payee`, `honoree`, and inclusive `contribution_date_after` / `contribution_date_before`.
- Returns full parent `reports`, complete `contribution_items`, and `matched_item_indexes` where every child predicate matched the same item. Originals and amendments remain separate; `report_count_in_batch` and `item_count_in_batch` are not donation totals.

---

### `uslobbying_search_foreign_agents` <sub>tool</sub>

- `mode: "search"` (default) searches daily XML snapshots; choose `entity: "registrants"` (default) or `"foreign_principals"`, optional literal token-AND `name_contains`, and exact `country` labels for principals only. `status` is `active` (default), `terminated`, or `all`; principal status is independent of registrant status.
- `mode: "detail"` requires a digit-string `registration_number` and retrieves only the chosen live collection: `foreign_principals` (default), `short_forms`, or `documents`. Documents require `status: "all"` (the effective default for documents); an empty collection does not prove a registration never existed.
- `page_size` 1–25 (default 25) controls local windows over pinned results; follow `next_cursor`. Responses retain source fields, official links, and snapshot retrieval metadata where applicable.

---

### `uslobbying_list_reference` <sub>tool</sub>

- Start with `topic`: `issue_codes`, `filing_types`, `government_entities`, `contribution_types`, `countries`, `identifiers`, `methodology`, or `fara_rules`; optional `filter` applies literal case-insensitive token-AND matching.
- Returns attributed `entries`, `total_entries`, and `matched_entries`; follow `next_cursor` for pinned windows of up to 125 entries, or `record_handles` for oversized entries. Countries retain separately attributed LDA codes and FARA labels, without a guessed ISO mapping.

---

### `uslobbying_dataframe_query` <sub>tool</sub>

- Requires `canvas_id` and either one read-only SELECT in `sql` (optional fresh `register_as`) or a stored `result_table` with optional `offset`. `row_limit` 1–100 defaults to 25 and may be lowered by framework configuration or the response byte budget.
- New SQL materializes the complete result. Continue with `result_table` / `next_offset`; `row_count` is exact and `row_order: "canonical_values"` describes delivery ordering. Writes, multiple statements, external reads, and prohibited plan operators fail with typed reasons.
- A row that cannot fit fails `query_row_too_large` while retaining the materialization: select fewer columns or explicit `SUBSTR` windows. Missing/expired tables fail `missing_table`; SQL is unavailable without an enabled canvas.

---

### `uslobbying_dataframe_describe` <sub>tool</sub>

- Requires a returned `canvas_id`; optional `table_name` selects one table. Inspect authoritative columns and types before SQL.
- Returns exact row counts, grain, creation/expiry, source tool, acquisition provenance, and materializing SQL where applicable. It does not enumerate other canvases.

---

### `uslobbying_dataframe_drop` <sub>tool</sub>

- Requires `canvas_id` and `table_name`; idempotent, returning `dropped: false` for an absent table.
- Off unless `USLOBBYING_DATAFRAME_DROP_ENABLED=true`; when disabled it is absent from `tools/list`. This deletes local staged data only.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

LDA/FARA-specific:

- Shared source pacing: anonymous LDA access uses 15 requests/minute per originating IP; an optional registered token uses 120/minute. FARA requests start at least 4.1 seconds apart; separate processes must coordinate shared upstream budgets.
- Analytical selection uses the latest posting within each registrant/client/year/quarter. Equal-latest candidates are marked ambiguous and excluded from sums; this is an analytical rule, not a verified legal amendment lineage.
- Income and expenses remain separate, missing amounts remain unknown, and expense methods retain separate ledgers. Disclosure records establish neither wrongdoing nor policy outcomes or influence.
- FARA search uses complete official daily XML snapshots cached for 24 hours; chosen registration details use the live API. LDA pagination is live and does not promise an immutable historical snapshot.

Agent-friendly output:

- Explicit completion: LDA `page_size` is 1–25 (default 25); `max_pages` is 1–5 (default one for discovery, five for analytics). Follow `next_cursor` until acquisition `coverage.complete`, then continue final windows until `output_complete`; `record_handles` can still require retrieval. Filters may be omitted or repeated unchanged on continuation.
- Complete record retrieval: responses target 24,000 UTF-8 bytes across both surfaces. Oversized parents stay reachable through the same tool with `record_handle`, JSON Pointer `record_path`, and `record_offset` / `record_limit` (1–25 object entries or array items, default 25). String windows use byte-bounded fragments and Unicode-code-point offsets; follow child paths and `next_offset` to reconstruct values.
- Recoverable progress: continuations and retained parents expire 24 hours after acquisition starts. The immediately preceding cursor replays its response; older or expired cursors fail `cursor_invalid`. In-memory restarts lose progress; explicit filesystem storage retains public records/checkpoints until expiry. Broad scans can exhaust the default 128 MiB acquisition budget or exceed the lifetime; narrow year/client/registrant scopes deliberately.
- Matching response surfaces: `structuredContent` and JSON text in `content[]` carry the same fields, with clickable source links. Optional analytical `dataset` responses name exact tables and route to describe/query tools; SQL never substitutes for complete inline analytical delivery.

## Getting started

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "us-lobbying-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/us-lobbying-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio" }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "us-lobbying-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/us-lobbying-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio" }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "us-lobbying-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/us-lobbying-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Anonymous access needs no account or key. Optional registered LDA tokens can be configured as `USLOBBYING_LDA_API_KEY`.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/us-lobbying-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd us-lobbying-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env for optional overrides
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `USLOBBYING_LDA_API_KEY` | Optional registered LDA token for the authenticated request allowance. | — |
| `USLOBBYING_DATAFRAME_DROP_ENABLED` | Expose `uslobbying_dataframe_drop`, which removes local staged tables. | `false` |
| `CANVAS_PROVIDER_TYPE` | `none` or `duckdb`; npm/Docker installs can enable local SQL. MCPB fixes this to `none` and keeps complete inline delivery. | `none` |
| `STORAGE_PROVIDER_TYPE` | Acquisition checkpoint storage; `filesystem` opts into durable public-record retention. | `in-memory` |
| `STORAGE_FILESYSTEM_PATH` | Explicit writable directory when selecting filesystem storage. Checkpoints expire 24 hours after acquisition starts. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address; Docker defaults to `0.0.0.0`. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments/results, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). Free-form secrets are not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP base URL for traces and metrics. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log export endpoint. | — |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run the production version:**

  ```sh
  bun run rebuild
  bun run start:http   # or start:stdio
  ```

- **Run checks and tests:**
  ```sh
  bun run devcheck     # Lints, formats, type-checks
  bun run test         # Runs test suite
  ```

### Docker

```sh
docker build -t us-lobbying-mcp-server .
docker run -p 3010:3010 us-lobbying-mcp-server
```

The image defaults to HTTP on port 3010. Enable SQL with `-e CANVAS_PROVIDER_TYPE=duckdb`; use one server process per storage/upstream budget because acquisition locks and pacing are process-local.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point, direct tool registration, service/canvas lifecycle. |
| `src/config` | Server environment validation and shared tool deadlines. |
| `src/domain` | Validated disclosure records, provenance, delivery contracts, and lossless formatting. |
| `src/mcp-server/tools/definitions` | LDA, FARA, reference, and dataframe tools. |
| `src/services/lda` | Fixed-host LDA client with shared pacing and validated pagination. |
| `src/services/fara` | Daily XML snapshots and live per-registration detail collections. |
| `src/services/acquisition` | Resumable acquisition, replay, storage admission, and retained-record windows. |
| `src/services/lobbying` | Quarterly version selection, exact accounting, and filing-specific evidence. |
| `src/services/canvas` | Complete analytical table staging and stable SQL result delivery. |
| `scripts` | Build, devcheck, packaging, and release tooling. |
| `tests` | Unit and integration tests mirroring the source structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) and [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register tools directly in the `createApp()` array in `src/index.ts`
- Validate complete upstream records, preserve sparse and unknown fields, and keep income, expenses, relationship IDs, and acquisition/output completion distinct

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
