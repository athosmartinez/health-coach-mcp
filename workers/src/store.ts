import { type StatelessMcpHandler, createMcpHandler } from "agents/mcp/server";
import { DurableObject } from "cloudflare:workers";

import type { Zone } from "./coach/date";
import { INTERNAL_ERROR } from "./coach/errors";
import { timeZone } from "./config";
import { type GoogleErrorCode, missingHealthScopes, refreshAccessToken, splitScopes } from "./google";
import { RequestBudget } from "./googlehealth/budget";
import { GoogleHealthClient } from "./googlehealth/client";
import { RequestTokens } from "./googlehealth/tokens";
import { HealthData, dbCache } from "./healthdata";
import { MCP_PATH, createServer } from "./mcp";
import { Db } from "./store/db";
import { forgetEntry, hasEntry, recordEntry } from "./store/entries";
import { targetInForce } from "./store/memory";
import { searchNotes } from "./store/notes";
import type { CoachDeps } from "./tools/coach";
import { type WriteDeps, runWriteTool } from "./tools/foodlog";
import { runMemoryTool } from "./tools/memory";
import { runCoachTool } from "./tools/moments";
import type { ToolOutcome } from "./tools/register";

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
  // 3: the coach memory, with the columns, checks and collations of the Go
  // server's store. Dates are YYYY-MM-DD local days; timestamps are fixed-width
  // RFC 3339 UTC text (9 fractional digits).
  `CREATE TABLE profile (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    birth_date  TEXT, sex TEXT, height_cm REAL,
    goal_json   TEXT,          -- {type, target_weight_kg, target_body_fat_pct, deadline}
    plan_json   TEXT,          -- {split, notes}; the weekly target lives only in targets
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE targets (
    effective_from  TEXT PRIMARY KEY,
    kcal            INTEGER, protein_g INTEGER, weekly_sessions INTEGER,
    created_at      TEXT NOT NULL
  );

  CREATE TABLE health_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('condition','medication','supplement','injury','allergy','restriction')),
    name TEXT NOT NULL COLLATE NOCASE,   -- "Knee" and "knee" are the same item
    status TEXT NOT NULL CHECK (status IN ('active','resolved','paused')),
    details TEXT, started_on TEXT, ended_on TEXT, updated_at TEXT NOT NULL,
    UNIQUE (kind, name)
  );

  CREATE TABLE lab_results (
    id INTEGER PRIMARY KEY,
    collected_on TEXT NOT NULL, lab TEXT,
    analyte TEXT NOT NULL,     -- normalized name: ldl, hdl, hba1c, glucose_fasting
    value REAL NOT NULL, unit TEXT NOT NULL, ref_low REAL, ref_high REAL,
    source TEXT NOT NULL CHECK (source IN ('pdf','chat','file')),
    created_at TEXT NOT NULL,
    -- The range as printed, so a flag can be audited and "< 5.7" style bounds
    -- are not treated as inclusive.
    ref_low_exclusive  INTEGER NOT NULL DEFAULT 0 CHECK (ref_low_exclusive IN (0, 1)),
    ref_high_exclusive INTEGER NOT NULL DEFAULT 0 CHECK (ref_high_exclusive IN (0, 1)),
    ref_text    TEXT,
    report_flag TEXT,          -- the lab's own mark: H, L, crítico, *
    UNIQUE (collected_on, analyte)
  );

  CREATE TABLE preferences (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused: ids order notes and key the FTS index
    kind TEXT NOT NULL CHECK (kind IN ('insight','decision','checkin','symptom')),
    text TEXT NOT NULL,
    tags TEXT,                 -- JSON array of strings
    related_date TEXT, created_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE notes_fts USING fts5(text, content='notes', content_rowid='id');
  -- An external-content FTS5 index is only populated through triggers.
  CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END;
  CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
  CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO notes_fts(rowid, text) VALUES (new.id, new.text); END;`,
  // 4: the cache of daily values computed from Google Health records, with the
  // Go store's final columns in its order. The cache is disposable. `zone` is
  // the IANA zone a value was computed in: sleep start minutes and the day a
  // night belongs to depend on it, so a row from another zone is a miss.
  //
  // The index is the Worker's own (the Go store has none). Every cache read
  // is one metric over a range of days. The primary key starts with the date,
  // so without the index such a read scans the rows of all the metrics of
  // those days, and rows read are a daily quota of the plan.
  `CREATE TABLE daily_metrics (
    date TEXT NOT NULL, metric TEXT NOT NULL,   -- metric from the closed list in store/metrics.ts
    value REAL NOT NULL, n_samples INTEGER, source TEXT,
    algo_version INTEGER NOT NULL,              -- bump when the derivation changes
    fetched_at TEXT NOT NULL,
    zone TEXT,
    PRIMARY KEY (date, metric)
  );
  CREATE INDEX daily_metrics_by_metric ON daily_metrics (metric, date)`,
  // 5: the food entries this server created in Google Health (the Go server
  // writes nothing there, so its store has no such table). A row proves that
  // an entry is this server's own: only such an entry is deleted. It holds no
  // food name and no nutrient value. `name` is the data point name as the
  // create answered it; `day` is the local day of the entry, and the index
  // serves the lookup of the entries of a range of days.
  `CREATE TABLE nutrition_entries (
    name TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX nutrition_entries_by_day ON nutrition_entries (day)`,
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
  /** Serves MCP inside this object. An instance property, so it is not an RPC method. */
  private readonly mcp: StatelessMcpHandler;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new Db(ctx.storage);
    const zoneOrError = (): Zone | undefined => {
      try {
        return timeZone(this.env);
      } catch {
        // The Go server refuses to start with a bad HCM_TZ. A Worker has no
        // start, so every tool that needs the zone fails instead of using a
        // zone nobody chose.
        console.error("config_error", { variable: "HCM_TZ" });
        return undefined;
      }
    };
    const memory = (name: string, args: Record<string, unknown>): ToolOutcome => {
      const zone = zoneOrError();
      return zone ? runMemoryTool({ db, zone }, name, args) : { ok: false, error: INTERNAL_ERROR };
    };
    // createMcpHandler calls this factory once per MCP HTTP request, also for
    // a JSON-RPC batch of several tool calls. So what it creates is what one
    // request may spend on Google (Workers Free: 50 subrequests): one request
    // budget for the Google Health API, and one access token answer.
    const server = () => {
      const tokens = new RequestTokens({
        accessToken: () => this.googleAccessToken(),
        invalidate: (rejected) => this.invalidateGoogleAccessToken(rejected),
      });
      const budget = new RequestBudget();
      // One client for the reads and the writes of this MCP HTTP request:
      // every request to Google Health takes its unit from the one budget.
      let client: GoogleHealthClient | undefined;
      const clientIn = (zone: Zone) => (client ??= new GoogleHealthClient({ tokens, zone, budget }));
      let coachDeps: CoachDeps | undefined;
      const newCoachDeps = (): CoachDeps | undefined => {
        const zone = zoneOrError();
        if (!zone) return undefined;
        return {
          health: new HealthData(clientIn(zone), dbCache(db), zone, db.now),
          targets: (day) => targetInForce(db, day),
          notes: (filter) => searchNotes(db, filter),
          now: db.now,
          zone,
        };
      };
      let writeDeps: WriteDeps | undefined;
      const newWriteDeps = (): WriteDeps | undefined => {
        const zone = zoneOrError();
        if (!zone) return undefined;
        return {
          api: clientIn(zone),
          entries: {
            record: (name, day) => recordEntry(db, name, day),
            has: (name) => hasEntry(db, name),
            forget: (name) => forgetEntry(db, name),
          },
          now: db.now,
          zone,
        };
      };
      // The tool calls of a batch start together. The tools that reach Google
      // take turns, so the Google requests of one MCP request run one after
      // the other, and a later call finds in the cache what an earlier one
      // fetched. A write takes its turn like a read: two adds of one batch
      // never run at the same time.
      //
      // The queue belongs to this MCP HTTP request. The object does not order
      // two MCP HTTP requests: while one waits for Google, it serves the
      // other, which has a budget and a token answer of its own. They can
      // fetch the same window twice, and their memory adds up. One queue for
      // the whole object would order them, but a request that stops while it
      // holds the turn would then block every later request.
      let turn: Promise<unknown> = Promise.resolve();
      const inTurn = (run: () => ToolOutcome | Promise<ToolOutcome>): Promise<ToolOutcome> => {
        const outcome = turn.then((): ToolOutcome | Promise<ToolOutcome> => {
          // From here on, the units already taken are those of earlier calls.
          budget.beginCall();
          return run();
        });
        turn = outcome.catch(() => undefined);
        return outcome;
      };
      const coach = (name: string, args: Record<string, unknown>): Promise<ToolOutcome> =>
        inTurn(() => {
          coachDeps ??= newCoachDeps();
          return coachDeps ? runCoachTool(coachDeps, name, args) : { ok: false, error: INTERNAL_ERROR };
        });
      const write = (name: string, args: Record<string, unknown>): Promise<ToolOutcome> =>
        inTurn(() => {
          writeDeps ??= newWriteDeps();
          return writeDeps ? runWriteTool(writeDeps, name, args) : { ok: false, error: INTERNAL_ERROR };
        });
      return createServer({
        memory,
        coach,
        write,
        googleAccountStatus: async () => this.accountStatus(await tokens.accessToken()),
      });
    };
    this.mcp = createMcpHandler(server, { route: MCP_PATH });
    ctx.blockConcurrencyWhile(async () => {
      migrate(this.ctx.storage);
    });
  }

  /**
   * Serves one MCP request, whole: parsing, the argument check, the tool body,
   * the log line and the result serialization all run here, next to the data.
   * The Worker isolate has 10 ms of CPU per request on the Free plan, and that
   * work grows with the size of the arguments and of the result.
   *
   * Only the Worker calls this, through its stub, after OAuth and the
   * allowlist check; the request it forwards carries no access token. Any
   * other path is 404.
   */
  async fetch(request: Request): Promise<Response> {
    return this.mcp.fetch(request);
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
    let result = notLinked();
    // A second pass only when a sign-in replaced the link during the renewal.
    for (let pass = 0; pass < 2; pass++) {
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
      result = await this.refreshing;
      // Answer for the link stored now, not for one replaced while Google answered.
      // A missing row means this renewal removed a revoked link: keep its error.
      const current = this.account();
      const sameLink = current?.refresh_token === row.refresh_token;
      const ownRotation = result.ok && current?.access_token === result.accessToken;
      if (!current || sameLink || ownRotation) return result;
    }
    return result;
  }

  /**
   * Marks the access token that Google rejected as expired, so the next
   * googleAccessToken() renews it even when its stored expiry is still ahead
   * (revoked, or expired at Google a moment before it expires here). A
   * rejection of a token that was already replaced is ignored: requests that
   * saw the same 401 share one renewal. Returns whether the token was marked.
   */
  invalidateGoogleAccessToken(rejected: string): boolean {
    if (rejected === "") return false;
    const marked = this.ctx.storage.sql.exec(
      "UPDATE google_account SET access_token_expires_at = 0 WHERE id = 1 AND access_token = ?",
      rejected,
    );
    return marked.rowsWritten > 0;
  }

  /** The link without any token; checks (and if needed renews) the access token. */
  async googleAccountStatus(): Promise<GoogleAccountStatus> {
    return this.accountStatus(await this.googleAccessToken());
  }

  /** The link without any token, with the outcome of an access token check that was already made. */
  private accountStatus(token: { ok: true } | { ok: false; code: AccessTokenErrorCode }): GoogleAccountStatus {
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
