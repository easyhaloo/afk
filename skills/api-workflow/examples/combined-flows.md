# Combined Flow Examples

Illustrative combinations of reusable workflow patterns. These examples show composition, not mandatory API shapes, authentication choices, file layouts, or artifact names. Derive the actual workflow from the target application and its test infrastructure.

---

## Example 1: E-commerce Order Flow

**Patterns:** auth → create resource → asynchronous completion → verification

**Scenario:** Authenticate, create an order, wait for payment processing, and verify the completed state.

**Possible flow:**
1. Establish the required test identity
2. Create the order
3. Trigger or await payment processing
4. Poll or await the application's completion signal
5. Verify authoritative order state

---

## Example 2: User Registration → KYC → Loan Application

**Patterns:** registration/auth → conditional state → asynchronous completion

**Scenario:** Register a user, process KYC, evaluate eligibility, and continue only when the application's state allows it.

**Possible flow:**
1. Establish the user identity
2. Submit registration/KYC data
3. Wait for the application's KYC completion signal
4. Read the authoritative eligibility state
5. Apply for a loan only when permitted

---

## Example 3: Checkout Flow (Hybrid)

**Patterns:** API setup → browser action → API verification

**Scenario:** Prepare a cart through an API, complete checkout in the browser, then verify the resulting order through an authoritative API.

**Possible flow:**
1. API: create or prepare cart
2. Browser: review cart and complete checkout
3. Browser: submit the final action
4. API: verify the resulting order state

---

## Example 4: Payment Webhook Verification

**Patterns:** trigger → asynchronous callback → state verification → negative case

**Scenario:** Trigger payment, observe the callback, verify state transition, then verify duplicate handling.

**Possible flow:**
1. Create order
2. Trigger payment
3. Await the application's webhook processing signal
4. Verify authoritative order state
5. Exercise the duplicate case and verify the expected error

---

## Example 5: Authenticated UI Test with Scripted Session State

**Pattern:** scripted authentication → browser verification

**Scenario:** Establish a browser-compatible authenticated state using the application's supported scripted mechanism, then verify protected pages.

The concrete mechanism, state-file location, and setup artifacts must come from the target project and the applicable authentication reference/template.

---

## Example 6: SSO-Protected App with an Interactive Local Session

**Pattern:** existing browser session → browser verification

**Scenario:** A developer has authenticated interactively, including MFA, in a dedicated local browser session. The test attaches to that session only when the repository and environment explicitly support this approach.

The CDP endpoint, profile ownership, lifecycle, and cleanup rules must come from the applicable authentication reference. Do not assume that an existing browser session is available.

---

## Example 7: Reuse an Existing Browser Session

**Pattern:** existing authenticated browser context → browser verification

**Scenario:** Reuse a test-owned authenticated browser context to verify protected application behavior.

The session acquisition mechanism is environment-specific. Prefer repository-supported fixtures and do not expose or persist personal browser credentials.

---

## Pattern Combination Cheat Sheet

| Scenario | Example composition |
|----------|---------------------|
| Order flow | auth + create + async + verify |
| User flow | auth + conditional + async + verify |
| Checkout | API setup + browser action + API verify |
| Webhook | trigger + callback + state verify + error |
| File processing | browser trigger + async + browser/API verify |
| Eligibility | conditional + expected error |
| Authenticated UI | supported auth mechanism + browser verify |
| SSO/MFA UI | interactive local session + browser verify |
