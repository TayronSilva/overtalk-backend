export function canAccessSession({ session, authUser, token, currentTime = Date.now() }) {
  if (!session) {
    return { allowed: false, reason: 'missing-session' };
  }

  // Check paired token FIRST (mobile devices don't have JWT authUser)
  if (token && session.validTokens?.has(token) && session.validTokens.get(token) > currentTime) {
    return { allowed: true, reason: 'paired-token' };
  }

  // Then check JWT owner (desktop user)
  if (session.userId && authUser?.id === session.userId) {
    return { allowed: true, reason: 'owner' };
  }

  if (!authUser?.id) {
    return { allowed: false, reason: 'missing-session-or-user' };
  }

  return { allowed: false, reason: 'unauthorized' };
}
