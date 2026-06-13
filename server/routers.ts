import { z } from "zod";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { translate, translateInputSchema } from "./translate";
import { invokeLLM } from "./_core/llm";
import * as db from "./db";
import crypto from "crypto";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // Translation API
  translate: publicProcedure
    .input(translateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const result = translate(input.source, input.direction, input.options);

      // Save to database if authenticated
      const userId = ctx.user?.id || 0;
      const sourceHash = crypto.createHash("sha256").update(input.source).digest("hex").slice(0, 64);
      const translationId = await db.createTranslation({
        userId,
        direction: input.direction,
        sourceHash,
        sourceSizeBytes: Buffer.byteLength(input.source, "utf8"),
        sourceText: input.source,
        outputText: result.output,
        diagnosticsJson: JSON.stringify(result.diagnostics),
        mappingYaml: result.mappingYaml,
        translatedNodes: result.stats.translatedNodes,
        manualPortCount: result.stats.manualPortCount,
        warningCount: result.stats.warningCount,
      });

      return { ...result, translationId };
    }),

  // History
  history: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return db.getUserTranslations(ctx.user.id);
    }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input, ctx }) => {
        const t = await db.getTranslation(input.id);
        if (!t || t.userId !== ctx.user.id) return null;
        return t;
      }),
  }),

  // Validation (opt-in, post-hoc, advisory)
  validate: protectedProcedure
    .input(z.object({ translationId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      // Look up translation
      const translation = await db.getTranslation(input.translationId);
      if (!translation) {
        throw new Error("Translation not found");
      }
      if (translation.userId !== ctx.user.id) {
        throw new Error("Not authorized to validate this translation");
      }

      // Check monthly limit (5 for free tier)
      const monthCount = await db.getUserValidationCountThisMonth(ctx.user.id);
      if (monthCount >= 5) {
        return {
          ok: false,
          error_code: "VALIDATION_LIMIT",
          message: "Free tier limit: 5 validations per month. Upgrade for more.",
        };
      }

      // Build validation prompt
      const systemPrompt = `You are a validator for a deterministic PLC code translation tool. The user converted Allen-Bradley Studio 5000 Structured Text into Mitsubishi GX Works2 Structured Text using a rule-based compiler. Your job is to assess whether the translation preserves runtime semantics.

Conventions you must recognize:
- MANUAL_PORT comments indicate the compiler explicitly punted on untranslatable constructs (PID, PIDE, motion, MSG, etc.). These are not errors; they are honest markers for a human porting engineer.
- Provenance comments of the form // [AB→MEL] src: ... are metadata, not program logic. Ignore them.
- The compiler is the source of truth for syntactic translation. Your job is semantic preservation only.

Output strictly in this JSON shape:
{"verdict": "equivalent" | "concerns" | "cannot_determine", "concerns": [{"severity": "info" | "warn" | "error", "line": <integer>, "message": "<string>"}], "summary": "<one paragraph plain English>"}

Return JSON only. No markdown fences, no preamble.`;

      const userMessage = `AB Studio 5000 source:\n\n${translation.sourceText}\n\nMitsubishi GX Works2 output:\n\n${translation.outputText}`;

      try {
        const response = await invokeLLM({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        });

        const content = (response.choices?.[0]?.message?.content as string) || "";
        const tokensIn = response.usage?.prompt_tokens || 0;
        const tokensOut = response.usage?.completion_tokens || 0;

        // Parse JSON response
        let parsed: any;
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = { verdict: "cannot_determine", concerns: [], summary: content };
        }

        // Estimate cost (approximate for Haiku-class model)
        const costCents = Math.round((tokensIn * 0.00025 + tokensOut * 0.00125) * 100);

        // Save validation result
        await db.updateTranslationValidation(input.translationId, {
          validationVerdict: parsed.verdict || "cannot_determine",
          validationSummary: parsed.summary || "",
          validationConcernsJson: JSON.stringify(parsed.concerns || []),
          validationTokensIn: tokensIn,
          validationTokensOut: tokensOut,
          validationCostCents: costCents,
        });

        return {
          ok: true,
          verdict: parsed.verdict,
          concerns: parsed.concerns || [],
          summary: parsed.summary || "",
          costCents,
          tokensIn,
          tokensOut,
        };
      } catch (error: any) {
        return {
          ok: false,
          error_code: "VALIDATION_FAILED",
          message: error?.message || "Validation request failed",
        };
      }
    }),
});

export type AppRouter = typeof appRouter;
