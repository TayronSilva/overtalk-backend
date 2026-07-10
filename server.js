import express from 'express';
import cors from 'cors';
import path from 'path';
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');
import { pipeline, env, AutoModel, AutoProcessor, cos_sim } from '@huggingface/transformers';
import { spawn } from 'child_process';
import { config } from 'dotenv';
config(); // Carrega .env ANTES de qualquer process.env

import fs from 'fs';
import crypto from 'crypto';
import db, { canStartSession, startSession, getSessionsToday, getUserInfo, getUserPlan, checkLimit, upgradeUserTier, createPendingTransaction, getPendingTransaction, updatePendingStatus, PLANS } from './src/db/database.js';
import { MercadoPagoConfig, PreApproval, Payment } from 'mercadopago';
import { createClient } from '@supabase/supabase-js';
import { conversationManager } from './src/services/ConversationManager.js';
import { canAccessSession } from './src/services/sessionAccess.js';
import { getRuntimeConfig } from './src/config/runtimeConfig.js';
import { createInMemoryRateLimiter } from './src/config/rateLimiter.js';
import { createRateLimitMiddleware } from './src/config/rateLimitMiddleware.js';
import { getAudioDurationSeconds, isPayloadTooLarge } from './src/config/payloadProtection.js';

// --- AUTH SETUP (SUPABASE) ---
const runtimeConfig = getRuntimeConfig();
const apiRateLimiter = createInMemoryRateLimiter({
    limit: runtimeConfig.rateLimits.apiPerMinute,
    windowMs: 60 * 1000,
    keyPrefix: 'api'
});
const pinRateLimiter = createInMemoryRateLimiter({
    limit: runtimeConfig.rateLimits.pinPerMinute,
    windowMs: 60 * 1000,
    keyPrefix: 'pin'
});
const sessionRateLimiter = createInMemoryRateLimiter({
    limit: runtimeConfig.rateLimits.sessionPerMinute,
    windowMs: 60 * 1000,
    keyPrefix: 'session'
});
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = SUPABASE_URL ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

// --- MERCADO PAGO SETUP ---
const MERCADO_PAGO_ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN || '';
const mpClient = MERCADO_PAGO_ACCESS_TOKEN ? new MercadoPagoConfig({ accessToken: MERCADO_PAGO_ACCESS_TOKEN }) : null;
const mpPreApproval = mpClient ? new PreApproval(mpClient) : null;
if (!mpClient) {
    console.warn("⚠️ [MP] Mercado Pago não configurado. Payment routes desabilitadas.");
}

// Configuração de planos × preços no MP (em centavos)
const MP_PLAN_PRICES = {
    profissional: 500,   // R$ 5,00
    poweruser: 1000,     // R$ 10,00
    corporate: 1500,     // R$ 15,00
};
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;
if (!supabase) {
    console.warn("⚠️ [AUTH] Supabase não configurado no .env. Rodando em modo aberto (sem login exigido).");
}

