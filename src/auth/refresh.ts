import { AuthProfile, OAuthCredential, TokenRefreshResult } from './types.js';
import { getAuthProfile, setAuthProfile } from './store.js';
import { withFileLock } from './lock.js';
import {
  refreshAccessToken as anthropicRefresh,
  anthropicOAuthProvider,
} from './providers/anthropic.js';
import {
  refreshAccessToken as minimaxRefresh,
  minimaxOAuthProvider,
} from './providers/minimax.js';

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes before expiry

function isExpired(expires: number): boolean {
  return Date.now() >= expires - REFRESH_THRESHOLD_MS;
}

export async function refreshOAuthCredential(
  profileId: string,
  profile: AuthProfile
): Promise<OAuthCredential> {
  if (profile.mode !== 'oauth') {
    throw new Error('Profile is not an OAuth credential');
  }

  if (!profile.refresh) {
    throw new Error('No refresh token available');
  }

  // Use file lock to prevent concurrent refresh attempts
  const result = await withFileLock(`oauth:${profileId}`, async () => {
    // Re-read profile in case it was updated by another process
    const currentProfile = getAuthProfile(profileId);
    if (!currentProfile || currentProfile.mode !== 'oauth') {
      throw new Error('Profile not found or not OAuth');
    }

    // Check if token is still valid
    if (currentProfile.expires && !isExpired(currentProfile.expires)) {
      return {
        access: currentProfile.access!,
        refresh: currentProfile.refresh!,
        expires: currentProfile.expires!,
      };
    }

    // Refresh the token based on provider
    let refreshResult: TokenRefreshResult;

    if (currentProfile.provider === anthropicOAuthProvider) {
      // For Anthropic, we need client credentials
      // In a full implementation, these would be stored securely
      // For now, we'll use a simplified approach
      refreshResult = await anthropicRefresh(
        currentProfile.refresh!,
        'orca-cli', // Would be the actual client ID
        '' // Would be the actual client secret
      );
    } else if (currentProfile.provider === minimaxOAuthProvider) {
      refreshResult = await minimaxRefresh(
        currentProfile.refresh!,
        'orca-cli',
        ''
      );
    } else {
      throw new Error(`Unsupported OAuth provider: ${currentProfile.provider}`);
    }

    // Update profile with new credentials
    const updatedProfile: AuthProfile = {
      ...currentProfile,
      access: refreshResult.access,
      refresh: refreshResult.refresh ?? currentProfile.refresh,
      expires: refreshResult.expires,
    };

    setAuthProfile(profileId, updatedProfile);

    return refreshResult;
  });

  return {
    type: 'oauth',
    provider: profile.provider,
    access: result.access,
    refresh: result.refresh ?? profile.refresh,
    expires: result.expires,
    email: profile.email,
  };
}

export async function getValidAccessToken(
  profileId: string
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const profile = getAuthProfile(profileId);

  if (!profile) {
    return null;
  }

  if (profile.mode === 'api_key') {
    return {
      apiKey: profile.key ?? '',
      provider: profile.provider,
      email: profile.email,
    };
  }

  if (profile.mode === 'oauth') {
    // Check if we need to refresh
    if (profile.expires && !isExpired(profile.expires)) {
      return {
        apiKey: profile.access ?? '',
        provider: profile.provider,
        email: profile.email,
      };
    }

    // Refresh and return new token
    const refreshed = await refreshOAuthCredential(profileId, profile);
    return {
      apiKey: refreshed.access,
      provider: refreshed.provider,
      email: refreshed.email,
    };
  }

  if (profile.mode === 'token') {
    return {
      apiKey: profile.token ?? '',
      provider: profile.provider,
      email: profile.email,
    };
  }

  return null;
}
