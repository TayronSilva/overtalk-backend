import test from 'node:test';
import assert from 'node:assert/strict';

import { canAccessSession } from '../src/services/sessionAccess.js';

test('owner access remains valid even after the PIN expires', () => {
  const session = {
    id: 'session-1',
    userId: 'user-1',
    pinExpiresAt: Date.now() - 1000,
    validTokens: new Map(),
  };

  const result = canAccessSession({
    session,
    authUser: { id: 'user-1' },
    token: null,
    currentTime: Date.now(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'owner');
});