const requireAuth = async (req, res, next) => {
    if (!supabase && process.env.NODE_ENV === 'development') return next(); // Bypass só em DEV
    
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token JWT ausente.' });

    if (!supabase) return res.status(500).json({ error: 'Servidor não configurado para autenticação.' });
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
        console.warn(`🔒 [AUTH] Token inválido ou expirado. IP: ${req.ip}`);
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
    
    // Auto-cria o user no SQLite local para contabilizar limites
    try {
        const stmt = db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`);
        stmt.run(user.id, user.email);
    } catch (e) {}
    
    req.user = user;
    next();
};

// --- GLOBAL ERROR HANDLERS ---
process.on('uncaughtException', (err) => {
    console.error('\n[!] UNCAUGHT EXCEPTION:', err.message);
    console.error(err.stack);
    // Não fechamos o processo, PM2 vai reiniciar se precisarmos dar exit()
    // mas evitamos quedas por erros aleatórios.
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('\n[!] UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

// -------------------------------------------------------------------
// FILA DE TRANSCRIÇÃO (TranscriptionQueue)
// Garante que o Whisper processa UM job por vez (maxConcurrent = 1).
// Evita saturação de CPU/GPU em falas contínuas (vídeos, streams).
// -------------------------------------------------------------------
class TranscriptionQueue {
    constructor({ maxConcurrent = 1, maxQueueDepth = runtimeConfig.rateLimits.maxQueueSize, jobTimeoutMs = runtimeConfig.rateLimits.queueTimeoutMs } = {}) {
        this.maxConcurrent = maxConcurrent;
        this.maxQueueDepth = maxQueueDepth;
        this.jobTimeoutMs = jobTimeoutMs;
        this.running = 0;
        this.queue = []; // [{fn, resolve, reject, isPartial}]
    }

    get depth() { return this.queue.length; }
    get isBusy() { return this.running >= this.maxConcurrent; }
    get isFull() { return this.queue.length >= this.maxQueueDepth; }

    // Adiciona um job à fila. Descarta parciais se a fila estiver cheia.
    enqueue(fn, { isPartial = false } = {}) {
        return new Promise((resolve, reject) => {
            if (this.isFull) {
                if (isPartial) {
                    // Parcial descartado silenciosamente — não vale saturar o servidor
                    console.warn(`⚡ [QUEUE] Parcial descartado (fila cheia: ${this.queue.length}/${this.maxQueueDepth})`);
                    return resolve(null); // Sinaliza descarte
                }
                // Para finais: substitui o último parcial da fila, se houver
                const oldPartialIdx = this.queue.findLastIndex(j => j.isPartial);
                if (oldPartialIdx !== -1) {
                    const [dropped] = this.queue.splice(oldPartialIdx, 1);
                    dropped.reject(new Error('DROPPED_BY_FINAL'));
                    console.warn(`⚡ [QUEUE] Parcial antigo removido para dar lugar a job final.`);
                } else {
                    // Fila cheia de finais: rejeita o mais antigo
                    const [dropped] = this.queue.splice(0, 1);
                    dropped.reject(new Error('QUEUE_OVERFLOW'));
                    console.warn(`⚠️ [QUEUE] Overflow! Job mais antigo descartado.`);
                }
            }
            this.queue.push({ fn, resolve, reject, isPartial });
            this._tick();
        });
    }

    _tick() {
        if (this.running >= this.maxConcurrent || this.queue.length === 0) return;
        const job = this.queue.shift();
        this.running++;
        broadcastQueueStatus();

        const timeoutId = setTimeout(() => {
            job.reject(new Error('JOB_TIMEOUT'));
        }, this.jobTimeoutMs);

        Promise.resolve()
            .then(() => job.fn())
            .then(result => { clearTimeout(timeoutId); job.resolve(result); })
            .catch(err => { clearTimeout(timeoutId); job.reject(err); })
            .finally(() => {
                this.running--;
                broadcastQueueStatus();
                this._tick(); // Processa próximo
            });
    }
}

const transcriptionQueue = new TranscriptionQueue({
    maxConcurrent: 2,
    maxQueueDepth: runtimeConfig.rateLimits.maxQueueSize,
    jobTimeoutMs: runtimeConfig.rateLimits.queueTimeoutMs
});

function broadcastQueueStatus() {
    // Broadcast for the default session for now (we'll implement per-session queues later)
    broadcastEvent('default-session', {
        type: 'queue_status',
        running: transcriptionQueue.running,
        depth: transcriptionQueue.depth,
        isBusy: transcriptionQueue.isBusy,
    });
}

// Pasta ÚNICA de cache para evitar confusão no Windows
env.allowLocalModels = false;
env.cacheDir = path.join(process.cwd(), '.cache'); 

console.log(`[CONFIG] Limites carregados: fila=${runtimeConfig.rateLimits.maxQueueSize}, timeoutFila=${runtimeConfig.rateLimits.queueTimeoutMs}ms, audioMax=${runtimeConfig.rateLimits.maxAudioDurationSeconds}s`);

const app = express();

// CORS — restrito a origens conhecidas + túnel dinâmico
const ALLOWED_ORIGINS = [
    'https://overtalk.vercel.app',
    'https://overtalk.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
];
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.lhr.life') || origin.endsWith('.localhost.run'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (!origin) {
        // Same-origin requests or direct API calls (mobile, extensions)
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
        res.setHeader('Access-Control-Allow-Origin', 'https://overtalk.vercel.app');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '0');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Content-Length': '0' });
        return res.end();
    }
    next();
});
app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));

// Middleware para validar magic bytes de áudio (PCM Float32)
function isValidAudioBuffer(buffer) {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 16) return false;
    if (buffer.length % 4 !== 0) return false; // Float32 = 4 bytes por sample
    return true;
}

// Memória de Vozes (Persistência no Disco)
const SPEAKERS_FILE = path.join(process.cwd(), 'speakers.json');

// Carrega as vozes salvas ao iniciar (na sessão default)
function loadSpeakers() {
    try {
        if (fs.existsSync(SPEAKERS_FILE)) {
            const data = JSON.parse(fs.readFileSync(SPEAKERS_FILE, 'utf8'));
            const session = conversationManager.getUserSession(null);
            if (!session) {
                console.log(`[BACKUP] Nenhuma sessão ativa para restaurar vozes salvas.`);
                return;
            }
            for (let name in data) {
                session.speakers[name] = new Float32Array(Object.values(data[name]));
            }
            console.log(`📂 [BACKUP] Carregadas ${Object.keys(session.speakers).length} vozes salvas no HD.`);
        }
    } catch (e) { console.error("❌ Falha ao carregar speakers.json:", e.message); }
}
loadSpeakers();

function saveSpeakers(session) {
    try {
        fs.writeFileSync(SPEAKERS_FILE, JSON.stringify(session.speakers, null, 2));
    } catch (e) { console.error("❌ Falha ao salvar no HD:", e.message); }
}

// --- SESSION MANAGER E TÚNEL ---
let currentTunnelUrl = "";

// --- SSE Token Exchange (evita expor JWT em query string) ---
const sseTokens = new Map(); // Map<token, { userId, sessionId, expiresAt }>

function generateSseToken(userId) {
    const token = crypto.randomUUID();
    sseTokens.set(token, {
        userId,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutos
    });
    return token;
}

// Cleanup SSE tokens periódico
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of sseTokens.entries()) {
        if (now > data.expiresAt) sseTokens.delete(token);
    }
}, 60000);

app.post('/api/sse/token', requireAuth, (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Não autorizado.' });
    const sseToken = generateSseToken(userId);
    res.json({ token: sseToken, expiresIn: 300 });
});

// Função para validar token SSE ou JWT
async function resolveSseUser(token) {
    // Tenta SSE token primeiro (curta duração, nunca logado)
    if (token && sseTokens.has(token)) {
        const data = sseTokens.get(token);
        if (Date.now() < data.expiresAt) {
            return { userId: data.userId };
        }
        sseTokens.delete(token);
    }
    // Fallback: JWT via Supabase
    if (token && supabase) {
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) return { userId: user.id };
    }
    return null;
}

app.get('/api/pin', (req, res) => {
    res.json({ url: currentTunnelUrl });
});

// --- SIGNUP PROXY (bypassa rate limit de email do Supabase) ---
const signupRateLimiter = createInMemoryRateLimiter({
    limit: 5,
    windowMs: 60 * 60 * 1000, // 5 tentativas por hora
    keyPrefix: 'signup'
});
const signupRateLimitMiddleware = createRateLimitMiddleware({
    limiter: signupRateLimiter,
    keyGenerator: (req) => req.ip || 'unknown',
    message: 'Limite de cadastros atingido. Tente novamente em 1 hora.',
    logLabel: 'signup'
});
app.post('/api/auth/signup', express.json(), signupRateLimitMiddleware, async (req, res) => {
    if (!supabaseAdmin) {
        return res.status(500).json({ error: 'Servidor não configurado para cadastro.' });
    }
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres.' });
    }
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (error) {
        console.error(`❌ [AUTH] Erro Supabase ao criar usuário ${email}:`, error.message);
        return res.status(400).json({ error: error.message });
    }
    console.log(`👤 [AUTH] Novo usuário criado: ${email}`);

    // Salva o usuário no SQLite local imediatamente
    try {
        const stmt = db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)`);
        stmt.run(data.user.id, email);
    } catch (e) {
        console.error(`⚠️ [AUTH] Falha ao salvar usuário no SQLite:`, e.message);
    }

    res.json({ success: true });
});
// -----------------------------------------------------------------

