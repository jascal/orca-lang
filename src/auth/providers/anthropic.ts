import * as readline from 'readline';
import { OAuthProvider, TokenRefreshResult } from '../types.js';

const ANTHROPIC_AUTH_URL = 'https://api.anthropic.com/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://api.anthropic.com/oauth/token';

export const anthropicOAuthProvider: OAuthProvider = 'anthropic';

interface AnthropicTokenResponse {
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
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
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
    const error = await response.json() as AnthropicTokenResponse;
    throw new Error(`Token exchange failed: ${error.error_description ?? error.error}`);
  }

  const data = await response.json() as AnthropicTokenResponse;

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
  const response = await fetch(ANTHROPIC_TOKEN_URL, {
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
    const error = await response.json() as AnthropicTokenResponse;
    throw new Error(`Token refresh failed: ${error.error_description ?? error.error}`);
  }

  const data = await response.json() as AnthropicTokenResponse;

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
  });

  if (state) {
    params.set('state', state);
  }

  return `${ANTHROPIC_AUTH_URL}?${params.toString()}`;
}

export async function promptForCode(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('Enter the authorization code: ', (code) => {
      rl.close();
      resolve(code.trim());
    });
  });
}

export async function openBrowser(url: string): Promise<void> {
  const { exec } = await import('child_process');

  // Try different commands based on platform
  const commands = ['open', 'xdg-open', 'start'];
  for (const cmd of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        exec(`${cmd} "${url}"`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return;
    } catch {
      // Try next command
    }
  }

  console.log(`Please open this URL in your browser:\n${url}`);
}

export async function getDeviceCode(): Promise<{ device_code: string; user_code: string; verification_uri: string }> {
  const response = await fetch('https://api.anthropic.com/oauth/device/code', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: 'orca-cli',
      scope: 'api:read api:write',
    }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.statusText}`);
  }

  return response.json() as Promise<{ device_code: string; user_code: string; verification_uri: string }>;
}

export async function pollForToken(deviceCode: string): Promise<TokenRefreshResult> {
  const startTime = Date.now();
  const interval = 5000; // 5 seconds

  while (Date.now() - startTime < 300000) { // 5 minute timeout
    await new Promise(resolve => setTimeout(resolve, interval));

    const response = await fetch(ANTHROPIC_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: 'orca-cli',
      }),
    });

    const data = await response.json() as AnthropicTokenResponse;

    if (data.access_token) {
      return {
        access: data.access_token,
        refresh: data.refresh_token,
        expires: Date.now() + data.expires_in * 1000,
      };
    }

    if (data.error !== 'authorization_pending') {
      throw new Error(`Device code polling failed: ${data.error_description ?? data.error}`);
    }
  }

  throw new Error('Device code authorization timed out');
}
