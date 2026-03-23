import { OAuthProvider, TokenRefreshResult } from '../types.js';

const MINIMAX_AUTH_URL = 'https://api.minimaxi.chat/oauth/authorize';
const MINIMAX_TOKEN_URL = 'https://api.minimaxi.chat/oauth/token';

export const minimaxOAuthProvider: OAuthProvider = 'minimax';

interface MiniMaxTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<TokenRefreshResult> {
  const response = await fetch(MINIMAX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.json() as MiniMaxTokenResponse;
    throw new Error(`Token exchange failed: ${error.error_description ?? error.error}`);
  }

  const data = await response.json() as MiniMaxTokenResponse;

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<TokenRefreshResult> {
  const response = await fetch(MINIMAX_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await response.json() as MiniMaxTokenResponse;
    throw new Error(`Token refresh failed: ${error.error_description ?? error.error}`);
  }

  const data = await response.json() as MiniMaxTokenResponse;

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}

export function buildAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state?: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'full_access',
  });

  if (state) {
    params.set('state', state);
  }

  return `${MINIMAX_AUTH_URL}?${params.toString()}`;
}