const userKey = (req) => req.user?.id || req.ip || 'unknown';

const apiRateLimitMiddleware = createRateLimitMiddleware({
    limiter: apiRateLimiter,
    keyGenerator: userKey,
    message: 'Limite de requisições atingido. Tente novamente em instantes.',
    logLabel: 'api'
});

const pinRateLimitMiddleware = createRateLimitMiddleware({
    limiter: pinRateLimiter,
    keyGenerator: userKey,
    message: 'Limite de PIN atingido. Tente novamente em instantes.',
    logLabel: 'pin'
});

const sessionRateLimitMiddleware = createRateLimitMiddleware({
    limiter: sessionRateLimiter,
    keyGenerator: userKey,
    message: 'Limite de sessões atingido. Tente novamente em instantes.',
    logLabel: 'session'
});

app.post('/api/pair', express.json(), pinRateLimitMiddleware, async (req, res) => {
    const { pin } = req.body;
    const authToken = req.headers.authorization?.split(' ')[1];
    let session = conversationManager.getSessionByPin(pin);

    if (authToken && supabase) {
        const { data: { user }, error } = await supabase.auth.getUser(authToken);
        if (error || !user) {
            return res.status(401).json({ success: false, error: 'Token inválido ou expirado.' });
        }

        if (!session || session.userId !== user.id || session.pinExpiresAt <= Date.now()) {
            console.warn(`[SECURITY] Pareamento negado para usuário ${user.id} com PIN ${pin}`);
            return res.status(401).json({ success: false, error: 'PIN Inválido' });
        }
    }

    if (session) {
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        session.validTokens.set(token, expiresAt);
        console.log(`✅ Dispositivo Autorizado na Sessão ${session.id}.`);
        res.json({ success: true, token, sessionId: session.id });
        setTimeout(() => broadcastEvent(session.id, { type: 'device_connected', count: session.validTokens.size }), 100);
    } else {
        console.log(`❌ Tentativa falha de conexão (PIN Incorreto: ${pin})`);
        res.status(401).json({ success: false, error: "PIN Inválido" });
    }
});

