import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db/client";

const config = loadConfig();
const database = createDb(config.DATABASE_URL);
const app = await buildApp({ logLevel: config.LOG_LEVEL, checkDatabase: database.ping });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(database.close)
      .finally(() => process.exit(0));
  });
}

await app.listen({ host: config.API_HOST, port: config.API_PORT });
