# coroner

**Read-only MCP server for Autopsy forensic cases.** It exposes an Autopsy case (`autopsy.db`) as
MCP tools to AI agents (Claude Desktop, opencode, Cline, …) and runs on **Linux, macOS and Windows**
— Autopsy itself does not need to be installed or running.

- **Runtime**: Bun (`bun:sqlite`, no heavy dependencies) | vanilla JS + JSDoc
- **Transports**: stdio (local agent) and HTTP (agent on another machine, over an SSH tunnel)
- **21 tools**: case/filesystem, blackboard artifacts, keywords, tags, timeline, OS accounts, file
  content (hex/strings/extract), investigative triage (`find_*`, `open_sqlite`, `export_evidence`)
  and forensic tools (`verify_audit_log`, `seal_audit_log`)
- **Read-only and fail-closed**: the SQLite driver rejects any write, and an unknown tool parameter
  is an **explicit error** (`additionalProperties: false`, naming the key) instead of silently
  running without the filter
- **Chain of custody**: hash-chained audit trail, signed seal (Ed25519/RSA/EC, ICP-Brasil
  certificate support) and RFC 3161 timestamps — verifiable by a third party
- **Works offline**: the case is read from local disk; the RFC 3161 timestamp is the only optional
  network call

> The repository is named `coroner` (every examination needs one). The tool itself is an
> Autopsy-oriented MCP server; the Portuguese docs in `docs/` are the project's primary docs.

## Quick start

```bash
bun install
cp .env.example .env   # point AUTOPSY_CASES_DIR at your cases folder
bun run start          # stdio — run it from your MCP client, not directly in a terminal
# or HTTP (remote agent):
bun run src/index.js --transport http --port 3123
```

On Linux/macOS use `./start.sh`; on Windows `start.bat` (or `start.bat http 3123`).

## Connect an agent

**opencode** (local): copy `opencode.json.example` to your `opencode.json` — the key is `mcp`:

```json
{
  "mcp": {
    "autopsy": {
      "type": "local",
      "command": ["bun", "run", "/absolute/path/coroner/src/index.js"],
      "environment": { "AUTOPSY_CASES_DIR": "~/AutopsyCases" },
      "enabled": true
    }
  }
}
```

**Claude Desktop** (on the machine holding the case): see `claude_desktop_config.json.example`.
**Remote agent**: point the client at `http://127.0.0.1:3123/mcp` through an SSH tunnel
(`opencode.json.example` ships an `autopsy-remote` block ready to uncomment).

## Tools

| Tool | Description |
|:--|:--|
| `list_cases` | Cases under the base folder (directories containing `autopsy.db`) |
| `set_active_case` | Selects a case (validated by opening it read-only) |
| `get_case_summary` | Metadata, data sources, counts, artifact breakdown |
| `browse_filesystem` | `tsk_files` tree (roots → dirs → files, paginated) |
| `query_blackboard_artifacts` | Blackboard artifacts by type (web history, email, EXIF, chat…) |
| `search_keywords` | Search in file names and/or artifact content |
| `get_file_metadata` | MD5/SHA-1/SHA-256 hashes, MAC times, known status |
| `browse_tags` | Analyst tags with per-type counts |
| `browse_timeline` | MAC time events in a date window |
| `get_os_accounts` | Detected OS accounts (Autopsy 4.19+) |
| `search_keyword_hits` | Keyword index hits with excerpt |
| `get_file_hex` | Hex dump of a slice of the content |
| `get_file_strings` | ASCII/UTF-8 strings from the content |
| `extract_file` | Copies content out of the case (never inside it) |

### Investigative triage

| Tool | Description |
|:--|:--|
| `find_files` | Filter by MIME, extension, hash (sha256/md5/sha1), `known`, size, path fragment and mtime window — find `msgstore.db`, `ChatStorage.sqlite`, Chromium `History`, or an IOC hash |
| `find_artifacts` | Search a term across **all** artifact attributes (messages, searches, URLs, contacts) and return the full artifact |
| `extract_conversations` | Groups chat/messages by participant with body, direction and timestamp, ordered by time |
| `open_sqlite` | Opens a SQLite database **inside the image** (WhatsApp, browser, iOS) and runs read-only SELECTs |
| `export_evidence` | Produces a citable JSON extract (hashes, MAC times, artifacts) for the report — always outside the case |

