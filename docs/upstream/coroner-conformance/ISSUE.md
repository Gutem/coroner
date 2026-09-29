# MCP: `tools/list` returns a bare array instead of `ListToolsResult` — spec-validating clients cannot list tools

**Component**: Autopsy MCP server (`Core/src/org/sleuthkit/autopsy/mcp`), Autopsy 4.23.1, Windows
**Server version**: `serverInfo.version = 1.0.0` (as reported by `initialize`)

## Summary

`tools/list` responds with `"result": [ ... ]` — a bare array. The MCP schema defines
`ListToolsResult` as an **object** with a `tools` array. Any client that validates responses against
the spec (including the official MCP SDK) fails with a schema error, so the HTTP bridge cannot be
used directly by such clients.

Claude Desktop is unaffected for a different reason than it first looks: the bundled Node wrapper
(`Tools/autopsy-mcp-stdio/autopsy-mcp-stdio.js`) rebuilds the envelope itself — it reads the Java
result as an array and returns `{ tools }`. The Java side and the wrapper therefore have to change
together. Wrapping only in Java nests the object again (`{"tools":{"tools":[…]}}`), which is still
not a `ListToolsResult`: a validating client rejects it, and the wrapper's own `--test` self-test
fails as well, because it also reads the result as an array.

## Reproduction

The server is up and a case is open (the bridge endpoint and port come from
`%LOCALAPPDATA%\autopsy\mcp\mcp-config.properties`; here `port=8743`).

```bash
TOKEN=$(cat "$LOCALAPPDATA/autopsy/mcp/mcp-token")   # or read the file on Windows
curl -sS -X POST http://127.0.0.1:8743/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Actual (truncated):

```json
{"jsonrpc":"2.0","id":2,"result":[{"name":"get_server_status","inputSchema":{"type":"object","properties":{}},"description":"…"}, …]}
```

Expected:

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_server_status", …}, …]}}
```

### Same failure through the official SDK (protocol 2025-11-25)

```js
const t = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8743/mcp'), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
})
const c = new Client({ name: 'probe', version: '1.0.0' })
await c.connect(t)          // OK — initialize accepted
await c.listTools()         // throws ZodError: Invalid input
```

The validation error points at `result`:

```
invalid_union → [ { expected: 'object', code: 'invalid_type', path: ['result'],
                    message: 'Invalid input: expected object, received array' } ]
```

## Spec reference

`ListToolsResult` is an object in **every** published revision — this is not a version mismatch:

```ts
// 2024-11-05, 2025-06-18 and 2025-11-25 — schema.ts, identical
export interface ListToolsResult extends PaginatedResult {
  tools: Tool[];
}
```

The SDK implements exactly that (`PaginatedResultSchema.extend({ tools: z.array(ToolSchema) })`), and
its client reads `result.tools`.

## Impact

Any spec-validating MCP client — the official SDK included — cannot enumerate the tools, so the HTTP
bridge is unusable from them. In the default Claude Desktop setup the wrapper hides it by rebuilding
the envelope itself, which is also why the fix has to touch both sides.

## Fix

The envelope has to move into Java **and** the wrapper has to stop adding a second copy. Both
changes, plus two related items:

1. `McpProtocolHandler.java`: `case "tools/list" -> Map.of("tools", TOOLS_LIST_SERVICE.listTools());`
2. `Tools/autopsy-mcp-stdio/autopsy-mcp-stdio.js`: pass the Java result through unchanged
   (`return result`) and read `data.result.tools` in the `--test` self-test. Fixing only the Java
   side makes the wrapper nest the object again, and its self-test fails.
3. `TskQueryService.java`: add `"additionalProperties", false` to both `inputSchema` builders (see below).
4. `Core/test/unit/src/org/sleuthkit/autopsy/mcp/McpProtocolHandlerTest.java`: conformance tests —
   both fail before the fix and pass after.

## Related (not the same severity): `additionalProperties` is not set