const requireConversationOwnership = async (req, res, next) => {
    const sid = req.query.sessionId || req.body?.sessionId;
    const authHeader = req.headers.authorization?.split(' ')[1]; // JWT (desktop)
    const pairedToken = req.query.token;                          // Paired/mobile/SSE token (temporário)
    const token = authHeader || pairedToken;
    let session = sid ? conversationManager.getSession(sid) : undefined;
    let authUser = null;

    // JWT só é aceito via Authorization header (nunca via query string)
    if (authHeader && supabase) {
        const { data: { user } } = await supabase.auth.getUser(authHeader);
        authUser = user;
    } else if (pairedToken && sseTokens.has(pairedToken)) {
        // SSE tokens: resolve userId sem expor JWT
        const sseData = sseTokens.get(pairedToken);
        if (Date.now() < sseData.expiresAt && sseData.userId) {
            authUser = { id: sseData.userId };
        }
    }

    // Se não encontrou por sessionId, tenta pela sessão do usuário autenticado
    if (!session && authUser) {
        session = conversationManager.getUserSession(authUser.id);
    }

    // Se ainda não encontrou, tenta buscar pelo token pareado (dispositivo mobile)
    if (!session && token) {
        session = conversationManager.getSessionByToken(token);
    }

    if (!session) {
        return res.status(404).json({ error: 'Conversa não encontrada.' });
    }

    const access = canAccessSession({
        session,
        authUser,
        token,
        currentTime: Date.now(),
    });

    if (access.allowed) {
        req.session = session;
        return next();
    }

    if (token && supabase && authUser) {
        console.warn(`🔒 [SECURITY] Tentativa de acesso não autorizado à sessão ${sid} pelo usuário ${authUser.id}`);
        return res.status(403).json({ error: 'Forbidden: Você não é o dono desta conversa.' });
    }

    if (!supabase) {
        if (process.env.NODE_ENV === 'development') {
            req.session = session;
            return next();
        }
        console.error(`🚨 [CRÍTICO] Falha catastrófica: Servidor em produção sem Supabase inicializado. Acesso negado por segurança.`);
        return res.status(500).json({ error: 'Configuração de segurança ausente.' });
    }

    console.warn(`🔒 [SECURITY] Acesso negado à sessão ${sid}. IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: JWT ou Token Pareado necessário.' });
}

const MAX_HISTORY = 50;

app.get('/api/session/stats', requireConversationOwnership, (req, res) => {
    const session = req.session;
    const stats = session.stats;
    
    const avgLatency = stats.latencies.length
        ? Math.round(stats.latencies.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, stats.latencies.length))
        : 0;
        
    res.json({
        startedAt: stats.startedAt,
        wordCount: stats.wordCount,
        messageCount: stats.messageCount,
        avgLatency,
        connectedDevices: session.validTokens.size,
        pin: session.pin,
        tunnelUrl: currentTunnelUrl,
    });
});

// --- ACCOUNT INFO (com planos) ---
app.get('/api/account', requireAuth, (req, res) => {
    const userId = req.user?.id;
    const email = req.user?.email || 'dev@local';
    
    const planData = userId ? getUserPlan(userId) : null;
    const sessionLimit = planData?.limits?.maxDailySessions || Infinity;
    
    res.json({
        email,
        tier: planData?.tier || 'free',
        plan: planData?.plan || PLANS.free,
        usage: planData?.usage || { minutesUsed: 0, storageUsed: 0, sessionsToday: 0 },
        limits: planData?.limits || { minutesPerMonth: 30, storageMB: 10, maxDailySessions: sessionLimit },
        canStart: userId ? canStartSession(userId, planData?.tier || 'free') : true,
        memberSince: planData?.memberSince || null
    });
});

// --- UPGRADE DE PLANO (simulado até integrar Stripe) ---
app.post('/api/account/upgrade', requireAuth, (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Usuário não autenticado' });
    
    const { tier: newTier } = req.body;
    if (!newTier || !PLANS[newTier]) {
        return res.status(400).json({ error: 'Plano inválido', availableTiers: Object.keys(PLANS) });
    }
    if (newTier === 'free') {
        return res.status(400).json({ error: 'Não é possível fazer downgrade para Free' });
    }
    
    try {
        const updated = upgradeUserTier(userId, newTier);
        console.log(`💳 [UPGRADE] Usuário ${userId} fez upgrade para ${newTier}`);
        res.json({ success: true, plan: updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- MERCADO PAGO: CRIAR ASSINATURA ---
app.post('/api/payment/create_subscription', requireAuth, express.json(), async (req, res) => {
    if (!mpPreApproval) {
        return res.status(503).json({ error: 'Mercado Pago não configurado no servidor.' });
    }
    const userId = req.user?.id;
    const userEmail = req.user?.email;
    if (!userId) return res.status(401).json({ error: 'Usuário não autenticado' });

    const { tier } = req.body;
    if (!tier || !MP_PLAN_PRICES[tier]) {
        return res.status(400).json({ error: 'Plano inválido', availableTiers: Object.keys(MP_PLAN_PRICES) });
    }

    const price = MP_PLAN_PRICES[tier];
    const planName = PLANS[tier]?.name || tier;

    try {
        const externalReference = `${userId}_${tier}_${Date.now()}`;
        createPendingTransaction(externalReference, userId, tier);

        const preapproval = await mpPreApproval.create({
            body: {
                reason: `OverTalk — ${planName}`,
                external_reference: externalReference,
                payer_email: userEmail,
                auto_recurring: {
                    frequency: 1,
                    frequency_type: 'months',
                    transaction_amount: price / 100,
                    currency_id: 'BRL',
                },
                back_url: {
                    success: `${req.headers.origin || 'https://overtalk.vercel.app'}/pagamento-sucesso.html`,
                    failure: `${req.headers.origin || 'https://overtalk.vercel.app'}/pagamento-cancelado.html`,
                    pending: `${req.headers.origin || 'https://overtalk.vercel.app'}/pagamento-cancelado.html`,
                },
                status: 'authorized',
            },
        });

        console.log(`💳 [MP] Assinatura criada para ${userId} (${tier}): ${preapproval.id}`);
        res.json({
            success: true,
            subscriptionId: preapproval.id,
            initPoint: preapproval.init_point || preapproval.sandbox_init_point,
        });
    } catch (err) {
        console.error('❌ [MP] Erro ao criar assinatura:', err.message);
        res.status(500).json({ error: 'Falha ao criar pagamento.', detail: err.message });
    }
});

// --- MERCADO PAGO: WEBHOOK ---
app.post('/api/payment/webhook', express.json(), async (req, res) => {
    // Responde 200 imediatamente pro MP não ficar reenviando
    res.status(200).json({ received: true });

    const { action, data, type } = req.body;

    // MP envia tanto 'payment' quanto 'preapproval' events
    // Só processamos assinaturas
    if (!data?.id) return;

    console.log(`📬 [MP WEBHOOK] action=${action}, type=${type}, id=${data.id}`);

    try {
        if (type === 'preapproval' || type === 'subscription_preapproval' || action?.includes('preapproval')) {
            const subscription = await mpPreApproval.get({ id: data.id });
            const status = subscription.status;

            console.log(`📬 [MP] Assinatura ${data.id}: status=${status}, external_ref=${subscription.external_reference}`);

            if (status === 'authorized' && subscription.external_reference) {
                const [userId, tier] = subscription.external_reference.split('_');
                if (userId && tier && PLANS[tier]) {
                    upgradeUserTier(userId, tier);
                    updatePendingStatus(subscription.external_reference, 'approved');
                    console.log(`✅ [MP] Plano ATIVADO para ${userId}: ${tier}`);
                }
            }
        } else if (type === 'payment' || type === 'subscription_charge') {
            // Pagamento recorrente avulso (já tem assinatura ativa)
            console.log(`📬 [MP] Cobrança recebida para assinatura ${data.id}`);
        }
    } catch (err) {
        console.error('❌ [MP] Erro ao processar webhook:', err.message);
    }
});

// --- START SESSION (com rate limit) ---
app.post('/api/session/start', requireAuth, sessionRateLimitMiddleware, apiRateLimitMiddleware, (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
        // Bypass dev
        const session = conversationManager.createSession();
        return res.json({ success: true, sessionId: session.id, pin: session.pin }); 
    }
    
    const user = getUserInfo(userId);
    const tier = user?.tier || 'free';
    if (!canStartSession(userId, tier)) {
        const used = getSessionsToday(userId);
        return res.status(429).json({
            error: 'Limite diário atingido',
            message: `Plano Free: ${used}/${runtimeConfig.rateLimits.maxDailySessions} sessões usadas hoje. Faça upgrade para Pro para acesso ilimitado.`,
            upgrade: true
        });
    }
    startSession(userId);
    const session = conversationManager.createSession(null, userId);
    console.log(`👤 [SESSION] Nova sessão ${session.id} criada para o usuário ${userId}`);
    res.json({ success: true, sessionId: session.id, pin: session.pin });
});

app.get('/api/health', (req, res) => {
    const memory = process.memoryUsage();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        memory: {
            rss: Math.round(memory.rss / 1024 / 1024) + ' MB',
            heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + ' MB',
            heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + ' MB'
        },
        queue: {
            running: transcriptionQueue.running,
            depth: transcriptionQueue.depth,
            maxDepth: transcriptionQueue.maxQueueDepth,
            isBusy: transcriptionQueue.isBusy,
        }
    });
});

app.get('/api/session/export', requireConversationOwnership, (req, res) => {
    const session = req.session;
    const lines = session.history.map((m, i) => {
        const time = new Date(m.id || Date.now()).toLocaleTimeString('pt-BR');
        const who = m.source === 'mic' ? 'VOCÊ' : (m.speaker || 'SISTEMA');
        return `[${time}] ${who}\n  Original:  ${m.original}\n  Tradução:  ${m.translated}\n`;
    });
    const content = `OverTalk — Sessão exportada em ${new Date().toLocaleString('pt-BR')}\n${'─'.repeat(60)}\n\n${lines.join('\n')}`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="overtalk-sessao-${Date.now()}.txt"`);
    res.send(content);
});

