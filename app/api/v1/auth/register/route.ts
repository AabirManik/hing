/**
 * POST /api/v1/auth/register — `auth.register` (B1 contract §2, binding).
 *
 * 201 { player } + Set-Cookie mailxp.session (auto-login) + audit
 * `auth.register`, all created in ONE transaction (user, profile, verification
 * token, session, audit). 409 EMAIL_EXISTS is the B1-confirmed enumeration
 * trade-off. Origin check applies (contract: public route + origin check).
 * Rate: 5 / hour per IP. Dev-only: `devDelivery` carries the verification
 * token outside production (user decision B4) — production responses match
 * the contract shape exactly.
 *
 * Profile creation (user decision 2026-10-10): the PlayerProfile row is
 * created at register with pure defaults identical to game/profile.ts
 * DEFAULTS.prefs so B5 finds every user already profiled (no backfill).
 * Nothing reads this row yet — no visible game behavior changes in B4.
 */

import { NextResponse } from "next/server";
import { recordAudit } from "@/lib/server/audit";
import { buildDevDelivery } from "@/lib/server/emailDelivery";
import {
  CODES,
  csrfRejected,
  errorResponse,
  handle,
  isUniqueViolation,
  originMismatch,
  readJsonObject,
  rateLimitedResponse,
  validationError,
} from "@/lib/server/http";
import { hashPassword } from "@/lib/server/password";
import { DEFAULT_PROFILE_PREFS } from "@/lib/server/preferences";
import { getDb } from "@/lib/server/prisma";
import { checkRate, clientIp } from "@/lib/server/rateLimit";
import { applySessionCookie, createSession, toPlayer } from "@/lib/server/session";
import { issueToken } from "@/lib/server/tokens";
import { validateEmail, validatePassword } from "@/lib/server/validate";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  return handle(request, "auth.register", async (requestId) => {
    if (originMismatch(request)) return csrfRejected(requestId);

    const rate = checkRate("register", clientIp(request));
    if (!rate.allowed) return rateLimitedResponse(requestId, rate.retryAfterSeconds);

    const parsed = await readJsonObject(request, requestId);
    if (!parsed.ok) return parsed.response;
    const email = validateEmail(parsed.body.email);
    const password = validatePassword(parsed.body.password);
    if (!email.ok || !password.ok) {
      return validationError(requestId, [
        ...(email.ok ? [] : email.errors),
        ...(password.ok ? [] : password.errors),
      ]);
    }

    const db = getDb();
    const passwordHash = await hashPassword(password.value);

    let outcome;
    try {
      outcome = await db.$transaction(async (tx) => {
        const user = await tx.user.create({ data: { email: email.value, passwordHash } });
        await tx.playerProfile.create({ data: { userId: user.id, prefs: DEFAULT_PROFILE_PREFS } });
        const verification = await issueToken(tx, user.id, "EMAIL_VERIFICATION");
        const session = await createSession(tx, user.id);
        await recordAudit(tx, { userId: user.id, eventType: "auth.register", requestId });
        return { user, verification, sessionToken: session.token };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return errorResponse(409, CODES.EMAIL_EXISTS, "This email is already registered.", requestId);
      }
      throw error;
    }

    const devDelivery = buildDevDelivery(
      "email_verification",
      outcome.verification.token,
      outcome.verification.expiresAt,
    );
    const response = NextResponse.json(
      { player: toPlayer(outcome.user), ...(devDelivery ? { devDelivery } : {}) },
      { status: 201 },
    );
    applySessionCookie(response, outcome.sessionToken);
    return response;
  });
}
