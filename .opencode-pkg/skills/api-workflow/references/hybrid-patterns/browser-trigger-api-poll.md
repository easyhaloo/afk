# browser-trigger-api-poll

Browser triggers async operation → API polls status → Browser verifies.

## Concept

User clicks a button in browser to trigger an async backend job. Use API to poll job status until complete, then verify in browser.

## When to Use

- User uploads file → poll processing status
- User clicks "Submit" → poll job completion
- Long-running operations with progress tracking