function addToHistory(sessionId, data) {
    if (data.isPartial) return; // Não salva parciais no histórico
    const session = conversationManager.getSession(sessionId);
    
    data.id = Date.now() + Math.random(); // Identificador Único
    session.history.push(data);
    if (session.history.length > MAX_HISTORY) session.history.shift();
}

// Rota de Sincronização Bruta (Bypass de Bloqueios da Cloudflare)
app.get('/history_sync', requireConversationOwnership, (req, res) => {
    const session = req.session;
    res.json(session.history);
});

let transcriber = null;
let voiceModel = null;
let voiceProcessor = null;
let modelPromise = null;
let voicePromise = null;

async function getTranscriber() {
    if (transcriber) return transcriber;
    if (modelPromise) return modelPromise;

    modelPromise = (async () => {
        // Trocado para 'base' focado em maior precisão de entendimento (accuracy) em vez de velocidade extrema.
        const modelName = 'Xenova/whisper-base';
        console.log("------------------------------------------------------------------");
        console.log(`📥 CARREGANDO MODELO TRANSCRIÇÃO: ${modelName.toUpperCase()}...`);
        console.log("------------------------------------------------------------------");
        try {
            transcriber = await pipeline('automatic-speech-recognition', modelName, {
                progress_callback: (data) => {
                    if (data.status === 'progress') {
                        process.stdout.write(`\r📥 Baixando ${data.file}: ${data.progress.toFixed(1)}%   `);
                    } else if (data.status === 'done') {
                        process.stdout.write(`\r✅ OK: ${data.file}           \n`);
                    }
                }
            });
            console.log(`\n✅ MODELO TRANSCRIÇÃO PRONTO.`);
            return transcriber;
        } catch(e) {
            console.error(`\n❌ ERRO TRANSCRIÇÃO:`, e.message);
            modelPromise = null;
            throw e;
        }
    })();
    return modelPromise;
}