Every advertised tool has `"additionalProperties": null` (unset). The spec **recommends**
`{"type": "object", "additionalProperties": false}` for tools with no parameters ("*Recommended*:
explicitly accepts only empty objects"), and for tools **with** parameters it is what makes the
declared contract explicit. Without it, an unknown/typoed parameter is silently ignored and the tool
runs unfiltered — the behaviour reported in #8033, where the response to a mistyped filter is
byte-identical to an unfiltered call.

Setting the flag does not by itself reject the parameter at runtime (the server would also need to
validate the arguments against the schema and return a tool-execution error naming the unknown key),
but it makes the contract unambiguous and lets clients refuse before calling.

## What is NOT a bug (checked, to save everyone time)

- **`initialize` responding `protocolVersion: 2024-11-05` to a client that requested `2025-11-25`.**
  Legal: the spec says the server MUST echo the requested version *if it supports it*, and the client
  SHOULD disconnect if it doesn't support the version the server returned. It is a compatibility
  downgrade, not a violation. (Our SDK client accepted it and only failed at `tools/list`.)
- **`tools/call` results omitting `content`.** The spec types `content: ContentBlock[]` as required,
  but the SDK defaults it to `[]` for backwards compatibility, so it does not break clients today:
  `{"result":{"server":"coroner","status":"running","caseOpen":false}}` parses fine. Worth
  tidying for full conformance, but it is not what blocks anyone.
- **The tool schemas DO describe their parameters.** `query_files` correctly advertises 17 properties
  (`extension`, `nameContains`, `md5`, `sha256`, `modifiedAfter`, …), and the parameter-less tools
  correctly advertise `properties: {}`. The missing piece is `additionalProperties`, not the properties.

## How to verify the fix

Three checks, each runnable by a reviewer:

**`probe-conformance.mjs`** — drives a live bridge over HTTP without relying on the SDK (a
spec-validating client throws on this response, which is exactly why it cannot be used as a
diagnostic). Reports every violation instead of dying:

```bash
node probe-conformance.mjs --url http://127.0.0.1:8743/mcp --token <token> [--require-additional-properties]
```

Exit code 0 = conformant, 1 = violations (one per line). Dependency-free (Node 18+). Run against
4.23.1 before the fix it reports 1 violation, or 19 with `--require-additional-properties`
(the envelope plus the 18 tools without the flag).

**`verify/run.sh`** — runs the JUnit test for real, without needing the Autopsy build: it fetches
`McpProtocolHandler.java`, `McpException.java` and `TskQueryService.java` pinned at
`cb3dacdcad67abe7cf863c74f10dcdb8e25a5c21`, builds a `TskQueryService` stub whose `listTools()` and
schema helpers are copied **verbatim** from the round's own source, and runs the test twice:

```
run 1 — upstream code : Tests run: 2,  Failures: 2   (AssertionError: ListToolsResult … was: ARRAY)
run 2 — patch applied : OK (2 tests)
```

**`verify/run-wrapper.sh`** — verifies the JS side, which is where a half-fix regresses. It
downloads the pinned wrapper, installs the official SDK, emulates the post-fix Java bridge with a
dependency-free stub (`verify/stub-java-mcp.mjs`), and checks two things in both directions:

```
run 1 — upstream wrapper : self-test: [FAIL] tools/list returned 0 tools
                           SDK client: rejected — invalid_type at path ["tools"]: expected array, received object
run 2 — patched wrapper  : self-test: [OK] 18 tools available
                           SDK client: listTools OK: 18 tools
```

The SDK-client check is the client-visible one: it speaks MCP over stdio to the wrapper, exactly as
Claude Desktop does, and validates the response against `ListToolsResult`.

Both scripts exit non-zero if any run deviates, so they verify the patch rather than illustrate it.
Requirements: JDK 11+, git, curl, python3. See `verify/README.md` for what it does *not* cover
(compilation inside the NetBeans/Ant build and the full `Core` suite, which only your CI can judge).
