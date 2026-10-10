"use client";

/**
 * Login / register gate (Phase B5 §5) — rendered INSIDE the existing title
 * overlay (user decision 2026-10-10). The Phaser canvas underneath is
 * untouched: this is pure overlay state, so auth changes never remount or
 * reset OfficeScene.
 *
 * Contract discipline:
 * - Uses the exact B4 request/response contracts via authStore/apiClient.
 * - Login failures show ONE generic message (never which field was wrong);
 *   register 409 EMAIL_EXISTS is surfaced so the user can switch to login —
 *   the enumeration trade-off B1 accepted explicitly.
 * - Play-now-verify-later: no verification prompt exists here by design.
 */

import { useEffect, useState, type FormEvent } from "react";

import type { ApiError } from "./apiClient";
import { ApiError as ApiErrorClass, startGoogleSignIn } from "./apiClient";
import { clearNotice, signIn, useAuth } from "./authStore";
import { describeOAuthOutcome, readOAuthOutcomeToken } from "./oauthOutcome";

type Mode = "login" | "register";

/** Pure, testable error presentation (codes — never message sniffing). */
export function describeAuthError(error: unknown): { message: string; fields: string[] } {
  if (error instanceof ApiErrorClass) {
    const api = error as ApiError;
    switch (api.code) {
      case "INVALID_CREDENTIALS":
        return { message: "Invalid email or password.", fields: [] };
      case "EMAIL_EXISTS":
        return { message: "That email is already registered — sign in instead.", fields: [] };
      case "RATE_LIMITED":
        return { message: "Too many attempts — wait a moment and try again.", fields: [] };
      case "VALIDATION_ERROR": {
        const fields = api.fieldErrors.slice(0, 4).map((item) => {
          const label = item.field === "body" ? "" : `${item.field}: `;
          return `${label}${item.message}`;
        });
        return fields.length > 0
          ? { message: "Please check the form:", fields }
          : { message: "Please check the form and try again.", fields: [] };
      }
      case "CSRF_ORIGIN_REJECTED":
        return { message: "Request blocked — reload the page and try again.", fields: [] };
      case "NETWORK_ERROR":
        return { message: "Could not reach the server — check your connection.", fields: [] };
      default:
        return { message: api.message || "Something went wrong. Try again.", fields: [] };
    }
  }
  return { message: "Something went wrong. Try again.", fields: [] };
}