### Forensics (audit trail and seal)

| Tool | Description |
|:--|:--|
| `verify_audit_log` | Verifies the audit trail's hash chain (detects an edited, removed or reordered record) — a third party can run it |
| `seal_audit_log` | Seals the examination: SHA-256 of the log + chain check + archiving + signature + RFC 3161 timestamp, producing the seal JSON |

## File content (hex / strings / extract)

Those three tools do not read file content from `autopsy.db` (Autopsy keeps content in the images).
They resolve it through:

- `AUTOPSY_EXPORT_DIR`: a folder of files **exported** from Autopsy, indexed by SHA-256 (matched
  against `tsk_files.sha256`)
- `AUTOPSY_FILES_ROOT`: the root of a **read-only** mount of the image, resolving `parent_path + name`

With neither configured, the tools answer with a hint explaining the setup.

## Running on Linux

Autopsy is a Windows-only desktop application, but **a case is just files** — so on Linux (or macOS)
you can analyze a case without Autopsy at all:

```bash
# copy the case folder (or mount the image read-only) and point the server at it
rsync -a /mnt/evidence/Case42/ ~/cases/Case42/
AUTOPSY_CASES_DIR=~/cases bun run src/index.js
```

Nothing leaves the machine: the database is read-only, the agent talks over stdio or over an SSH
tunnel, and the only optional outbound call is the RFC 3161 timestamp.

For a persistent tunnel from a Linux agent box (equivalent to the macOS LaunchAgent in
`deploy/macos/`), a user unit is enough — template, not tested here:

```ini
# ~/.config/systemd/user/autopsy-tunnel.service
[Unit]
Description=SSH tunnel to the Autopsy MCP server
After=network-online.target

[Service]
ExecStart=/usr/bin/autossh -M 0 -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 3123:127.0.0.1:3123 win-autopsy
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now autopsy-tunnel
loginctl enable-linger "$USER"    # keep it running without an active session
```

## Chain of custody

- SQLite is opened with `readonly: true` — the driver rejects INSERT/UPDATE/DELETE/DDL
- Tests assert the **SHA-256 of `autopsy.db` is unchanged** after running every tool
- `extract_file` refuses destinations inside the case folder
- No tool accepts arbitrary SQL from the LLM — queries are predefined and parameterized
- Best practice: analyze a **copy** of the case; if Autopsy is ingesting, the database may be locked
  (the tool returns a hint and you retry)

## Forensic audit trail and seal

Enable the trail with `AUTOPSY_AUDIT_LOG` (always **outside** the case):

```bash
AUTOPSY_AUDIT_LOG=/path/outside-the-case/audit.ndjson bun run src/index.js
```

- Every tool call becomes an NDJSON record with `seq`, `ts_utc`, `session`, **active case**,
  query/args, a numeric result summary (never evidence content) and duration
- **Per-case trail**: point `AUTOPSY_AUDIT_LOG` at a **directory** and each case gets its own
  `audit-<case>-<hash8>.ndjson` (before a case is active: `audit-_session-<hash8>.ndjson`)
- Records are **hash-chained** (`prev`/`hash`): editing, removing or reordering a line breaks the
  chain and is detectable
- **Fail-closed**: if the log cannot be written, the operation fails — no log, no validity
- Third-party verification, via the `verify_audit_log` tool or the CLI:
  ```bash
  bun scripts/audit-verify.mjs /path/audit.ndjson   # exit 0 = intact
  ```

**Seal** (hash + archiving + signature + RFC 3161 timestamp):

```bash
bun scripts/audit-seal.mjs /path/audit.ndjson /path/seal.json \
    --archive /archive/audit-<date>.ndjson --key key.pem --cert chain.pem \
    --tsa https://freetsa.org/tsr
bun scripts/audit-seal.mjs --verify /path/seal.json                        # exit 0 = intact
bun scripts/tsa-verify.mjs --seal /path/seal.json --ca freetsa-cacert.pem  # validates the timestamp
```

