# Final Signaling Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the last code-only signaling gaps found during final File QR audit: TURN credentials must never outlive the live File QR lease, and client signaling messages must be strictly bounded and schema-validated before Durable Object forwarding.

**Architecture:** Keep the existing 600-second reusable lease and PR #47 resource-rate-limit architecture unchanged. Extend the Node-testable `resource-routes.js` seam so TURN provider minting receives the exact authorized lease expiry and uses a pure TTL clamp. Add one small pure signaling-message validator module and have `SessionRoom.webSocketMessage()` accept only validated `attempt-ready`, `description`, and `candidate` messages.

**Tech Stack:** Node.js 24, node:test, Cloudflare Workers Durable Objects, WebSocket signaling, WebRTC SDP/ICE.

**Spec:** `README.md`, `SECURITY.md`, and the existing PR #47 production signaling contract.

**Execution note:** PR #58 is temporarily based on `main` so repository pull-request workflows execute against the exact RED/GREEN candidate. The branch includes the already-audited #47 rate-limit lineage and is intended to supersede #47 if this final combined candidate verifies cleanly.

## Global Constraints

- Session TTL remains exactly `600_000` ms from creation.
- Successful or failed receiver attempts do not consume the lease.
- At most one receiver attempt is active at a time.
- TURN remains optional; direct/STUN fallback remains unchanged when TURN cannot be minted.
- Long-lived TURN authority stays server-side.
- No file bytes move through signaling.
- No new dependencies.
- Package version remains `0.4.0`.
- Preserve PR #47 rate-limit ordering and fail-closed behavior.

---

### Task 1: Lease-bound TURN TTL

**Files:**
- Modify: `services/signaling/src/resource-routes.js`
- Modify: `services/signaling/src/index.js`
- Test: `tests/signaling/resource-routes.test.mjs`

**Interfaces:**
- Produces: `clampTurnCredentialTtlSeconds(configuredSeconds, leaseExpiresAt, nowMs)` returning `0` when the provider minimum cannot fit inside the remaining lease, otherwise an integer TTL bounded by both configuration and lease expiry.
- `handleTurnCredentials()` passes `{ leaseExpiresAt }` to `generateTurnCredentialsImpl` only after successful live-lease authorization and rate-limit admission.

- [ ] **Step 1: Write the failing tests**
- [ ] **Step 2: Verify RED with `npm test`**
- [ ] **Step 3: Implement the minimal production change**
- [ ] **Step 4: Verify GREEN with `npm test`**

### Task 2: Bounded schema-validated signaling messages

**Files:**
- Create: `services/signaling/src/signaling-message.js`
- Modify: `services/signaling/src/index.js`
- Create: `tests/signaling/signaling-message.test.mjs`
- Modify: `tests/signaling/malformed-connect-path.test.mjs` only if its data-URL loader needs the new local module rewritten to an absolute file URL.

**Interfaces:**
- Produces: `parseClientSignalingMessage(raw)` returning a validated payload or `null`.
- Accepted types are exactly `attempt-ready`, `description`, and `candidate`.
- `attemptId` must be a positive safe integer.
- Total message length, SDP text, candidate text, and optional candidate fields are bounded.

- [ ] **Step 1: Write the failing behavior test**
- [ ] **Step 2: Verify RED with `npm test`**
- [ ] **Step 3: Implement the minimal validator and wire it into the Durable Object**
- [ ] **Step 4: Verify GREEN and full gates**

### Task 3: Final integration evidence

- [ ] Re-fetch exact branch head and compare against PR #47 base.
- [ ] Confirm no dependency, package-version, file-transfer, optical, signing, or release-path changes.
- [ ] Keep the hardening PR draft while repository trust Issue #15 remains open.
- [ ] After #15 is genuinely resolved, re-sync the stack and require fresh exact-head gates before merge.
