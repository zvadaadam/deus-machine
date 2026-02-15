/**
 * Re-export from the single source of truth.
 * esbuild resolves this relative path at bundle time.
 * @see shared/schema.ts
 */
export { SCHEMA_SQL, V2_MIGRATIONS, V2_BACKFILL_SEQ } from "../../shared/schema";
