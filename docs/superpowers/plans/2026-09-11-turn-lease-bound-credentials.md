# TURN Lease-Bound Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion for this plan.

**Goal:** Ensure a TURN credential minted for a File QR receive capability cannot outlive the live File QR signaling lease that authorized it.

**Architecture:** Keep the existing rate-limited `/v1/turn-credentials` route and Cloudflare provider integration. The route must extract the authoritative lease `expiresAt`, derive remaining lease lifetime at mint time, and pass that bound to the provider adapter; the provider adapter then uses the smaller of configured credential TTL and remaining lease lifetime. No session, WebRTC, retry/resume, optical, release, or UI semantics change.

**Tech Stack:** Cloudflare Workers/Durable Objects, JavaScript ESM, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-07-v0.4-session-reliability-design.md`

## Global Constraints

- Receive-code lease remains exactly 600,000 ms from `createdAt`.
- Long-lived TURN key material remains server-side.
- Existing rate-limit ordering remains authorize -> limit -> provider mint.
- Unconfigured TURN still returns 404 and direct/STUN fallback remains unchanged.
- No production TURN claim until real relay evidence is GREEN.

---

### Task 1: Bind provider minting to remaining lease

**Files:**
- Modify: `tests/signaling/resource-routes.test.mjs`
- Modify: `tests/signaling/turn-boundary.test.mjs`
- Modify: `services/signaling/src/resource-routes.js`
- Modify: `services/signaling/src/index.js`

**Interfaces:**
- `handleTurnCredentials(...)` consumes the successful authorization JSON `{ ok, expiresAt }` and calls `generateTurnCredentialsImpl(maxTtlSeconds)`.
- `generateTurnCredentials(env, maxTtlSeconds)` sends Cloudflare a positive integer TTL no greater than both configured TTL and the remaining authorized lease lifetime.

- [ ] **Step 1: Write RED behavioral test** proving a live authorization with a finite `expiresAt` passes a bounded positive `maxTtlSeconds` to provider minting, while malformed/missing expiry fails closed before provider authority.
- [ ] **Step 2: Run PR CI and confirm the new test fails for the expected missing-bound behavior.**
- [ ] **Step 3: Implement minimal route parsing/bounding and provider TTL clamping.**
- [ ] **Step 4: Run full exact-head CI plus Browser Reliability, Pages, and Native gates and require GREEN.**
- [ ] **Step 5: Update PR #47 evidence with the new RED->GREEN lineage and exact head SHA.**
