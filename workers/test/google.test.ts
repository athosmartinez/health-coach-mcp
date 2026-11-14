import { describe, expect, it } from "vitest";

import { isAllowedEmail, readIdToken } from "../src/google";
import { idToken } from "./helpers";

const CLIENT_ID = "client.apps.googleusercontent.com";
const NOW = Date.UTC(2026, 10, 14, 12);

const valid = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "123",
  email: "Owner@Example.com",
  email_verified: true,
  nonce: "n-1",
  exp: NOW / 1000 + 600,
};

describe("readIdToken", () => {
  it("reads a valid token", () => {
    expect(readIdToken(idToken(valid), CLIENT_ID, "n-1", NOW)).toEqual({
      sub: "123",
      email: "Owner@Example.com",
      emailVerified: true,
    });
    expect(readIdToken(idToken({ ...valid, iss: "accounts.google.com" }), CLIENT_ID, "n-1", NOW)).not.toBeNull();
  });

  it.each([
    { name: "another issuer", claims: { ...valid, iss: "https://evil.example" } },
    { name: "another audience", claims: { ...valid, aud: "other-client" } },
    { name: "a shared audience without azp", claims: { ...valid, aud: [CLIENT_ID, "other"] } },
    { name: "an expired token", claims: { ...valid, exp: NOW / 1000 - 1 } },
    { name: "another nonce", claims: { ...valid, nonce: "n-2" } },
    { name: "no nonce", claims: { ...valid, nonce: undefined } },
    { name: "no email", claims: { ...valid, email: undefined } },
    { name: "no sub", claims: { ...valid, sub: "" } },
  ])("rejects $name", ({ claims }) => {
    expect(readIdToken(idToken(claims), CLIENT_ID, "n-1", NOW)).toBeNull();
  });

  it.each(["", "a.b", "a.%%%.c", "a.bm90LWpzb24.c"])("rejects the malformed token %j", (token) => {
    expect(readIdToken(token, CLIENT_ID, "n-1", NOW)).toBeNull();
  });

  it("reports an unverified email as unverified", () => {
    expect(readIdToken(idToken({ ...valid, email_verified: "true" }), CLIENT_ID, "n-1", NOW)?.emailVerified).toBe(false);
  });
});

describe("isAllowedEmail", () => {
  it("matches ignoring case and surrounding space", () => {
    expect(isAllowedEmail("owner@example.com", " Owner@Example.COM ")).toBe(true);
  });

  it.each([
    { allowed: "owner@example.com", email: "owner@example.com.evil" },
    { allowed: "owner@example.com", email: "other@example.com" },
    { allowed: "", email: "" },
    { allowed: "  ", email: "  " },
    { allowed: undefined, email: "owner@example.com" },
    { allowed: "owner@example.com", email: undefined },
  ])("rejects $email when $allowed is allowed", ({ allowed, email }) => {
    expect(isAllowedEmail(allowed, email)).toBe(false);
  });
});
