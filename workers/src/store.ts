import { DurableObject } from "cloudflare:workers";

import { type GoogleErrorCode, missingHealthScopes, refreshAccessToken, splitScopes } from "./google";

/**
 * Schema migrations, applied in order. Entry N moves the schema to version
 * N + 1. Never edit an applied entry: add a new one.
 */
const MIGRATIONS: readonly string[] = [
  // 1: the scaffold, schema_version only (created before any migration runs).
  "",
  // 2: the linked Google account. One row: this is a single-user server.
  // refresh_token never leaves this object; access_token is a cache.
  // Times are epoch milliseconds.
  `CREATE TABLE google_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sub TEXT NOT NULL,
    email TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    scopes TEXT NOT NULL,
    access_token TEXT,
    access_token_expires_at INTEGER,
    linked_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** One object holds this single-user coach memory. */
export const COACH_STORE_NAME = "coach";

/** A cached access token is renewed when it has less than this left. */
export const ACCESS_TOKEN_MARGIN_MS = 60_000;

/** Brings the object's schema to SCHEMA_VERSION; each step commits with its version. */
export function migrate(storage: DurableObjectStorage): void {
  const sql = storage.sql;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    )
  `);
  const row = sql.exec<{ version: number }>("SELECT version FROM schema_version WHERE id = 1").toArray()[0];
  // No row: a new object. The v1 scaffold wrote version 1 and nothing else.
  let version = row?.version ?? 0;
  while (version < MIGRATIONS.length) {
    const next = version + 1;
    const statement = MIGRATIONS[version] ?? "";
    storage.transactionSync(() => {
      if (statement !== "") sql.exec(statement);
      sql.exec(
        "INSERT INTO schema_version (id, version) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version",
        next,
      );
    });
    version = next;
  }
}

export interface GoogleLink {
  sub: string;
  email: string;
  refreshToken: string;
  accessToken: string;
  /** Epoch milliseconds. */
  accessTokenExpiresAt: number;
  /** Space-separated, as Google granted them. */
  scopes: string;
}

/** `not_linked`: no account yet, or Google revoked it and the row was removed. */
export type AccessTokenErrorCode = GoogleErrorCode | "not_linked";

/**
 * Result of {@link CoachStore.googleAccessToken}. A result rather than a throw:
 * errors crossing Durable Object RPC lose their type and fields.
 */
export type AccessTokenResult =
  | { ok: true; accessToken: string; expiresAt: number }
  | { ok: false; code: AccessTokenErrorCode; message: string };

export type TokenState = "ok" | AccessTokenErrorCode;

export interface GoogleAccountStatus {
  linked: boolean;
  email: string | null;
  /** ISO 8601, UTC. */
  linkedAt: string | null;
  scopesGranted: string[];
  scopesMissing: string[];
  token: TokenState;
}

interface AccountRow {
  sub: string;
  email: string;
  refresh_token: string;
  scopes: string;
  access_token: string | null;
  access_token_expires_at: number | null;
  linked_at: number;
  [key: string]: SqlStorageValue;
}

export class CoachStore extends DurableObject<Env> {
  /** One renewal at a time: concurrent callers share it. */
  private refreshing: Promise<AccessTokenResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.ctx.storage);
    });
  }

  schemaVersion(): number {
    const row = this.ctx.storage.sql
      .exec<{ version: number }>("SELECT version FROM schema_version WHERE id = 1")
      .one();
    return row.version;
  }

  /** Stores the account that just signed in, replacing any earlier link. */
  linkGoogleAccount(link: GoogleLink): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO google_account
         (id, sub, email, refresh_token, scopes, access_token, access_token_expires_at, linked_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         sub = excluded.sub, email = excluded.email, refresh_token = excluded.refresh_token,
         scopes = excluded.scopes, access_token = excluded.access_token,
         access_token_expires_at = excluded.access_token_expires_at,
         linked_at = excluded.linked_at, updated_at = excluded.updated_at`,
      link.sub,
      link.email,
      link.refreshToken,
      link.scopes,
      link.accessToken,
      link.accessTokenExpiresAt,
      now,
      now,
    );
  }

  /**
   * A Google access token valid for at least ACCESS_TOKEN_MARGIN_MS, renewed
   * with the stored refresh token when needed. For tools that call Google;
   * never put the token in tool output or logs.
   */
  async googleAccessToken(): Promise<AccessTokenResult> {
    const row = this.account();
    if (!row) return notLinked();
    if (row.access_token && row.access_token_expires_at !== null) {
      if (row.access_token_expires_at - ACCESS_TOKEN_MARGIN_MS > Date.now()) {
        return { ok: true, accessToken: row.access_token, expiresAt: row.access_token_expires_at };
      }
    }
    if (!this.refreshing) {
      this.refreshing = this.refresh(row.refresh_token).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /** The link without any token; checks (and if needed renews) the access token. */
  async googleAccountStatus(): Promise<GoogleAccountStatus> {
    const token = await this.googleAccessToken();
    // Read after the check: a revoked link is removed by it.
    const row = this.account();
    if (!row) {
      return {
        linked: false,
        email: null,
        linkedAt: null,
        scopesGranted: [],
        scopesMissing: missingHealthScopes([]),
        token: token.ok ? "not_linked" : token.code,
      };
    }
    const granted = splitScopes(row.scopes);
    return {
      linked: true,
      email: row.email,
      linkedAt: new Date(row.linked_at).toISOString(),
      scopesGranted: granted,
      scopesMissing: missingHealthScopes(granted),
      token: token.ok ? "ok" : token.code,
    };
  }

  private account(): AccountRow | undefined {
    return this.ctx.storage.sql
      .exec<AccountRow>(
        `SELECT sub, email, refresh_token, scopes, access_token, access_token_expires_at, linked_at
         FROM google_account WHERE id = 1`,
      )
      .toArray()[0];
  }

  private async refresh(refreshToken: string): Promise<AccessTokenResult> {
    const result = await refreshAccessToken(
      { clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET },
      refreshToken,
    );
    // Every write is guarded by the refresh token used: a sign-in that replaced
    // the link while this request was in flight wins.
    if (!result.ok) {
      if (result.code === "auth_expired") {
        this.ctx.storage.sql.exec("DELETE FROM google_account WHERE id = 1 AND refresh_token = ?", refreshToken);
      }
      return { ok: false, code: result.code, message: result.message };
    }
    this.ctx.storage.sql.exec(
      `UPDATE google_account SET
         access_token = ?, access_token_expires_at = ?,
         refresh_token = COALESCE(?, refresh_token), scopes = COALESCE(?, scopes), updated_at = ?
       WHERE id = 1 AND refresh_token = ?`,
      result.accessToken,
      result.expiresAt,
      result.refreshToken ?? null,
      result.scope ?? null,
      Date.now(),
      refreshToken,
    );
    return { ok: true, accessToken: result.accessToken, expiresAt: result.expiresAt };
  }
}

function notLinked(): AccessTokenResult {
  return { ok: false, code: "not_linked", message: "no Google account is linked" };
}

export function coachStore(env: Env): DurableObjectStub<CoachStore> {
  return env.COACH_STORE.get(env.COACH_STORE.idFromName(COACH_STORE_NAME));
}
