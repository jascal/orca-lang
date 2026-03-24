export type AuthMode = 'api_key' | 'oauth' | 'token';

export interface ApiKeyCredential {
  type: 'api_key';
  provider: string;
  key: string;
  email?: string;
}

export interface OAuthCredential {
  type: 'oauth';
  provider: string;
  access: string;
  refresh: string;
  expires: number; // Unix timestamp
  email?: string;
}

export interface TokenCredential {
  type: 'token';
  provider: string;
  token: string;
  expires?: number; // Unix timestamp
  email?: string;
}

export type AuthCredential = ApiKeyCredential | OAuthCredential | TokenCredential;

export interface AuthProfile {
  mode: AuthMode;
  provider: string;
  email?: string;
  // api_key mode
  key?: string;
  keyRef?: string;
  // token mode
  token?: string;
  tokenRef?: string;
  // oauth mode
  access?: string;
  refresh?: string;
  expires?: number;
}

export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfile>;
}

export interface AuthProfileResult {
  apiKey: string;
  provider: string;
  email?: string;
}

export type OAuthProvider = 'anthropic' | 'minimax';

export interface TokenRefreshResult {
  access: string;
  refresh?: string;
  expires: number;
}
