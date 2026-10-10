/**
 * Phase B4 — auth route tests (MOCKED storage: in-memory fake DB; real
 * bcryptjs hashing and real token generation/hashing).
 * The live suite (integration.test.ts, same folder) repeats these flows
 * against the real mailxp_dev database and is clearly labelled as live.
 *
 * Covers the phase_b4 §9 minimum: registration validation/success/409/
 * hash-not-plaintext; uniform 401s; session opacity + hash-only storage;
 * cookie flags + production Secure + rotation; logout revocation; verification
 * token invalid/expired/consumed/replay; resend/forgot always-202; reset
 * expiry/single-use/revokes-all; password policy; Origin rejection on every
 * mutation; all four rate classes; secrets never in logs/responses;
 * request-ID propagation; production devDelivery suppression.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "@/lib/server/fakeDb";
import { hashSessionToken } from "@/lib/server/session";
import { hashAuthToken } from "@/lib/server/tokens";

vi.mock("@/lib/server/prisma", () => ({ getDb: vi.fn() }));

import { getDb } from "@/lib/server/prisma";
import { POST as loginPOST } from "./login/route";
import { POST as logoutPOST } from "./logout/route";
import { POST as forgotPOST } from "./password/forgot/route";
import { POST as resetPOST } from "./password/reset/route";
import { POST as registerPOST } from "./register/route";
import { POST as resendPOST } from "./resend-verification/route";
import { POST as verifyPOST } from "./verify-email/route";

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/v1`;
const VALID_PW = "a-very-good-passphrase";

let fake: FakeDb;
let ipSeq = 0;
const getDbMock = vi.mocked(getDb);

beforeEach(() => {
  fake = createFakeDb();
  getDbMock.mockReset();
  getDbMock.mockReturnValue(fake.client);
  ipSeq += 1;
});

function nextIp(): string {
  ipSeq += 1;
  return `10.7.${Math.floor(ipSeq / 250)}.${ipSeq % 250}`;
}

interface PostOpts {
  ip?: string;
  origin?: string | null;
  cookie?: string;
  requestId?: string;
}

function post(path: string, body: unknown, opts: PostOpts = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, {
    method: "POST",
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

function setCookieOf(response: Response): string {
  const raw = response.headers.get("set-cookie");
  expect(raw).toBeTruthy();
  return (raw as string).toLowerCase();
}

function cookieFor(response: Response): string {
  const match = /mailxp\.session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  expect(match).toBeTruthy();
  return `mailxp.session=${match?.[1]}`;
}

async function registerUser(
  email = "player1@example.com",
  ip = nextIp(),
  password = VALID_PW,
): Promise<{ cookie: string; token: string; playerId: string }> {
  const response = await registerPOST(post("/auth/register", { email, password }, { ip }));
  expect(response.status).toBe(201);
  const body = (await response.json()) as { player: { id: string }; devDelivery?: { token: string } };
  expect(body.devDelivery).toBeTruthy(); // dev-mode surfacing (NODE_ENV=test)
  return { cookie: cookieFor(response), token: body.devDelivery?.token as string, playerId: body.player.id };
}

// --------------------------------------------------------------- register --

describe("POST /api/v1/auth/register", () => {
  it("201: full contract, hashed password, hashed token, profile, session hash, audit, dev token", async () => {
    const response = await registerPOST(
      post("/auth/register", { email: "  Newbie@Example.COM ", password: VALID_PW }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      player: Record<string, unknown>;
      devDelivery?: { token: string };
    };
    const player = body.player;
    expect(Object.keys(player).sort()).toEqual(["createdAt", "email", "emailVerified", "id"]);
    expect(player.email).toBe("newbie@example.com"); // trimmed + lowercased
    expect(player.emailVerified).toBe(false);
    expect(new Date(player.createdAt as string).toISOString()).toBe(player.createdAt); // ISO 8601

    // Cookie attributes (dev: no Secure) — B1 §1.2.
    const cookie = setCookieOf(response);
    expect(cookie).toContain("httponly");
    expect(cookie).toContain("samesite=lax");
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("max-age=2592000");
    expect(cookie).not.toContain("secure");

    // Storage reality:
    const user = fake.users[0];
    expect(user.passwordHash).toMatch(/^\$2/);
    expect(user.passwordHash).not.toBe(VALID_PW);
    expect(String(user.passwordHash)).not.toContain(VALID_PW);
    expect(fake.profiles).toHaveLength(1);
    expect(fake.profiles[0].prefs).toEqual({
      masterVolume: 0.8,
      uiVolume: 0.9,
      gameVolume: 0.8,
      muted: false,
      motion: "full",
      touchControls: "auto",
    });
    const rawToken = cookieFor(response).replace("mailxp.session=", ""); // raw (not lowercased)
    expect(fake.sessions[0].tokenHash).toBe(hashSessionToken(rawToken));
    expect(fake.sessions[0].tokenHash).not.toBe(rawToken);
    expect(fake.tokens[0].tokenHash).not.toBe(body.devDelivery?.token);
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.register");
  });

  it("409 EMAIL_EXISTS on duplicate (documented enumeration trade-off)", async () => {
    await registerUser("dup@example.com");
    const response = await registerPOST(
      post("/auth/register", { email: "dup@example.com", password: VALID_PW }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("EMAIL_EXISTS");
  });

  it("400 validation: bad email, short password, common password — details name fields only", async () => {
    const badEmail = await registerPOST(post("/auth/register", { email: "nope", password: VALID_PW }));
    expect(badEmail.status).toBe(400);
    const short = await registerPOST(post("/auth/register", { email: "ok@x.co", password: "short" }));
    expect(short.status).toBe(400);
    const common = await registerPOST(post("/auth/register", { email: "ok@x.co", password: "password123" }));
    expect(common.status).toBe(400);
    const body = (await common.json()) as { error: { code: string; details: { field: string }[] } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details.some((d) => d.field === "password")).toBe(true);
    // never echo the submitted password back:
    expect(JSON.stringify(body)).not.toContain("password123");
    expect(fake.users).toHaveLength(0);
  });

  it("400 on malformed JSON", async () => {
    const response = await registerPOST(post("/auth/register", "{not-json"));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("403 on missing or cross-site Origin (public route still protected)", async () => {
    const noOrigin = await registerPOST(post("/auth/register", { email: "a@x.co", password: VALID_PW }, { origin: null }));
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { error: { code: string } }).error.code).toBe("CSRF_ORIGIN_REJECTED");
    const cross = await registerPOST(
      post("/auth/register", { email: "a@x.co", password: VALID_PW }, { origin: "https://evil.example" }),
    );
    expect(cross.status).toBe(403);
    expect(fake.users).toHaveLength(0);
  });

  it("429 register class: 5/hour per IP then Retry-After", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) {
      // Body never reached: rate is consumed before parsing (cheap 400s).
      expect((await registerPOST(post("/auth/register", "{bad", { ip }))).status).toBe(400);
    }
    const blocked = await registerPOST(post("/auth/register", { email: "x@y.co", password: VALID_PW }, { ip }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });

  it("propagates a safe inbound X-Request-Id through success and failure", async () => {
    const ok = await registerPOST(post("/auth/register", { email: "rid@x.co", password: VALID_PW }, { requestId: "req-id-12345678" }));
    expect(ok.headers.get("X-Request-Id")).toBe("req-id-12345678");
    const fail = await registerPOST(post("/auth/register", { email: "bad" }, { requestId: "req-id-12345678" }));
    const body = (await fail.json()) as { error: { requestId: string } };
    expect(body.error.requestId).toBe("req-id-12345678");
  });
});

// ------------------------------------------------------------------ login --

describe("POST /api/v1/auth/login", () => {
  it("unknown email and wrong password are byte-identical 401 envelopes", async () => {
    await registerUser("known@example.com");
    const wrong = await loginPOST(
      post("/auth/login", { email: "known@example.com", password: "not-the-password" }, { requestId: "fixed-rid-0001" }),
    );
    const ghost = await loginPOST(
      post("/auth/login", { email: "ghost@example.com", password: "not-the-password" }, { requestId: "fixed-rid-0001" }),
    );
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    const [a, b] = [await wrong.json(), await ghost.json()];
    expect(a).toEqual(b);
    expect((a as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
    expect((a as { error: { message: string } }).error.message).toBe("Invalid email or password.");
  });

  it("syntactically invalid email follows the same uniform 401 path", async () => {
    const response = await loginPOST(post("/auth/login", { email: "not-an-email", password: VALID_PW }));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("deletion-pending accounts cannot log in (uniform 401 — state not disclosed)", async () => {
    await registerUser("pending@example.com");
    fake.users[0].deletionRequestedAt = new Date();
    const response = await loginPOST(post("/auth/login", { email: "pending@example.com", password: VALID_PW }));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("success returns the player, rotates the session, audits login", async () => {
    const registered = await registerUser("alice@example.com");
    const response = await loginPOST(
      post("/auth/login", { email: "alice@example.com", password: VALID_PW }, { cookie: registered.cookie }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { player: Record<string, unknown> };
    expect(Object.keys(body.player).sort()).toEqual(["createdAt", "email", "emailVerified", "id"]);

    // Rotation: fresh token issued, presented session revoked.
    const newCookie = cookieFor(response);
    expect(newCookie).not.toBe(registered.cookie);
    const oldRaw = registered.cookie.replace("mailxp.session=", "");
    const oldRow = fake.sessions.find((s) => s.tokenHash === hashSessionToken(oldRaw));
    expect(oldRow?.revokedAt).toBeTruthy();
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.login");
  });

  it("structural body problems are 400 (schema violation, not a credential outcome)", async () => {
    expect((await loginPOST(post("/auth/login", { password: VALID_PW }))).status).toBe(400);
    expect((await loginPOST(post("/auth/login", { email: "a@b.co" }))).status).toBe(400);
    expect((await loginPOST(post("/auth/login", { email: 5, password: VALID_PW }))).status).toBe(400);
  });

  it("login rate: 10/15min per email+IP, 11th is 429", async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i += 1) {
      const response = await loginPOST(
        post("/auth/login", { email: "flood@example.com", password: "wrong-password-x" }, { ip }),
      );
      expect(response.status).toBe(401);
    }
    const blocked = await loginPOST(
      post("/auth/login", { email: "flood@example.com", password: "wrong-password-x" }, { ip }),
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
  });

  it("failed logins audit without distinguishing cause", async () => {
    await registerUser("audit@example.com");
    await loginPOST(post("/auth/login", { email: "audit@example.com", password: "wrong-password-x" }));
    await loginPOST(post("/auth/login", { email: "nobody-here@example.com", password: "wrong-password-x" }));
    const failures = fake.audits.filter((a) => a.eventType === "auth.login_failed");
    expect(failures).toHaveLength(2);
    expect(JSON.stringify(failures)).not.toContain("nobody-here"); // no email in audit meta
  });
});

// ---------------------------------------------------------------- logout --

describe("POST /api/v1/auth/logout", () => {
  it("no cookie at all → 401 UNAUTHENTICATED", async () => {
    const response = await logoutPOST(post("/auth/logout", undefined));
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
  });

  it("valid session → 204, revoked server-side, cookie cleared, audited", async () => {
    const registered = await registerUser("out@example.com");
    const response = await logoutPOST(post("/auth/logout", undefined, { cookie: registered.cookie }));
    expect(response.status).toBe(204);
    const cleared = setCookieOf(response);
    expect(cleared).toContain("max-age=0");
    expect(cleared).toContain("httponly");
    const raw = registered.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    expect(row?.revokedAt).toBeTruthy();
    expect(fake.audits.filter((a) => a.eventType === "auth.logout")).toHaveLength(1);
  });

  it("already-dead session → 204 idempotent-tolerant, no duplicate audit", async () => {
    const registered = await registerUser("twice@example.com");
    expect((await logoutPOST(post("/auth/logout", undefined, { cookie: registered.cookie }))).status).toBe(204);
    expect((await logoutPOST(post("/auth/logout", undefined, { cookie: registered.cookie }))).status).toBe(204);
    expect(fake.audits.filter((a) => a.eventType === "auth.logout")).toHaveLength(1);
  });

  it("cross-site Origin is rejected before anything else", async () => {
    const registered = await registerUser("csrf@example.com");
    const response = await logoutPOST(post("/auth/logout", undefined, { cookie: registered.cookie, origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    const raw = registered.cookie.replace("mailxp.session=", "");
    const row = fake.sessions.find((s) => s.tokenHash === hashSessionToken(raw));
    expect(row?.revokedAt).toBeNull(); // untouched
  });
});

// ----------------------------------------------------------- verify email --

describe("POST /api/v1/auth/verify-email", () => {
  it("valid token → 200, marks verified, invalidates other tokens, audits", async () => {
    const registered = await registerUser("v@x.co");
    // A second outstanding token that must be invalidated by success:
    fake.tokens.push({
      id: "manual-2",
      userId: fake.users[0].id,
      purpose: "EMAIL_VERIFICATION",
      tokenHash: hashAuthToken("second-outstanding-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      createdAt: new Date(),
    });
    const response = await verifyPOST(post("/auth/verify-email", { token: registered.token }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ player: { emailVerified: true } });
    expect(fake.users[0].emailVerifiedAt).toBeTruthy();
    const second = fake.tokens.find((t) => t.id === "manual-2");
    expect(second?.consumedAt).toBeTruthy(); // superseded/invalidated
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.email_verified");
  });

  it("replay (second use) → 404, unknown → 404, garbage → 404 — identical", async () => {
    const registered = await registerUser("r@x.co");
    expect((await verifyPOST(post("/auth/verify-email", { token: registered.token }))).status).toBe(200);
    const replay = await verifyPOST(
      post("/auth/verify-email", { token: registered.token }, { requestId: "fixed-rid-verify" }),
    );
    const unknown = await verifyPOST(
      post("/auth/verify-email", { token: "no-such-token-abc" }, { requestId: "fixed-rid-verify" }),
    );
    expect(replay.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await replay.json()).toEqual(await unknown.json()); // no reason leakage
  });

  it("expired token → 404", async () => {
    const registered = await registerUser("exp@x.co");
    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(registered.token));
    (row as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    const response = await verifyPOST(post("/auth/verify-email", { token: registered.token }));
    expect(response.status).toBe(404);
    expect(fake.users[0].emailVerifiedAt).toBeNull();
  });

  it("already verified + fresh token → 409 CONFLICT", async () => {
    const registered = await registerUser("conflict@x.co");
    await verifyPOST(post("/auth/verify-email", { token: registered.token }));
    fake.tokens.push({
      id: "manual-3",
      userId: fake.users[0].id,
      purpose: "EMAIL_VERIFICATION",
      tokenHash: hashAuthToken("another-valid-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      consumedAt: null,
      createdAt: new Date(),
    });
    const response = await verifyPOST(post("/auth/verify-email", { token: "another-valid-token" }));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");
  });

  it("missing token → 400; cross Origin → 403", async () => {
    expect((await verifyPOST(post("/auth/verify-email", {}))).status).toBe(400);
    expect((await verifyPOST(post("/auth/verify-email", { token: "abc" }, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("verify rate: general class applies (60/min per IP)", async () => {
    const ip = nextIp();
    for (let i = 0; i < 60; i += 1) {
      expect((await verifyPOST(post("/auth/verify-email", { token: `tok-${i}` }, { ip }))).status).toBe(404);
    }
    expect((await verifyPOST(post("/auth/verify-email", { token: "tok-x" }, { ip }))).status).toBe(429);
  });
});

// ---------------------------------------------------- resend verification --

describe("POST /api/v1/auth/resend-verification", () => {
  it("unknown email → 202 with empty body (no enumeration)", async () => {
    const response = await resendPOST(post("/auth/resend-verification", { email: "ghost@x.co" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
  });

  it("known unverified → 202, new token supersedes, dev surfaces token, audited", async () => {
    const registered = await registerUser("send@x.co");
    const response = await resendPOST(post("/auth/resend-verification", { email: "send@x.co" }));
    expect(response.status).toBe(202);
    const body = (await response.json()) as { devDelivery?: { token: string } };
    expect(body.devDelivery).toBeTruthy();
    expect(body.devDelivery?.token).not.toBe(registered.token);
    // Prior outstanding token superseded (consumed):
    const firstRow = fake.tokens.find((t) => t.tokenHash === hashAuthToken(registered.token));
    expect(firstRow?.consumedAt).toBeTruthy();
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.verification_resent");
  });

  it("already verified → 202 empty (nothing issued)", async () => {
    const registered = await registerUser("done@x.co");
    await verifyPOST(post("/auth/verify-email", { token: registered.token }));
    const response = await resendPOST(post("/auth/resend-verification", { email: "done@x.co" }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
  });

  it("unauthenticated without email → 400", async () => {
    expect((await resendPOST(post("/auth/resend-verification", {}))).status).toBe(400);
  });

  it("a live session supplies the identity (body email ignored)", async () => {
    const registered = await registerUser("sess@x.co");
    const response = await resendPOST(
      post("/auth/resend-verification", { email: "somebody-else@x.co" }, { cookie: registered.cookie }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { devDelivery?: { token: string } };
    expect(body.devDelivery).toBeTruthy();
    // Token was minted for the SESSION user:
    const last = fake.tokens[fake.tokens.length - 1];
    expect(last.userId).toBe(registered.playerId);
  });

  it("resend rate: 5/hour per email+IP", async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) {
      expect((await resendPOST(post("/auth/resend-verification", { email: "flood@x.co" }, { ip }))).status).toBe(202);
    }
    expect((await resendPOST(post("/auth/resend-verification", { email: "flood@x.co" }, { ip }))).status).toBe(429);
  });
});

// ---------------------------------------------------------- password flow --

describe("password forgot + reset", () => {
  it("forgot: unknown and known emails both 202 (no enumeration); known issues a 1h hashed token", async () => {
    const unknown = await forgotPOST(post("/auth/password/forgot", { email: "ghost@x.co" }));
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toEqual({});

    const registered = await registerUser("resetme@x.co");
    const before = Date.now();
    const known = await forgotPOST(post("/auth/password/forgot", { email: "resetme@x.co" }));
    expect(known.status).toBe(202);
    const body = (await known.json()) as { devDelivery?: { purpose: string; token: string } };
    expect(body.devDelivery?.purpose).toBe("password_reset");
    expect(body.devDelivery?.token).toBeTruthy();

    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(body.devDelivery?.token as string));
    expect(row).toBeTruthy();
    expect(row?.purpose).toBe("PASSWORD_RESET");
    expect(row?.tokenHash).not.toBe(body.devDelivery?.token);
    const ttl = (row?.expiresAt as Date).getTime() - before;
    expect(ttl).toBeGreaterThan(3_500_000); // ≈1h
    expect(ttl).toBeLessThan(3_660_000);
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.reset_requested");
  });

  it("forgot: missing email → 400; rate 5/hour per email+IP", async () => {
    expect((await forgotPOST(post("/auth/password/forgot", {}))).status).toBe(400);
    const ip = nextIp();
    for (let i = 0; i < 5; i += 1) {
      expect((await forgotPOST(post("/auth/password/forgot", { email: "f@x.co" }, { ip }))).status).toBe(202);
    }
    expect((await forgotPOST(post("/auth/password/forgot", { email: "f@x.co" }, { ip }))).status).toBe(429);
  });

  it("reset: single-use token changes the password and revokes ALL sessions", async () => {
    const registered = await registerUser("changer@x.co");
    await forgotPOST(post("/auth/password/forgot", { email: "changer@x.co" }));
    const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "changer@x.co" }))).json()) as {
      devDelivery?: { token: string };
    };
    const token = forgotBody.devDelivery?.token as string;

    const response = await resetPOST(post("/auth/password/reset", { token, password: "brand-new-passphrase" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});

    // All sessions (incl. the registration one) revoked:
    for (const session of fake.sessions) expect(session.revokedAt).toBeTruthy();
    expect(fake.audits.map((a) => a.eventType)).toContain("auth.password_reset");

    // Old password dead, new password live:
    expect((await loginPOST(post("/auth/login", { email: "changer@x.co", password: VALID_PW }))).status).toBe(401);
    expect((await loginPOST(post("/auth/login", { email: "changer@x.co", password: "brand-new-passphrase" }))).status).toBe(200);

    // Token single-use: replay → 404.
    const replay = await resetPOST(post("/auth/password/reset", { token, password: "another-passphrase" }));
    expect(replay.status).toBe(404);
  });

  it("reset: expired token → 404 and password unchanged", async () => {
    await registerUser("keep@x.co");
    const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "keep@x.co" }))).json()) as {
      devDelivery?: { token: string };
    };
    const token = forgotBody.devDelivery?.token as string;
    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(token));
    (row as { expiresAt: Date }).expiresAt = new Date(Date.now() - 1000);
    const response = await resetPOST(post("/auth/password/reset", { token, password: "brand-new-passphrase" }));
    expect(response.status).toBe(404);
    expect((await loginPOST(post("/auth/login", { email: "keep@x.co", password: VALID_PW }))).status).toBe(200);
  });

  it("reset: weak password rejected by policy (400), token NOT consumed", async () => {
    await registerUser("weak@x.co");
    const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "weak@x.co" }))).json()) as {
      devDelivery?: { token: string };
    };
    const token = forgotBody.devDelivery?.token as string;
    const response = await resetPOST(post("/auth/password/reset", { token, password: "password123" }));
    expect(response.status).toBe(400);
    const row = fake.tokens.find((t) => t.tokenHash === hashAuthToken(token));
    expect(row?.consumedAt).toBeNull(); // still usable after a policy rejection
    // and it still works with a good password:
    expect((await resetPOST(post("/auth/password/reset", { token, password: "acceptable-passphrase" }))).status).toBe(200);
  });

  it("reset: cross Origin → 403", async () => {
    const response = await resetPOST(
      post("/auth/password/reset", { token: "abc", password: VALID_PW }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
  });
});

// ------------------------------------------------- origin gate (all routes) --
// Contract §1.2/§2 requires the Origin check on every cookie-authenticated
// mutation (logout — covered here; DELETE /me — in me.test.ts) and explicitly
// on register; this build applies the same gate to ALL mutations as a uniform
// posture (documented in B4_REPORT), so every one is asserted here.
describe("Origin gate across every auth mutation", () => {
  it("missing or cross-site Origin → 403 before any work happens", async () => {
    const mutations: Array<[string, unknown]> = [
      ["/auth/register", { email: "origin-loop@x.co", password: VALID_PW }],
      ["/auth/login", { email: "origin-loop@x.co", password: VALID_PW }],
      ["/auth/logout", undefined],
      ["/auth/verify-email", { token: "origin-loop-token" }],
      ["/auth/resend-verification", { email: "origin-loop@x.co" }],
      ["/auth/password/forgot", { email: "origin-loop@x.co" }],
      ["/auth/password/reset", { token: "origin-loop-token", password: VALID_PW }],
    ];
    const handlers: Record<string, (request: Request) => Promise<Response>> = {
      "/auth/register": registerPOST,
      "/auth/login": loginPOST,
      "/auth/logout": logoutPOST,
      "/auth/verify-email": verifyPOST,
      "/auth/resend-verification": resendPOST,
      "/auth/password/forgot": forgotPOST,
      "/auth/password/reset": resetPOST,
    };
    for (const [path, body] of mutations) {
      const handler = handlers[path] as (request: Request) => Promise<Response>;
      const missing = await handler(post(path, body, { origin: null }));
      expect([path, missing.status]).toEqual([path, 403]);
      const cross = await handler(post(path, body, { origin: "https://evil.example" }));
      expect([path, cross.status]).toEqual([path, 403]);
    }
    // The rejected attempts touched nothing:
    expect(fake.users).toHaveLength(0);
    expect(fake.sessions).toHaveLength(0);
    expect(fake.audits).toHaveLength(0);
  });
});

// ------------------------------------------------------ production posture --

describe("production posture", () => {
  it("NODE_ENV=production: no devDelivery anywhere, cookie gets Secure", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const response = await registerPOST(post("/auth/register", { email: "prod@x.co", password: VALID_PW }));
      expect(response.status).toBe(201);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["player"]); // exact contract shape
      expect(setCookieOf(response)).toContain("secure");

      const forgot = await forgotPOST(post("/auth/password/forgot", { email: "prod@x.co" }));
      expect(await forgot.json()).toEqual({}); // token NOT surfaced
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ------------------------------------------------------- secrets hygiene --

describe("secrets never reach logs or responses", () => {
  it("passwords, hashes, and raw tokens stay out of console output", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    try {
      const PASSWORD = "my-unique-secret-passphrase";
      await registerUser("hygiene@x.co", nextIp(), PASSWORD);
      const forgotBody = (await (await forgotPOST(post("/auth/password/forgot", { email: "hygiene@x.co" }))).json()) as {
        devDelivery?: { token: string };
      };
      await loginPOST(post("/auth/login", { email: "hygiene@x.co", password: "wrong-password-x" }));
      await verifyPOST(post("/auth/verify-email", { token: "wrong-token-x" }));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const all = lines.join("\n");
    expect(all).not.toContain("my-unique-secret-passphrase");
    expect(all).not.toContain("wrong-password-x");
    expect(all).not.toContain("wrong-token-x");
    expect(all).not.toContain(String(fake.users[0]?.passwordHash));
    // (register/forgot/successful login don't log at all — a regression guard)
  });
});
