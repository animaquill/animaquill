import { defineConfig } from "drizzle-kit";

/**
 * For writing migrations only: `pnpm --filter @animaquill/server db:generate` compares
 * src/schema.ts with the migrations in src/drizzle/ and writes the SQL for the difference. The
 * server applies them when it starts (src/database.ts). It never needs a database.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./src/drizzle",
});
