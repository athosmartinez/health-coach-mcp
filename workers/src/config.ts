// Runtime settings from the Worker's variables (Go: internal/config).

import { Zone } from "./coach/date";

export const DEFAULT_TIME_ZONE = "America/Sao_Paulo";

/** A setting that cannot be used. The message names the variable and its rule, never a secret. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// An IANA name: letters, digits and _ + - in parts separated by "/". Intl also
// takes UTC offsets such as "+03:00", which are not zones.
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/**
 * The zone that defines what a "day" means. Empty or unset means the default.
 * "Local" is rejected: the meaning of a day must not depend on the host.
 */
export function loadZone(name: string | undefined): Zone {
  if (name === undefined || name === "") name = DEFAULT_TIME_ZONE;
  if (name.trim().toLowerCase() === "local") {
    throw new ConfigError(`HCM_TZ: use an IANA zone such as ${DEFAULT_TIME_ZONE}, not the host zone`);
  }
  if (!IANA_NAME.test(name)) throw new ConfigError("HCM_TZ: not an IANA time zone name");
  try {
    return new Zone(name);
  } catch {
    throw new ConfigError("HCM_TZ: unknown time zone");
  }
}

let cached: { name: string | undefined; zone: Zone } | undefined;

/** {@link loadZone} for the Worker's HCM_TZ, built once per isolate. */
export function timeZone(env: { HCM_TZ?: string }): Zone {
  if (!cached || cached.name !== env.HCM_TZ) cached = { name: env.HCM_TZ, zone: loadZone(env.HCM_TZ) };
  return cached.zone;
}
