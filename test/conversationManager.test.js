import test from 'node:test';
import assert from 'node:assert/strict';

import { conversationManager } from '../src/services/ConversationManager.js';

test('canAcceptClient blocks when session reaches the SSE connection limit', () => {
  const session = conversationManager.createSession('sse-limit-test', null);
  const limit = 2;

  session.clients.add({ id: 1, res: {} });
  session.clients.add({ id: 2, res: {} });

  assert.equal(conversationManager.canAcceptClient(session, limit), false);
  conversationManager.conversations.delete(session.id);
});

test('getSession without an explicit ID does not fall back to a shared session', () => {
  assert.equal(conversationManager.getSession(), undefined);
});

test('creates a per-owner session that is not shared across different users', () => {
  const sessionA = conversationManager.createSession('owner-a', 'user-a');
  const sessionB = conversationManager.createSession('owner-b', 'user-b');

  sessionA.history.push({ id: 1, source: 'mic' });
  sessionB.history.push({ id: 2, source: 'system' });

  assert.equal(sessionA.history.length, 1);
  assert.equal(sessionB.history.length, 1);
  assert.notEqual(sessionA.id, sessionB.id);
});

test('expired PINs are not accepted by the session manager', () => {
  const session = conversationManager.createSession('pin-expired', 'user-c');
  session.pinExpiresAt = Date.now() - 1000;

  assert.equal(conversationManager.getSessionByPin(session.pin), null);
});
