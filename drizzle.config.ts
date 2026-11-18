import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.OWNER_DATABASE_URL ?? "postgres://owner:owner@localhost:5433/funil",
  },
});
