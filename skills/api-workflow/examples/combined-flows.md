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

## Example 5: File Processing Pipeline

**Patterns:** browser-trigger → poll-until-complete → browser-verify

**Scenario:** User uploads file in browser, system processes asynchronously, verify result.

**Steps:**
1. Browser: Upload file and submit
2. API: Poll job status until COMPLETED
3. Browser: Verify result displayed

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
