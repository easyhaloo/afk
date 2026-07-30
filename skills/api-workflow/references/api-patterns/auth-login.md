# auth-login

Login to extract token for subsequent authenticated requests.

## Concept

Call login API, extract token from response, use in Authorization header for subsequent requests.

## Usage

Use `utils/auth.ts` from templates:

```typescript
import { login } from '../utils/auth';

const { token, userId } = await login(apiContext, email, password);
```

## When to Use

- User needs to authenticate before making other API calls
- Need token for subsequent request headers
