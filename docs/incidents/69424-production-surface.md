# Production surface investigation — 2026-10-29

Task: incident-69424c5c189844a1ca38748e. Implementation evidence for review;
authenticated journey QA remains pending.

## Root probe

At 13:18 UTC the public API `/` returned HTTP 404 with the existing JSON
not-found response. This route is intentionally unregistered. `/health`
returned HTTP 200, status healthy, database up. No root success route was
added: availability probes should use the existing health endpoint.

Production is already running API commit
`14adcba506bd1d34e9f87d405fc032e982f1cee7`, Ready revision
`yebomart-api-prod-00094-l2d`, with 100% traffic. The separate incident
`cf5968f2b17863762e931695` shipped the forwarded-client rate-limit repair
and explicit service/revision minimum-zero deployment flags. See
[its evidence](cf5968-proxy-rate-limiting.md). Do not duplicate that fix or
roll out a new runtime merely for this investigation document.

## Blocking worker failure

The original worker iterated a live session map after taking an older tmux
snapshot. A successor registered while an earlier session was finalized
could therefore be incorrectly finalized as missing. Installed source now
uses `createSessionPoller`: snapshot candidates before listing, check object
identity, and prevent overlapping ticks. Job-specific tmux names also
separate predecessor and successor sessions.

On fleet host `omevision-fleet-1`, the installed
`bin/verify-session-watcher.mjs` passed with an isolated real tmux server:
only predecessor finalized, successor survived, job names distinct.
Handler source SHA256:
`7fc0faacf5a6b130e50493f97070ca1a51a36c1b6c7355b41bbf593be2ec1096`.
Compiled watcher SHA256:
`6f1e3bdf15d7ea26fbbdbbd524ce78239cd05df9807ef9b414fcd1b2078f6895`.
The running worker PID 2027382 started 07:53:59 UTC, after the installed
compiled files' 07:28 timestamp. The compiled watcher regression command
also exited successfully. This supersedes earlier notes that the installed
worker still contained the live-map iteration bug. No worker was modified
or restarted by this task.

## Remaining review and QA

The existing incident branch was clean with no unique commits or remote
counterpart. It was fast-forwarded to freshly fetched production before
adding this evidence. No application behavior, authentication, Cloudflare,
secrets, customer records or runtime configuration changed.

Independent QA must still verify sign-in and authorized till, stock and
cash-up journeys through the normal public application. Health and an
unauthenticated rejection do not prove those workflows. Sentry coverage is
owned by the separate monitoring incident; lack of accessible YeboMart
events must not be treated as recovery evidence. Before any deployment
completion, set and run the task's read-only verifyCmd against the actual
released revision and repaired operation. This implementation handoff does
not claim authenticated QA or deployment completion.

Validation on the refreshed incident branch: `npm run build` passed;
`npm test -- src/app.proxy.test.ts --cache=false` passed all three tests.
The latter required host execution because sandbox loopback listening was
 denied with EPERM. No public network behavior was inferred from that denial.