async function getVoiceModel() {
    if (voiceModel && voiceProcessor) return { model: voiceModel, processor: voiceProcessor };
    if (voicePromise) return voicePromise;

    voicePromise = (async () => {
        const model_id = 'Xenova/unispeech-sat-base-plus-sv';
        console.log("------------------------------------------------------------------");
        console.log(`📥 CARREGANDO MODELO IDENTIDADE: ${model_id.toUpperCase()}...`);
        console.log("------------------------------------------------------------------");
        try {
            voiceProcessor = await AutoProcessor.from_pretrained(model_id);
            voiceModel = await AutoModel.from_pretrained(model_id);
            console.log("✅ MODELO IDENTIDADE DE VOZ PRONTO!");
            return { model: voiceModel, processor: voiceProcessor };
        } catch(e) {
            console.error("❌ ERRO IDENTIDADE:", e.message);
            voicePromise = null;
            throw e;
        }
    })();
    return voicePromise;
}

// Inicia carregamentos
getTranscriber().catch(() => {});
getVoiceModel().catch(() => {});

function broadcastEvent(sessionId, data) {
    const session = conversationManager.getSession(sessionId);
    if (!session) return;
    
    if (data.type === 'translation') {
        addToHistory(session.id, data);
        if (!data.isPartial) {
            // Count words for stats
            const words = (data.translated || '').trim().split(/\s+/).filter(Boolean).length;
            session.stats.wordCount += words;
            session.stats.messageCount++;
            session.stats.lastActive = Date.now();
        }
    }
    const message = `data: ${JSON.stringify(data)}\n\n`;
    session.clients.forEach(client => client.res.write(message));
}

// Heartbeat (Pulse) e Cleanup Routine
setInterval(() => {
    const now = Date.now();
    for (const session of conversationManager.conversations.values()) {
        session.clients.forEach(c => c.res.write(`data: ${JSON.stringify({ type: 'heartbeat', time: now })}\n\n`));
    }
    
    // Roda o cleanup a cada 60 segundos
    const removed = conversationManager.cleanup();
    if (removed > 0) {
        console.log(`🧹 [CLEANUP] ${removed} sessões inativas removidas da memória.`);
    }
}, 15000);

app.get('/events', requireConversationOwnership, (req, res) => {
    const session = req.session;

    if (!conversationManager.canAcceptClient(session)) {
        console.warn(`[SSE] Limite de conexões atingido para sessão ${session.id}`);
        return res.status(429).json({ error: 'Limite de conexões SSE atingido.' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Accel-Buffering', 'no'); // CRITICO: Força o Cloudflare a nao buffar a stream
    res.setHeader('Connection', 'keep-alive');
    // Security: não permite iframe
    res.setHeader('X-Frame-Options', 'DENY');
    res.flushHeaders();
    
    // Envia o histórico imediatamente ao conectar
    if (session.history.length > 0) {
        const historyMessage = `data: ${JSON.stringify({ type: 'history', messages: session.history })}\n\n`;
        res.write(historyMessage);
    }

    const clientId = Date.now();
    const newClient = { id: clientId, res };
    session.clients.add(newClient);
    session.stats.lastActive = Date.now();
    
    console.log(`📡 Dispositivo conectado na Sessão ${session.id} (ID: ${clientId})`);
    req.on('close', () => { session.clients.delete(newClient); });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'mobile.html'));
});

app.get('/mobile', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'mobile.html'));
});

// --- GERENCIAMENTO DE VOZES ---
app.get('/list_speakers', requireConversationOwnership, (req, res) => {
    const session = req.session;
    res.json(Object.keys(session.speakers));
});

app.post('/delete_speaker', requireConversationOwnership, (req, res) => {
    const name = req.query.name;
    const session = req.session;
    
    if (session.speakers[name]) {
        delete session.speakers[name];
        saveSpeakers(session);
        console.log(`🗑️ Voz de [${name.toUpperCase()}] removida da sessão ${session.id}.`);
        return res.json({ success: true });
    }
    res.status(404).send("Não encontrado.");
});

