import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { loggerOptions } from "./logger";
import { healthRoutes } from "./routes/health";

export interface AppOptions {
  logLevel: string;
  checkDatabase: () => Promise<boolean>;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: loggerOptions(options.logLevel),
    // Trust exactly one hop (Caddy) so clients cannot spoof X-Forwarded-For.
    trustProxy: (_address, hop) => hop === 0,
    bodyLimit: 256 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  await app.register(healthRoutes, { prefix: "/api", checkDatabase: options.checkDatabase });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
