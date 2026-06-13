import { int, mysqlEnum, mysqlTable, text, mediumtext, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
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
// sourceText and outputText use MEDIUMTEXT (16 MB) to handle large industrial routines
export const translations = mysqlTable("translations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  direction: varchar("direction", { length: 10 }).notNull(),
  sourceHash: varchar("sourceHash", { length: 64 }).notNull(),
  sourceSizeBytes: int("sourceSizeBytes"),
  sourceText: mediumtext("sourceText"),
  outputText: mediumtext("outputText"),
  diagnosticsJson: mediumtext("diagnosticsJson"),
  mappingYaml: mediumtext("mappingYaml"),
  translatedNodes: int("translatedNodes").default(0),
  manualPortCount: int("manualPortCount").default(0),
  warningCount: int("warningCount").default(0),
  validationVerdict: varchar("validationVerdict", { length: 32 }),
  validationSummary: mediumtext("validationSummary"),
  validationConcernsJson: mediumtext("validationConcernsJson"),
  validationTokensIn: int("validationTokensIn"),
  validationTokensOut: int("validationTokensOut"),
  validationCostCents: int("validationCostCents"),
  validatedAt: timestamp("validatedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Translation = typeof translations.$inferSelect;
export type InsertTranslation = typeof translations.$inferInsert;
