import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRuntimeConfig } from '../config/runtimeConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.join(__dirname, 'overtalk.db');
const db = new Database(dbPath);
const runtimeConfig = getRuntimeConfig();
const FREE_LIMIT = runtimeConfig.rateLimits.maxDailySessions;

// --- DEFINIÇÃO DOS PLANOS ---
export const PLANS = {
  free: {
    key: 'free',
    name: 'Grátis',
    price: 0,
    minutesPerMonth: 30,
    languages: 1,
    storageMB: 10,
    canExport: true,
    maxDailySessions: FREE_LIMIT,
    features: ['Acesso ao Discord'],
  },
  profissional: {
    key: 'profissional',
    name: 'Profissional',
    price: 5,
    minutesPerMonth: 500,
    languages: 2,
    storageMB: 100,
    canExport: true,
    maxDailySessions: Infinity,
    features: ['Prioridade de processamento', 'Suporte via e-mail'],
  },
  poweruser: {
    key: 'poweruser',
    name: 'Power User',
    price: 10,
    minutesPerMonth: Infinity,
    languages: Infinity,
    storageMB: 500,
    canExport: true,
    maxDailySessions: Infinity,
    features: ['IA de voz alta fidelidade', 'Tradução multi-idiomas', 'Suporte 24/7'],
  },
  corporate: {
    key: 'corporate',
    name: 'Corporate',
    price: 15,
    minutesPerMonth: Infinity,
    languages: Infinity,
    storageMB: 2000,
    canExport: true,
    maxDailySessions: Infinity,
    features: ['Dialetos ilimitados', 'Criptografia de ponta a ponta', 'Painel administrativo', 'Gerente de conta dedicado'],
  },
};

// Inicialização das tabelas
const initDb = () => {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT UNIQUE,
                tier TEXT DEFAULT 'free',
                minutes_used REAL DEFAULT 0,
                storage_used REAL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT,
                start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
                duration INTEGER DEFAULT 0,
                FOREIGN KEY (user_id) REFERENCES users(id)
            );
        `);
        db.exec(`
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                rating INTEGER,
                category TEXT,
                message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // Migração: adicionar colunas novas se não existirem (tabela já criada)
        try { db.exec(`ALTER TABLE users ADD COLUMN minutes_used REAL DEFAULT 0`); } catch (e) {}
        try { db.exec(`ALTER TABLE users ADD COLUMN storage_used REAL DEFAULT 0`); } catch (e) {}
        db.exec(`
            CREATE TABLE IF NOT EXISTS pending_transactions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                tier TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log("[DB] Banco de dados (SQLite) inicializado com sucesso.");
    } catch (error) {
        console.error("[DB] Falha ao inicializar o banco de dados:", error);
    }
};

initDb();

// --- LIMITE DE SESSÕES POR DIA ---
export function getSessionsToday(userId) {
    const row = db.prepare(`
        SELECT COUNT(*) as count FROM sessions
        WHERE user_id = ? AND DATE(start_time) = DATE('now')
    `).get(userId);
    return row?.count || 0;
}

export function canStartSession(userId, tier) {
    if (tier === 'pro' || tier === 'business') return true;
    return getSessionsToday(userId) < FREE_LIMIT;
}

export function startSession(userId) {
    return db.prepare(`INSERT INTO sessions (user_id) VALUES (?)`).run(userId).lastInsertRowid;
}

export function getUserInfo(userId) {
    return db.prepare(`SELECT id, email, tier, minutes_used, storage_used, created_at FROM users WHERE id = ?`).get(userId);
}

// --- SISTEMA DE PLANOS ---
export function getPlanDefinition(tierKey) {
  return PLANS[tierKey] || PLANS.free;
}

export function getUserPlan(userId) {
  const user = getUserInfo(userId);
  if (!user) return null;
  const plan = getPlanDefinition(user.tier);
  return {
    tier: user.tier,
    plan,
    usage: {
      minutesUsed: user.minutes_used || 0,
      storageUsed: user.storage_used || 0,
      sessionsToday: getSessionsToday(userId),
    },
    limits: {
      minutesPerMonth: plan.minutesPerMonth,
      storageMB: plan.storageMB,
      maxDailySessions: plan.maxDailySessions,
    },
    memberSince: user.created_at,
  };
}

export function checkLimit(userId, resource) {
  const user = getUserInfo(userId);
  if (!user) return { allowed: false, reason: 'Usuário não encontrado' };
  const plan = getPlanDefinition(user.tier);

  switch (resource) {
    case 'minutes':
      if (plan.minutesPerMonth === Infinity) return { allowed: true };
      const minutesLeft = plan.minutesPerMonth - (user.minutes_used || 0);
      return {
        allowed: minutesLeft > 0,
        remaining: Math.max(0, minutesLeft),
        limit: plan.minutesPerMonth,
        used: user.minutes_used || 0,
      };
    case 'storage':
      if (plan.storageMB === Infinity) return { allowed: true };
      const storageLeft = plan.storageMB - (user.storage_used || 0);
      return {
        allowed: storageLeft > 0,
        remaining: Math.max(0, storageLeft),
        limit: plan.storageMB,
        used: user.storage_used || 0,
      };
    default:
      return { allowed: true };
  }
}

export function addMinutesUsed(userId, minutes) {
  db.prepare(`UPDATE users SET minutes_used = minutes_used + ? WHERE id = ?`).run(minutes, userId);
}

export function addStorageUsed(userId, mb) {
  db.prepare(`UPDATE users SET storage_used = storage_used + ? WHERE id = ?`).run(mb, userId);
}

export function upgradeUserTier(userId, newTier) {
  if (!PLANS[newTier]) throw new Error(`Plano "${newTier}" não existe`);
  db.prepare(`UPDATE users SET tier = ? WHERE id = ?`).run(newTier, userId);
  return getUserPlan(userId);
}

// --- MERCADO PAGO: PENDING TRANSACTIONS ---
export function createPendingTransaction(id, userId, tier) {
  db.prepare(`INSERT OR IGNORE INTO pending_transactions (id, user_id, tier) VALUES (?, ?, ?)`).run(id, userId, tier);
}

export function getPendingTransaction(id) {
  return db.prepare(`SELECT * FROM pending_transactions WHERE id = ?`).get(id);
}

export function updatePendingStatus(id, status) {
  db.prepare(`UPDATE pending_transactions SET status = ? WHERE id = ?`).run(status, id);
}

export default db;
