/**
 * POST /api/v1/auth/login — `auth.login` (B1 contract §2, binding).
 *
 * 200 { player } + a FRESH session (the presented session, if any, is revoked
 * first — rotation on login). Failures are the uniform 401
 * INVALID_CREDENTIALS for unknown email, wrong password, syntactically
 * invalid email, and deletion-pending accounts (login is disabled for those)
 * — the response never reveals which, and unknown emails pay the same bcrypt
 * cost via burnPasswordCheck (timing parity). Audits: `auth.login` on
 * success, `auth.login_failed` without distinguishing cause.
 * Rate: 10 / 15 min per normalized-email + IP. Origin-checked.
 * Structural body problems (missing/non-string fields) are 400 per B1 §1.4 —
 * that is a schema violation, not a credential outcome.
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  originMismatch,
  readJsonObject,
  rateLimitedResponse,
  validationError,
} from "@/lib/server/http";
import { burnPasswordCheck, verifyPassword } from "@/lib/server/password";
import { getDb } from "@/lib/server/prisma";
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import {
  applySessionCookie,
  createSession,
  hashSessionToken,
  readSessionCookie,
  revokeSession,
  toPlayer,
} from "@/lib/server/session";
import { normalizeEmail, validateEmail } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.login", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;
    const { email: rawEmail, password } = parsed.body;
    if (rawEmail === undefined || typeof rawEmail !== "string" || typeof password !== "string") {
      return validationError(requestId, [
        ...(typeof rawEmail === "string" ? [] : [{ field: "email", message: "Email is required." }]),
        ...(typeof password === "string" ? [] : [{ field: "password", message: "Password is required." }]),
      ]);
    }

    const normalized = normalizeEmail(rawEmail);
    const rate = checkRate("login", `${normalized}:${clientIp(request)}`);
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const db = getDb();
    const invalid = () =>
      errorResponse(401, CODES.INVALID_CREDENTIALS, "Invalid email or password.", requestId);

    // Syntactically invalid email → same uniform path as unknown email.
    const emailCheck = validateEmail(rawEmail);
    const user = emailCheck.ok ? await db.user.findUnique({ where: { email: emailCheck.value } }) : null;

    if (!user || user.deletionRequestedAt !== null) {
      await burnPasswordCheck(password); // timing parity with a real check
      await recordAudit(db, {
        userId: user?.id ?? null,
        eventType: "auth.login_failed",
        requestId,
      });
      return invalid();
    }

    const passwordOk = await verifyPassword(password, user.passwordHash);
    if (!passwordOk) {
      await recordAudit(db, { userId: user.id, eventType: "auth.login_failed", requestId });
      return invalid();
    }

    // Rotation: revoke the presented session (whatever its state) and issue a
    // fresh one — same transaction, so login is atomic.
    const presented = readSessionCookie(request);
    const created = await db.$transaction(async (tx) => {
      if (presented !== null) {
        const existing = await tx.session.findUnique({
          where: { tokenHash: hashSessionToken(presented) },
        });
        if (existing) await revokeSession(tx, existing.id);
      }
      const session = await createSession(tx, user.id);
      await recordAudit(tx, { userId: user.id, eventType: "auth.login", requestId });
      return session;
    });

    const response = NextResponse.json({ player: toPlayer(user) });
    applySessionCookie(response, created.token);
    return response;
  });
}