The signature algorithm follows the key: **Ed25519, RSA or EC**. With `--cert` (a signer
certificate + chain, e.g. an **ICP-Brasil A1** e-CPF/e-CNPJ) the certificate and chain are embedded
in the seal and the key is checked against it (non-repudiation). Evidence: [how to extract the key
from a `.p12` without sending the password to the server](docs/pericia/cadeia-de-custodia.md) (pt-BR).
Verification never trusts its own code: `audit-seal.mjs --verify` runs an **external oracle**
(`openssl`) to check the signature, and `tsa-verify.mjs` checks the imprint and the timestamp chain.

## Autopsy version compatibility

The server talks to `autopsy.db`, so it works with cases from **any Autopsy 4.x**: it does not depend
on which version created the case, nor on Autopsy being installed. It is tested against **schema 9**
(including the **9.6** of the real cases we handled) and against the current schema.

It **detects what exists** rather than assuming:

| How | Where |
|:--|:--|
| Optional tables/columns are detected before use (`hasTable`, `columns`) | `src/tools.js` |
| Tags: `knownStatus` when present, else `content_tags`, else `blackboard_artifact_tags` | `browse_tags` |
| Timeline: `tsk_events` when present (typed events), falling back to `tsk_files` MAC times | `browse_timeline` |
| OS accounts (`tsk_os_accounts`, Autopsy 4.19+): without the table the tool degrades with an explanation | `get_os_accounts` |
| `get_case_summary` returns `schema_major`, `schema_minor`, `tsk_version` and warns about what the schema does not keep (case name/number/date live outside the 4.x database) | `get_case_summary` |
| A missing table becomes an explanatory hint, not a stack trace | `src/db.js` |

Regression: `tests/legacy-schema.test.js` covers these paths with a synthetic 9.6 schema.

## MCP spec conformance

Every tool advertises `additionalProperties: false` and an unknown parameter is rejected with an
error naming the key (via `strictSchema()`). In a forensic context that is not cosmetic: a typo in a
filter must not return **unfiltered results as if filtered** — the same class as
[sleuthkit/autopsy#8033](https://github.com/sleuthkit/autopsy/issues/8033). Regression:
`tests/strict-input.test.js`.

The same class of bug exists in the **official** Autopsy MCP, so we sent a conformance fix
(no features of ours): [sleuthkit/autopsy#8039](https://github.com/sleuthkit/autopsy/pull/8039) —
`tools/list` returned a bare array instead of a `ListToolsResult` object (breaking spec-validating
clients on any platform), plus the missing `additionalProperties`. The patch, the reproduction and
two red-to-green harnesses (JUnit, real; and a stdio wrapper + official-SDK client) live in
[`docs/upstream/coroner-conformance/`](docs/upstream/coroner-conformance/).

## How it compares to the official Autopsy MCP

| | **coroner** | **Official Autopsy MCP** |
|:--|:--|:--|
| Platforms | **Linux, macOS, Windows** | **Windows only** — the 4.23.0 release notes say *"MCP over STDIO Server (Windows only)"* |
| Needs Autopsy | **No** — reads `autopsy.db` directly | **Yes** — requires Autopsy running with a case open (the auth token only exists then) |
| Tools | 21 (incl. content, triage, audit/seal) | 18 |
| Audit trail / seal | **Yes** (hash chain, signed seal, RFC 3161, third-party verification) | No |
| Introduced | — | Autopsy **4.23.0**, released **2026-04-15** |

Linux support for the official MCP is requested in
[sleuthkit/autopsy#8032](https://github.com/sleuthkit/autopsy/issues/8032). A comparison with other
Autopsy/DFIR MCP servers, with sources, is in
[`docs/benchmark-mcps-autopsy.md`](docs/benchmark-mcps-autopsy.md) (pt-BR).

## Development

```bash
bun test                # 120 tests: tools, readonly, chain of custody, MCP protocol, audit/seal, strict input
bun run test:coverage   # same, with coverage
bun run lint            # biome
bun run typecheck       # JSDoc via tsc
```

Architecture: `src/db.js` (readonly + hints) → `src/tools.js` (pure functions) → `src/server.js`
(the MCP layer). See `AGENTS.md`.

## License

GPL-3.0-or-later — see [`LICENSE`](LICENSE). Copyright (C) 2026 Gutem.