app.post('/register_voice', requireConversationOwnership, apiRateLimitMiddleware, async (req, res) => {
    try {
        const name = req.query.name;
        const session = req.session;
        
        if (!name) return res.status(400).send("Nome necessário.");

        if (isPayloadTooLarge(req.body, runtimeConfig.rateLimits.maxPayloadBytes)) {
            console.warn(`[PAYLOAD] Registro de voz rejeitado por tamanho excessivo. sessão=${session.id}, bytes=${req.body?.length || 0}`);
            return res.status(413).json({ error: 'Payload excede o tamanho máximo permitido.' });
        }
        
        // Valida formato do áudio
        if (!isValidAudioBuffer(req.body)) {
            return res.status(400).json({ error: 'Formato de áudio inválido. Esperado Float32 PCM.' });
        }
        
        // CORREÇÃO CRÍTICA: Converte Buffer do Node para Float32Array de forma segura
        const audioBuffer = Buffer.from(req.body);
        const float32Audio = new Float32Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 4);
        const { model, processor } = await getVoiceModel();
        
        // LIMITAÇÃO DE TEMPO: usa o limte configurado para treinar (garante consistência)
        const maxAudioDurationSeconds = runtimeConfig.rateLimits.maxAudioDurationSeconds;
        const MAX_SAMPLES_ID = 16000 * maxAudioDurationSeconds;
        const idAudio = float32Audio.length > MAX_SAMPLES_ID 
            ? float32Audio.slice(0, MAX_SAMPLES_ID) 
            : float32Audio;

        const inputs = await processor(idAudio);
        const { embeddings } = await model(inputs);
        
        session.speakers[name] = embeddings.data;
        saveSpeakers(session); // Salva no HD
        console.log(`✅ Voz de [${name.toUpperCase()}] registrada com sucesso na Sessão ${session.id}!`);
        res.json({ success: true, name: name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/translate', requireConversationOwnership, async (req, res) => {
    const source = req.query.source || 'system';
    const isPartial = req.query.isPartial === 'true';
    const session = req.session;
    session.stats.lastActive = Date.now();

    if (isPayloadTooLarge(req.body, runtimeConfig.rateLimits.maxPayloadBytes)) {
        console.warn(`[PAYLOAD] Requisição /translate rejeitada por tamanho excessivo. source=${source}, bytes=${req.body?.length || 0}`);
        return res.status(413).json({ error: 'Payload excede o tamanho máximo permitido.' });
    }

    // Valida formato do áudio
    if (!isValidAudioBuffer(req.body)) {
        return res.status(400).json({ error: 'Formato de áudio inválido. Esperado Float32 PCM.' });
    }

    // CORREÇÃO CRÍTICA: Converte Buffer do Node para Float32Array de forma segura
    const audioBuffer = Buffer.from(req.body);
    const float32Audio = new Float32Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 4);

    // Diagnóstico de áudio no Servidor
    if (float32Audio.length > 0) {
        let maxAmp = 0;
        for (let i = 0; i < float32Audio.length; i++) {
            const abs = Math.abs(float32Audio[i]);
            if (abs > maxAmp) maxAmp = abs;
        }
        console.log(`🎤 [${source.toUpperCase()}] Áudio recebido: ${(float32Audio.length / 16000).toFixed(2)}s | Pico: ${maxAmp.toFixed(4)} | Fila: ${transcriptionQueue.depth}/${transcriptionQueue.maxQueueDepth} | Rodando: ${transcriptionQueue.running}`);
    }

    // Enfileira o job de transcrição — parciais são descartados se a fila estiver cheia
    let result;
    try {
        result = await transcriptionQueue.enqueue(async () => {
            // ---- Job começa aqui (dentro da fila, execução serial) ----

            // 1. Identificação de Voz (Speaker ID)
            let identifiedSpeaker = (source === 'mic') ? 'Você' : 'Native';

            if (source === 'system' && !isPartial) {
                try {
                    const { model, processor } = await getVoiceModel();

                    // LIMITAÇÃO DE TEMPO: pega no máximo o trecho configurado para identificação de voz
                    const maxAudioDurationSeconds = runtimeConfig.rateLimits.maxAudioDurationSeconds;
                    const MAX_SAMPLES_ID = 16000 * maxAudioDurationSeconds;
                    const idAudio = float32Audio.length > MAX_SAMPLES_ID
                        ? float32Audio.slice(0, MAX_SAMPLES_ID)
                        : float32Audio;

                    const inputs = await processor(idAudio);
                    const { embeddings } = await model(inputs);
                    const currentEmbedding = embeddings.data;

                    let scores = [];
                    for (const [name, savedEmbedding] of Object.entries(session.speakers)) {
                        const similarity = cos_sim(currentEmbedding, savedEmbedding);
                        scores.push({ name, similarity });
                    }
                    scores.sort((a, b) => b.similarity - a.similarity);

                    if (scores.length > 0) {
                        const best = scores[0];
                        const secondBest = scores[1] || { similarity: 0 };
                        console.log(`📊 DIAGNÓSTICO: ${scores.map(s => `${s.name}: ${(s.similarity*100).toFixed(1)}%`).join(' | ')}`);
                        if (best.similarity > 0.85 && (best.similarity - secondBest.similarity) > 0.05) {
                            identifiedSpeaker = best.name;
                        } else {
                            console.warn(`⚠️ INDECISO: Diferença muito pequena (${((best.similarity - secondBest.similarity)*100).toFixed(1)}%) ou confiança baixa.`);
                        }
                    }
                } catch (vErr) { console.error('Erro ID Voz:', vErr.message); }
            }

            // 2. Transcrição (ASR)
            const asr = await getTranscriber();
            const sourceLang = (source === 'mic') ? 'pt' : 'en';
            const output = await asr(float32Audio, {
                language: sourceLang,
                task: 'transcribe',
                num_beams: 3,
                repetition_penalty: 1.1
            });

            const originalText = output.text.trim();

            if (!originalText) {
                console.log(`📝 [${source.toUpperCase()}] Silêncio ou áudio não compreendido.`);
                return { original: '', translated: '', speaker: identifiedSpeaker, discarded: false };
            }
            console.log(`📝 [${source.toUpperCase()}] Transcrito: "${originalText}" -> Traduzindo...`);

            // 3. Tradução (NMT)
            const targetLang = (source === 'mic') ? 'en' : 'pt';
            let translatedText = '[Erro de Tradução]';
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const textUrlEncoded = encodeURIComponent(originalText);
                    const url = `https://translate.google.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${textUrlEncoded}`;
                    const fetchRes = await fetch(url, { signal: AbortSignal.timeout(10000) });
                    if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
                    const json = await fetchRes.json();
                    translatedText = json[0].map(item => item[0]).join('');
                    break; // Sucesso → sai do loop
                } catch (tErr) {
                    if (attempt < 3) {
                        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
                        console.warn(`⚠️ Falha na Tradução (tentativa ${attempt}/3): ${tErr.message}. Retentando em ${delay}ms...`);
                        await new Promise(r => setTimeout(r, delay));
                    } else {
                        console.error('⚠️ Falha na API de Tradução após 3 tentativas:', tErr.message);
                    }
                }
            }

            broadcastEvent(session.id, {
                type: 'translation',
                source,
                speaker: identifiedSpeaker,
                original: originalText,
                translated: translatedText,
                isPartial,
            });

            return { original: originalText, translated: translatedText, speaker: identifiedSpeaker, discarded: false };
            // ---- Fim do job ----
        }, { isPartial });
    } catch (err) {
        // Erros esperados da fila (overflow, timeout, drop)
        if (err.message === 'DROPPED_BY_FINAL' || err.message === 'QUEUE_OVERFLOW') {
            return res.json({ original: '', translated: '', speaker: 'SISTEMA', discarded: true });
        }
        if (err.message === 'JOB_TIMEOUT') {
            console.error(`⏱️ [QUEUE] Job expirou após ${transcriptionQueue.jobTimeoutMs}ms`);
            return res.status(503).json({ error: 'Transcrição demorou demais. Tente um trecho menor.' });
        }
        console.error('❌ Erro Crítico na Fila:', err.message);
        return res.status(200).json({
            original: 'ERRO DE SISTEMA',
            translated: 'Instabilidade detectada. Aguardando reconexão...',
            speaker: 'SISTEMA'
        });
    }

    // result === null significa parcial descartado pela fila (fila cheia)
    if (result === null) {
        return res.json({ original: '', translated: '', speaker: 'SISTEMA', discarded: true });
    }

    res.json(result);
});

