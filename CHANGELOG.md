# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A retry backoff no longer lets the process exit underneath the call. The
  backoff timer was `unref`'d, so a script whose only pending work was a Frege
  call — a cron job, a CLI, a Lambda handler — could drain and exit while
  sleeping between attempts: the awaited promise never settled, nothing was
  logged, and the exit code was 0. The request-timeout timer stays `unref`'d,
  which is correct: it only watches a fetch that is already holding the loop.
- `retry` values are validated when the client is built. `maxRetries: NaN` —
  what `Number(process.env.FREGE_RETRIES)` produces when the variable is unset —
  made the "last attempt" test false forever and retried without limit.
- `baseUrl` must now be `https` (loopback excepted). It was accepted unchecked,
  so `http://…` sent the API key in cleartext.
- A `TokenProvider` that returns an empty string is now refused instead of
  sending `Authorization: Bearer ` and earning an unexplainable 401.
- Every payload from the API is checked instead of cast. A `{"data": null}` on a
  list endpoint, a task that completed carrying no result, or a proxy's HTML in
  place of the envelope now raise `FregeProtocolError` rather than a bare
  `TypeError` from inside this SDK.
- `iterateOperations` no longer stops early. Asking for a page larger than the
  server's cap of 500 got a short page, which the walk read as the end of the
  list — silently truncating. `pageSize` is clamped to the cap, the offset
  advances by what actually arrived, and only an empty page ends the walk.
- `tasks.wait` applies its budget to the poll in flight, not only to the gaps
  between polls, and `FregeTimeoutError` now reports a true elapsed time. A wait
  given 10ms could sit inside a 30-second request and then report "timed out
  after 10ms".
- Error class names are literals, so a minifier cannot rename them. Bundled
  consumers were reporting every Frege error as `h` to Sentry.
- `Retry-After` is parsed as digits or an HTTP date. `1e3` was read as 1,000,000
  milliseconds.
- The client copies the options object it is given rather than aliasing it.

### Changed — breaking

- `ToolResult.data` is typed `T | string | undefined` instead of `T`. It always
  could be all three — an HTML error page, a 204 — and the type now says so.
  Narrow (`Array.isArray`, `typeof === 'object'`) before using it.
- `WaitOptions.timeoutMs` is renamed `totalTimeoutMs`. Across the whole SDK,
  `timeoutMs` now means one HTTP attempt and `totalTimeoutMs` means the whole
  operation; `RequestOptions.totalTimeoutMs` is new, and bounds a call including
  its retries.
- An unrecognised task status becomes `status: 'unknown'` with the server's word
  on `rawStatus`, instead of being cast into the closed union. `TaskStatus`
  gains `'unknown'`, and `Task` gains `UnknownPendingTask` / `UnknownTerminalTask`.
- `FregeErrorKind` gains `'protocol'`, and a non-envelope 2xx now raises
  `FregeProtocolError` rather than a `FregeAPIError` with `status: 200`.
- `TasksAPI` is exported as a type only. It could never be constructed by a
  consumer — its constructor takes the internal `HttpClient`.

## [0.1.0] - 2026-08-13

First release.

### Added

- `Frege` client bound to one project, built from a project API key
  (`frege_sk_…`), a user access token, or a function returning either.
- `invoke` — run one tool and get the upstream's own status and parsed body.
  The upstream body, which the API sends as a JSON string, is parsed once here.
- `asClient` on every invoke: run a tool as one connected end-customer, with
  that person's credential injected and both parties on the audit record.
- `invokeAsync`, `invokeAndWait`, and `tasks` (`list`, `get`, `cancel`, `wait`)
  for long-running calls. `Task` is a discriminated union over its status.
- `listOperations` and `iterateOperations` for tool discovery, with the JSON
  Schema for each tool's arguments.
- Typed errors as a discriminated union: `FregeAPIError` (with `code`,
  `fields`, `requestId`), `FregeConnectionError`, `FregeTimeoutError`,
  `FregeTaskError`, plus the `isFregeError` guard.
- Retries on idempotent GETs only — 429 and 5xx and network failures, with
  exponential backoff, full jitter, and `Retry-After` honoured. `invoke` and
  `tasks.cancel` are never retried.
- Dual ESM and CommonJS builds with types for both.

[unreleased]: https://github.com/MultiAI-Labs/frege-typescript/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MultiAI-Labs/frege-typescript/releases/tag/v0.1.0
