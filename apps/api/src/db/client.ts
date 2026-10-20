import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });

  async function ping(): Promise<boolean> {
    await db.execute(sql`select 1`);
    return true;
  }

  return { db, ping, close: () => client.end({ timeout: 5 }) };
}

export type Database = ReturnType<typeof createDb>["db"];
