# Orca OAuth Design

## Overview

Orca supports OAuth-based authentication for LLM providers, enabling users to leverage organization/team billing and subscription-based API access rather than personal API keys.

## Architecture

### Auth Profile Store

Credentials are stored in `~/.orca/auth_profiles.json`:

```json
{
  "profiles": {
    "default": {
      "type": "oauth",
      "provider": "anthropic",
      "access": "sk-ant-...",
      "refresh": "refresh-token",
      "expires": 1234567890,
      "email": "user@example.com"
    }
  }
}
```

### Auth Modes

| Mode | Description |
|------|-------------|
| `api_key` | Static API key |
| `oauth` | Refreshable OAuth credentials (access + refresh + expiry) |
| `token` | Static bearer token (optionally expiring) |

### Credential Types

```typescript
type AuthCredential = ApiKeyCredential | OAuthCredential | TokenCredential;

interface ApiKeyCredential {
  type: "api_key";
  provider: string;
  key: string;
  email?: string;
}

interface OAuthCredential {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;  // Unix timestamp
  email?: string;
}

interface TokenCredential {
  type: "token";
  provider: string;
  token: string;
  expires?: number;
  email?: string;
}
```

## OAuth Flow

### 1. Login (`orca login`)

```bash
orca login --provider anthropic
```

1. CLI opens browser for OAuth authorization
2. User grants permission
3. Callback received with auth code
4. CLI exchanges code for access + refresh tokens
5. Credentials stored in `~/.orca/auth_profiles.json`

### 2. Token Refresh

Before each LLM request:

1. Check if token expires within threshold (e.g., 5 minutes)
2. If expired, acquire file lock
3. Refresh token via provider's OAuth endpoint
4. Update `auth_profiles.json`
5. Release lock
6. Use new access token

### 3. File Locking

Token refresh uses file locking to prevent race conditions:

- Lock file: `~/.orca/.auth.lock`
- Timeout: 30 seconds
- Prevents multiple concurrent refresh attempts

## Provider Integration

### Anthropic OAuth

Anthropic uses OAuth 2.0 with:
- Authorization URL: `https://auth.anthropic.com/oauth/authorize`
- Token URL: `https://auth.anthropic.com/oauth/token`
- Scopes: `api:read`, `api:write`

### MiniMax OAuth

MiniMax uses OAuth 2.0 with:
- Authorization URL: `https://api.minimaxi.chat/oauth/authorize`
- Token URL: `https://api.minimaxi.chat/oauth/token`
- Scopes: `full_access`

## CLI Commands

### Login
```bash
orca login                    # Interactive provider selection
orca login --provider anthropic
orca login --provider minimax
```

### Logout
```bash
orca logout                  # Remove all credentials
orca logout --profile default
```

### Auth Status
```bash
orca auth                    # Show current auth status
orca auth --doctor           # Diagnose and repair auth issues
```

## Config Integration

In `orca.yaml`:

```yaml
provider: anthropic
auth_profile: default        # References ~/.orca/auth_profiles.json#default
code_generator: typescript
```

## Directory Structure

```
~/.orca/
├── default.yaml            # Global config
├── auth_profiles.json      # Stored credentials
├── .auth.lock             # File lock for token refresh
└── cache/                 # Token cache
```

## Security Considerations

1. **File permissions**: `auth_profiles.json` is mode `0600` (owner read/write only)
2. **No secret logging**: Credentials are redacted in logs
3. **Timing-safe comparison**: API key comparisons use `crypto.timingSafeEqual`
4. **Token expiry**: Tokens rejected if expired or invalid

## Implementation Plan

1. [ ] `src/auth/types.ts` — Auth credential types
2. [ ] `src/auth/store.ts` — Auth profile persistence
3. [ ] `src/auth/lock.ts` — File locking for token refresh
4. [ ] `src/auth/providers/anthropic.ts` — Anthropic OAuth flow
5. [ ] `src/auth/providers/minimax.ts` — MiniMax OAuth flow
6. [ ] `src/auth/refresh.ts` — Token refresh logic
7. [ ] `src/index.ts` — Add `login`, `logout`, `auth` commands
8. [ ] Update `src/llm/` to use auth profiles
