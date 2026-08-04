# Combined Flow Examples

Real-world scenarios combining multiple patterns.

---

## Example 1: E-commerce Order Flow

**Patterns:** auth-login → crud-resource → poll-until-complete

**Scenario:** User logs in, creates an order, waits for payment, verifies completion.

**Steps:**
1. Login to get token
2. Create order with products
3. Simulate payment (if applicable)
4. Poll order status until PAID
5. Verify order state

---

## Example 2: User Registration → KYC → Loan Application

**Patterns:** auth-login → conditional-flow → poll-until-complete

**Scenario:** Register user, check KYC status, apply for loan based on eligibility.

**Steps:**
1. Register or login user
2. Submit KYC documents
3. Poll KYC status until APPROVED
4. Check eligibility
5. If eligible: apply for loan

---

## Example 3: Checkout Flow (Hybrid)

**Patterns:** api-setup → browser-action → api-verify

**Scenario:** API creates cart, user completes checkout in browser, verify order via API.

**Steps:**
1. API: Create cart with items
2. Browser: User reviews cart and enters payment
3. Browser: User clicks "Pay"
4. API: Verify order was created and paid

---

## Example 4: Payment Webhook Verification

**Patterns:** verify-webhook → expect-api-error

**Scenario:** Place order, trigger payment, verify webhook received, test error handling.

**Steps:**
1. Create order
2. Trigger payment
3. Poll webhook status until received
4. Verify order status updated
5. Try duplicate payment (should fail)

---

## Example 5: Authenticated UI Test with storage-state

**Patterns:** storage-state (API setup) → browser-verify

**Mode:** `storage-state`

**Scenario:** API login, save auth state, open browser and verify protected pages.

**Generated artifacts:** `fixtures/browser-session.ts` (storage-state), `setup/auth-api.setup.ts`, `playwright/.auth/` (gitignored), `.env.example`

**Steps:**
1. Setup: API login → save state to `playwright/.auth/user.json`
2. Test: load state → open browser → verify dashboard/profile pages
3. State file is gitignored; expires when server session expires

---

## Example 6: SSO-Protected App (local dev via localhost-cdp)

**Patterns:** localhost-cdp → browser-verify

**Mode:** `localhost-cdp`

**Scenario:** App uses SSO with MFA. Developer starts a dedicated Chrome
with `--remote-debugging-port=9222`, completes SSO + MFA manually once,
and leaves it running. Tests attach over CDP and reuse the live session.

**Generated artifacts:** `fixtures/browser-session.ts` (localhost-cdp), `browser-auth-runbook.md`, `.env.example`

**Steps:**
1. One-time: launch Chrome with `--user-data-dir=~/.afk-browser-profile --remote-debugging-port=9222`
2. In the launched Chrome, complete SSO + MFA manually
3. Set `CDP_ENDPOINT=http://127.0.0.1:9222`
4. Test: fixture connects over CDP, uses existing context, creates a fresh page, verifies UI
5. Only the test-owned page is closed; external browser and pre-existing tabs are untouched

---

## Example 7: Reuse Existing Browser Session via CDP

**Patterns:** localhost-cdp → browser-verify

**Mode:** `localhost-cdp`

**Scenario:** Developer has already logged in manually in a Chromium window started with `--remote-debugging-port`. Tests attach to the existing session.

**Generated artifacts:** `fixtures/browser-session.ts` (localhost-cdp), `browser-auth-runbook.md`, `.env.example`

**Steps:**
1. Start Chromium: `google-chrome --user-data-dir=/tmp/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`
2. Log in manually in the browser
3. Set `CDP_ENDPOINT=http://127.0.0.1:9222`
4. Test: fixture connects over CDP, uses existing context, creates a new page, verifies UI
5. Only the test-owned page is closed; external browser and pre-existing tabs are untouched

---

## Pattern Combination Cheat Sheet

| Scenario | Patterns |
|----------|----------|
| Order flow | auth-login + crud + poll |
| User flow | auth-login + conditional + poll |
| Checkout | api-setup + browser-action + api-verify |
| Webhook | verify-webhook + error-validation |
| File processing | browser-trigger + poll + browser-verify |
| Eligibility | conditional-flow + expect-error |
| Auth UI (API login) | storage-state + browser-verify |
| Auth UI (SSO/MFA) | localhost-cdp + browser-verify |
| Auth UI (CDP reuse) | localhost-cdp + browser-verify |