export default function AuthPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const auth = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ message: string; fields: string[] } | null>(null);
  const [googlePending, setGooglePending] = useState(false);

  // B8a: a failed/cancelled Google round-trip lands back HERE (signed out)
  // with a safe `?googleOAuth=` token — surface it once, then scrub the URL.
  // Effect-only (window access never during render — SSR/hydration safe).
  useEffect(() => {
    const outcome = readOAuthOutcomeToken();
    if (outcome !== null) setError({ message: describeOAuthOutcome(outcome), fields: [] });
  }, []);

  function switchMode(next: Mode): void {
    if (pending || next === mode) return;
    setMode(next);
    setError(null);
    clearNotice();
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    clearNotice();
    try {
      await signIn(mode, email.trim(), password);
      onSignedIn();
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setPending(false);
    }
  }

  /** B8a — "Continue with Google": full-page navigation, exactly like the
   *  Settings Connect button; the callback lands back here signed in (the
   *  boot probe then finds the session and the gate unmounts). */
  async function onGoogleSignIn(): Promise<void> {
    if (googlePending || pending) return;
    setGooglePending(true);
    setError(null);
    clearNotice();
    try {
      const { authUrl } = await startGoogleSignIn();
      window.location.assign(authUrl);
    } catch (caught) {
      const api = caught instanceof ApiErrorClass ? (caught as ApiError) : null;
      setError(
        api?.code === "SERVICE_UNAVAILABLE"
          ? { message: "Google sign-in is not configured on this server.", fields: [] }
          : describeAuthError(caught),
      );
      setGooglePending(false);
    }
  }

  const tabClass = (active: boolean): string =>
    `flex-1 rounded-t-lg border-2 border-b-0 px-3 py-2 text-sm font-bold transition ${
      active
        ? "border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)] text-[var(--mailxp-teal)]"
        : "border-transparent bg-black/10 text-[var(--mailxp-walnut)] hover:bg-black/20"
    }`;

  return (
    <form
      onSubmit={onSubmit}
      aria-label={mode === "login" ? "Sign in" : "Create account"}
      className="w-full max-w-sm rounded-xl border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/95 p-4 text-left shadow-xl"
    >
      {/* Session-expiry / boot notices from the shared store. */}
      {auth.notice ? (
        <p role="status" className="mb-3 rounded border border-amber-600/50 bg-amber-100/80 px-2 py-1.5 text-sm text-amber-900">
          {auth.notice}
        </p>
      ) : null}

      <div role="tablist" aria-label="Account action" className="flex gap-1">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          className={tabClass(mode === "login")}
          onClick={() => switchMode("login")}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "register"}
          className={tabClass(mode === "register")}
          onClick={() => switchMode("register")}
        >
          Create account
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3 rounded-b-lg border-2 border-t-0 border-[var(--mailxp-walnut)] bg-[var(--mailxp-cream)]/60 p-3">
        <label className="flex flex-col gap-1 text-sm font-semibold text-[var(--mailxp-walnut)]">
          Email
          <input
            type="email"
            name="email"
            required
            autoFocus
            autoComplete={mode === "login" ? "username" : "email"}
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={pending}
            className="rounded border-2 border-[var(--mailxp-walnut)]/70 bg-white px-2.5 py-2 font-normal outline-none focus:border-[var(--mailxp-teal)]"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-semibold text-[var(--mailxp-walnut)]">
          Password
          <input
            type="password"
            name="password"
            required
            minLength={mode === "register" ? 10 : 1}
            maxLength={128}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending}
            className="rounded border-2 border-[var(--mailxp-walnut)]/70 bg-white px-2.5 py-2 font-normal outline-none focus:border-[var(--mailxp-teal)]"
          />
          {mode === "register" ? (
            <span className="text-xs font-normal opacity-70">At least 10 characters.</span>
          ) : null}
        </label>

        {error ? (
          <div role="alert" className="rounded border border-red-700/50 bg-red-50 px-2 py-1.5 text-sm text-red-800">
            <p>{error.message}</p>
            {error.fields.length > 0 ? (
              <ul className="mt-1 list-inside list-disc text-xs">
                {error.fields.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-[var(--mailxp-teal)] px-6 py-2.5 font-bold text-white shadow-md transition hover:opacity-90 active:translate-y-px disabled:opacity-60"
        >
          {pending
            ? mode === "login"
              ? "Signing in…"
              : "Creating account…"
            : mode === "login"
              ? "Sign in"
              : "Create account"}
        </button>

        {/* Play now, verify later (contract §1.2): no verification gate here. */}
        <p className="text-xs opacity-70">
          {mode === "register"
            ? "You can play right away — email verification is optional."
            : "New here? Choose “Create account” — it takes seconds."}
        </p>

        {/* B8a — the GitHub/Facebook pattern: Google verifies you on ITS own
            screen (MailXP never sees your Google password), then you land
            back here signed in — and connected for Gmail in the same click. */}
        <div role="separator" aria-hidden="true" className="flex items-center gap-2 text-xs opacity-60">
          <span className="h-px flex-1 bg-[var(--mailxp-walnut)]/40" />
          or
          <span className="h-px flex-1 bg-[var(--mailxp-walnut)]/40" />
        </div>
        <button
          type="button"
          disabled={googlePending || pending}
          onClick={() => void onGoogleSignIn()}
          className="rounded-lg border-2 border-[var(--mailxp-walnut)] bg-white px-6 py-2.5 font-bold text-[var(--mailxp-walnut)] shadow-md transition hover:opacity-90 active:translate-y-px disabled:opacity-60"
        >
          {googlePending ? "Opening Google…" : "Continue with Google"}
        </button>
      </div>
    </form>
  );
}
