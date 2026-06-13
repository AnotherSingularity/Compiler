import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Translations table — stores compiled outputs and validation results
export const translations = mysqlTable("translations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  direction: varchar("direction", { length: 10 }).notNull(), // 'ab2mel' | 'mel2ab'
  sourceHash: varchar("sourceHash", { length: 64 }).notNull(),
  sourceSizeBytes: int("sourceSizeBytes"),
  sourceText: text("sourceText"),
  outputText: text("outputText"),
  diagnosticsJson: text("diagnosticsJson"),
  mappingYaml: text("mappingYaml"),
  translatedNodes: int("translatedNodes").default(0),
  manualPortCount: int("manualPortCount").default(0),
  warningCount: int("warningCount").default(0),
  // Validation columns (nullable until validation runs)
  validationVerdict: varchar("validationVerdict", { length: 32 }), // 'equivalent' | 'concerns' | 'cannot_determine'
  validationSummary: text("validationSummary"),
  validationConcernsJson: text("validationConcernsJson"),
  validationTokensIn: int("validationTokensIn"),
  validationTokensOut: int("validationTokensOut"),
  validationCostCents: int("validationCostCents"),
  validatedAt: timestamp("validatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Translation = typeof translations.$inferSelect;
export type InsertTranslation = typeof translations.$inferInsert;
