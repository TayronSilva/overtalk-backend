import crypto from 'crypto';
import { getRuntimeConfig } from '../config/runtimeConfig.js';

const runtimeConfig = getRuntimeConfig();

class ConversationManager {
    constructor() {
        this.conversations = new Map();
    }

    createSession(forcedId = null, userId = null) {
        const id = forcedId || crypto.randomUUID();
        const pin = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
        
        this.conversations.set(id, {
            id,
            userId, // O dono da sessão (provém do JWT do Supabase)
            pin,
            pinExpiresAt: Date.now() + 120 * 1000, // PIN válido por 120s
            ownerToken: userId ? crypto.randomUUID() : null,
            clients: new Set(),         // SSE clients
            history: [],                // Message history
            speakers: {},               // Speaker registry
            validTokens: new Map(),     // Map<token, expiresAt> (Mobile paired tokens)
            stats: {
                startedAt: Date.now(),
                wordCount: 0,
                messageCount: 0,
                latencies: [],
                lastActive: Date.now()
            }
        });
        
        return this.conversations.get(id);
    }

    getSession(id) {
        if (!id) return undefined;
        return this.conversations.get(id);
    }

    getUserSession(userId) {
        let latestSession;
        let latestStartedAt = -1;

        for (const session of this.conversations.values()) {
            if (session.userId !== userId) continue;
            if (session.stats?.startedAt > latestStartedAt) {
                latestStartedAt = session.stats.startedAt;
                latestSession = session;
            }
        }

        return latestSession;
    }

    canAcceptClient(session, maxConnections = runtimeConfig.rateLimits.maxSseConnections) {
        return session.clients.size < maxConnections;
    }

    getSessionByPin(pin) {
        const now = Date.now();
        for (const session of this.conversations.values()) {
            if (session.pin === pin) {
                if (session.pinExpiresAt > now) {
                    return session;
                }
                return null;
            }
        }
        return null;
    }

    refreshPin(id) {
        const session = this.conversations.get(id);
        if (session) {
            session.pin = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
            session.pinExpiresAt = Date.now() + 120 * 1000;
            session.ownerToken = crypto.randomUUID();
            return session.pin;
        }
        return null;
    }

    getSessionByToken(token) {
        const now = Date.now();
        for (const session of this.conversations.values()) {
            const expiresAt = session.validTokens.get(token);
            if (expiresAt) {
                if (expiresAt > now) {
                    return session;
                } else {
                    // Cleanup expired token
                    session.validTokens.delete(token);
                    return null;
                }
            }
        }
        return null;
    }

    cleanup(maxIdleMs = 30 * 60 * 1000) {
        const now = Date.now();
        let removed = 0;
        for (const [id, session] of this.conversations.entries()) {
            const isIdle = (now - session.stats.lastActive) > maxIdleMs;
            const noClients = session.clients.size === 0;
            
            // Cleanup expired tokens on idle check
            for (const [token, expiresAt] of session.validTokens.entries()) {
                if (now > expiresAt) {
                    session.validTokens.delete(token);
                }
            }

            if (isIdle && noClients) {
                this.conversations.delete(id);
                removed++;
            }
        }
        return removed;
    }
}

export const conversationManager = new ConversationManager();
