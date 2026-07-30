# api-auth-browser-session

Login via API → reuse auth session in Browser.

## Concept

Login via API to get session/cookie, then create a browser context with the same auth state to access protected pages.

## When to Use

- Need to access authenticated pages without UI login flow
- Faster test setup by reusing API login
- Testing protected routes with real auth state
