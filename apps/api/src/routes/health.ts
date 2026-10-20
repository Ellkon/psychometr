import { healthResponseSchema, readinessResponseSchema } from "@kompas/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

interface HealthRoutesOptions {
  checkDatabase: () => Promise<boolean>;
}

export const healthRoutes: FastifyPluginAsyncZod<HealthRoutesOptions> = (app, options) => {
  app.get("/health", { schema: { response: { 200: healthResponseSchema } } }, () => ({
    status: "ok" as const,
  }));

  app.get(
    "/ready",
    { schema: { response: { 200: readinessResponseSchema, 503: readinessResponseSchema } } },
    async (_request, reply) => {
      const databaseOk = await options.checkDatabase().catch(() => false);
      const status = databaseOk ? ("ok" as const) : ("unavailable" as const);
      return reply.code(databaseOk ? 200 : 503).send({ status, checks: { database: status } });
    },
  );
  return Promise.resolve();
};
