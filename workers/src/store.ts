import { DurableObject } from "cloudflare:workers";

/**
 * Coach-memory schema. 1 means the scaffold: schema_version only.
 * A later migration adds the real tables and updates this row.
 */
export const SCHEMA_VERSION = 1;

/** One object holds this single-user coach memory. */
export const COACH_STORE_NAME = "coach";

export class CoachStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          version INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(
        "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO NOTHING",
        SCHEMA_VERSION,
      );
    });
  }

  schemaVersion(): number {
    const row = this.ctx.storage.sql
      .exec<{ version: number }>("SELECT version FROM schema_version WHERE id = 1")
      .one();
    return row.version;
  }
}

export function coachStore(env: Env): DurableObjectStub<CoachStore> {
  return env.COACH_STORE.get(env.COACH_STORE.idFromName(COACH_STORE_NAME));
}
