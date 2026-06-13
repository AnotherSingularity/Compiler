import { eq, desc, and, gte, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import { users, translations, type InsertUser, type InsertTranslation } from "../drizzle/schema";

// Database connection singleton
let dbInstance: ReturnType<typeof drizzle> | null = null;

async function getDb() {
  if (dbInstance) return dbInstance;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const pool = mysql.createPool({ uri: url });
    dbInstance = drizzle(pool);
    return dbInstance;
  } catch {
    return null;
  }
}

// === User functions (required by _core/sdk.ts and _core/oauth.ts) ===

export async function upsertUser(data: Partial<InsertUser> & { openId: string }) {
  const db = await getDb();
  if (!db) return;
  const existing = await db.select().from(users).where(eq(users.openId, data.openId));
  if (existing.length > 0) {
    await db.update(users).set({
      ...(data.name !== undefined && { name: data.name }),
      ...(data.email !== undefined && { email: data.email }),
      ...(data.loginMethod !== undefined && { loginMethod: data.loginMethod }),
      ...(data.lastSignedIn !== undefined && { lastSignedIn: data.lastSignedIn }),
    }).where(eq(users.openId, data.openId));
  } else {
    await db.insert(users).values({
      openId: data.openId,
      name: data.name || null,
      email: data.email || null,
      loginMethod: data.loginMethod || null,
      lastSignedIn: data.lastSignedIn || new Date(),
    });
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(users).where(eq(users.openId, openId));
  return rows[0] || null;
}

// === Translation functions ===

export async function createTranslation(data: InsertTranslation): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  const result = await db.insert(translations).values(data);
  return result[0].insertId;
}

export async function getTranslation(id: number) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(translations).where(eq(translations.id, id));
  return rows[0] || null;
}

export async function getUserTranslations(userId: number, limit = 50) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(translations)
    .where(eq(translations.userId, userId))
    .orderBy(desc(translations.createdAt))
    .limit(limit);
}

export async function updateTranslationValidation(id: number, data: {
  validationVerdict: string;
  validationSummary: string;
  validationConcernsJson: string;
  validationTokensIn: number;
  validationTokensOut: number;
  validationCostCents: number;
}) {
  const db = await getDb();
  if (!db) return;
  await db.update(translations).set({
    ...data,
    validatedAt: new Date(),
  }).where(eq(translations.id, id));
}

export async function getUserValidationCountThisMonth(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const rows = await db.select().from(translations)
    .where(and(
      eq(translations.userId, userId),
      isNotNull(translations.validatedAt),
      gte(translations.validatedAt!, startOfMonth)
    ));
  return rows.length;
}

export async function deleteUserTranslations(userId: number) {
  const db = await getDb();
  if (!db) return;
  await db.delete(translations).where(eq(translations.userId, userId));
}