app.get('/trigger', requireConversationOwnership, (req, res) => {
    broadcastEvent(req.session.id, { type: 'ptt_status', state: req.query.state === 'on' ? 'mic_on' : 'mic_off' });
    res.send("OK");
});

// --- FEEDBACK ANÔNIMO ---
app.use(express.json());
app.post('/api/feedback', (req, res) => {
    try {
        const { rating, category, message } = req.body;
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating inválido (1-5).' });
        }
        db.prepare(`INSERT INTO feedback (rating, category, message) VALUES (?, ?, ?)`)
          .run(rating || null, category || 'outro', message || '');
        console.log(`💬 [FEEDBACK] Rating: ${rating}/5 | Categoria: ${category} | "${message?.substring(0,50)}"`);
        res.json({ success: true });
    } catch (e) {
        console.error('[FEEDBACK] Erro ao salvar:', e.message);
        res.status(500).json({ error: 'Falha ao salvar feedback.' });
    }
});

// --- VER FEEDBACKS (rota admin simples) ---
app.get('/api/feedback', (req, res) => {
    const authHeader = req.headers.authorization?.trim();
    let adminKey = '';
    if (authHeader?.startsWith('Bearer ')) {
        adminKey = authHeader.slice(7).trim();
    }
    if (!adminKey || adminKey !== (process.env.ADMIN_KEY || 'overtalk-admin')) {
        return res.status(403).json({ error: 'Acesso negado.' });
    }
    const rows = db.prepare(`SELECT * FROM feedback ORDER BY created_at DESC LIMIT 100`).all();
    res.json(rows);
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta http://localhost:${PORT}`);
    
    // Inicia o túnel automaticamente para poder extrair a URL
    function startTunnel() {
        console.log(`⏳ Iniciando SSH Tunnel (localhost.run) em background...`);
        const cf = spawn('ssh', [
            '-R', `80:127.0.0.1:${PORT}`, 
            'nokey@localhost.run', 
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'ServerAliveInterval=60'
        ], { windowsHide: true });
        
        const handleTunnelData = async (d) => {
            const str = d.toString();
            if (str.includes('.lhr.life')) {
                const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.lhr\.life/);
                if (match) {
                    currentTunnelUrl = match[0];
                    process.env.PUBLIC_BACKEND_URL = currentTunnelUrl;
                    console.log(`\n🌐 ==============================================`);
                    console.log(`🌐 LINK PÚBLICO GERADO: ${currentTunnelUrl}/mobile`);
                    console.log(`🌐 ==============================================\n`);
                    
                    if (supabaseAdmin) {
                        try {
                            const { error } = await supabaseAdmin.from('config').update({ backend_url: currentTunnelUrl }).eq('id', 1);
                            if (!error) console.log(`✅ Supabase atualizado com o novo backend_url!`);
                            else console.error(`❌ Erro ao atualizar Supabase:`, error.message);
                        } catch (e) { console.error(`❌ Erro de conexão ao atualizar Supabase:`, e.message); }
                    }
                }
            }
        };
        
        cf.stdout.on('data', handleTunnelData);
        cf.stderr.on('data', handleTunnelData);

        cf.on('close', (code) => {
            console.error(`⚠️ SSH Tunnel fechou inesperadamente (código ${code}). Reiniciando em 5 segundos...`);
            setTimeout(startTunnel, 5000);
        });
    }

    startTunnel();
});
