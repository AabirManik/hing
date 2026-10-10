/**
 * Phase B5 — shared auth store tests (apiClient mocked; no React rendering —
 * the store is a module store consumed via useSyncExternalStore).
 *
 * Covers phase_b5 §11: probe outcomes (signed-in / signed-out / network →
 * notice, single attempt), sign-in adoption, sign-out finality, and the
 * single-transition rule for 401 UNAUTHENTICATED/SESSION_EXPIRED (no retry
 * loops, no re-probe).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./apiClient", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    code: string;
    requestId: string;
    fieldErrors: Array<{ field: string; message: string; currentVersion?: number }>;
    constructor(
      status: number,
      code: string,
      message: string,
      requestId: string,
      fieldErrors: Array<{ field: string; message: string; currentVersion?: number }> = [],
    ) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
      this.fieldErrors = fieldErrors;
    }
  },
  fetchMe: vi.fn(),
  login: vi.fn(),
  registerAccount: vi.fn(),
  logoutRequest: vi.fn(),
  isSessionErrorCode: (code: string) => code === "UNAUTHENTICATED" || code === "SESSION_EXPIRED",
}));

import type { ApiError } from "./apiClient";
import { fetchMe, login, logoutRequest, registerAccount } from "./apiClient";
import {
  clearNotice,
  getAuthSnapshot,
  probeAuth,
  reportSessionLost,
  resetAuthStore,
  signIn,
  signOut,
} from "./authStore";

const PLAYER = { id: "user-1", email: "a@example.test", emailVerified: false, createdAt: "2026-01-01T00:00:00.000Z" };

const fetchMeMock = vi.mocked(fetchMe);
const loginMock = vi.mocked(login);
const registerMock = vi.mocked(registerAccount);
const logoutMock = vi.mocked(logoutRequest);

beforeEach(() => {
  resetAuthStore();
  fetchMeMock.mockReset();
  loginMock.mockReset();
  registerMock.mockReset();
  logoutMock.mockReset();
  logoutMock.mockResolvedValue(undefined);
});

afterEach(() => {
  resetAuthStore();
});

describe("probeAuth (boot)", () => {
  it("starts in the checking state", () => {
    expect(getAuthSnapshot()).toEqual({ status: "checking", player: null, notice: null });
  });

  it("200 with a player → signedIn", async () => {
    fetchMeMock.mockResolvedValue(PLAYER);
    await probeAuth();
    expect(getAuthSnapshot()).toEqual({ status: "signedIn", player: PLAYER, notice: null });
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("null player (401 either flavor) → signedOut", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().player).toBeNull();
  });

  it("network failure → signedOut WITH a notice, one attempt only (no retry loop)", async () => {
    fetchMeMock.mockRejectedValue(new Error("network down"));
    await probeAuth();
    const snapshot = getAuthSnapshot();
    expect(snapshot.status).toBe("signedOut");
    expect(snapshot.notice).toContain("Could not reach the server");
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });

  it("is guarded (StrictMode double-mount cannot double-probe)", async () => {
    fetchMeMock.mockResolvedValue(null);
    await Promise.all([probeAuth(), probeAuth()]);
    expect(fetchMeMock).toHaveBeenCalledTimes(1);
  });
});

describe("signIn / signOut", () => {
  it("login success adopts the player and clears notices", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    reportSessionLost("SESSION_EXPIRED");
    expect(getAuthSnapshot().notice).toBeTruthy();

    loginMock.mockResolvedValue(PLAYER);
    const returned = await signIn("login", PLAYER.email, "pw");
    expect(returned).toEqual(PLAYER);
    expect(loginMock).toHaveBeenCalledWith(PLAYER.email, "pw");
    expect(getAuthSnapshot()).toEqual({ status: "signedIn", player: PLAYER, notice: null });
  });

  it("register success routes through registerAccount", async () => {
    registerMock.mockResolvedValue(PLAYER);
    await signIn("register", PLAYER.email, "longenoughpw1");
    expect(registerMock).toHaveBeenCalledWith(PLAYER.email, "longenoughpw1");
    expect(loginMock).not.toHaveBeenCalled();
    expect(getAuthSnapshot().status).toBe("signedIn");
  });

  it("failed sign-in leaves the previous state untouched (error propagates)", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    loginMock.mockRejectedValue(new Error("INVALID_CREDENTIALS"));
    await expect(signIn("login", PLAYER.email, "bad")).rejects.toThrow();
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().player).toBeNull();
  });

  it("sign-out revokes server-side first, then clears local state", async () => {
    loginMock.mockResolvedValue(PLAYER);
    await signIn("login", PLAYER.email, "pw");
    await signOut();
    expect(logoutMock).toHaveBeenCalledTimes(1);
    expect(getAuthSnapshot()).toEqual({ status: "signedOut", player: null, notice: null });
  });

  it("sign-out still clears locally if the logout call rejects (finally rule)", async () => {
    loginMock.mockResolvedValue(PLAYER);
    await signIn("login", PLAYER.email, "pw");
    logoutMock.mockRejectedValue(new Error("network"));
    await expect(signOut()).rejects.toThrow("network");
    expect(getAuthSnapshot().status).toBe("signedOut"); // no stuck signed-in UI
    expect(getAuthSnapshot().player).toBeNull();
  });
});

describe("reportSessionLost (single transition, no loops)", () => {
  it("SESSION_EXPIRED → signedOut with expiry notice", async () => {
    loginMock.mockResolvedValue(PLAYER);
    await signIn("login", PLAYER.email, "pw");
    reportSessionLost("SESSION_EXPIRED");
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().notice).toContain("expired");
  });

  it("UNAUTHENTICATED → signedOut with sign-in notice", async () => {
    loginMock.mockResolvedValue(PLAYER);
    await signIn("login", PLAYER.email, "pw");
    reportSessionLost("UNAUTHENTICATED");
    expect(getAuthSnapshot().status).toBe("signedOut");
    expect(getAuthSnapshot().notice).toContain("sign in");
  });

  it("ignores non-session codes (a VALIDATION_ERROR must not kill the session)", async () => {
    loginMock.mockResolvedValue(PLAYER);
    await signIn("login", PLAYER.email, "pw");
    reportSessionLost("VALIDATION_ERROR");
    reportSessionLost("RATE_LIMITED");
    expect(getAuthSnapshot().status).toBe("signedIn");
  });

  it("repeat reports are idempotent (no notice churn after already signed out)", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    reportSessionLost("SESSION_EXPIRED");
    const first = getAuthSnapshot();
    reportSessionLost("SESSION_EXPIRED");
    expect(getAuthSnapshot()).toEqual(first);
  });

  it("clearNotice drops the notice without changing status", async () => {
    fetchMeMock.mockResolvedValue(null);
    await probeAuth();
    reportSessionLost("SESSION_EXPIRED");
    clearNotice();
    expect(getAuthSnapshot().notice).toBeNull();
    expect(getAuthSnapshot().status).toBe("signedOut");
  });
});

describe("describeAuthError presentation (AuthPanel pure mapping)", () => {
  it("maps stable codes to non-enumerating messages", async () => {
    const { describeAuthError } = await import("./AuthPanel");
    const { ApiError: ApiErrorClass } = await import("./apiClient");
    const make = (code: string, status = 400, details?: Array<{ field: string; message: string }>): ApiError =>
      new ApiErrorClass(status, code, "raw server text", "req", details ?? []) as never;

    expect(describeAuthError(make("INVALID_CREDENTIALS", 401)).message).toBe("Invalid email or password.");
    expect(describeAuthError(make("EMAIL_EXISTS", 409)).message).toContain("already registered");
    expect(describeAuthError(make("RATE_LIMITED", 429)).message).toContain("Too many attempts");
    expect(describeAuthError(make("NETWORK_ERROR", 0)).message).toContain("reach the server");

    const validation = describeAuthError(
      make("VALIDATION_ERROR", 400, [{ field: "password", message: "Must be at least 10 characters." }]),
    );
    expect(validation.message).toContain("check the form");
    expect(validation.fields[0]).toContain("Must be at least 10 characters");

    // Unknown codes fall back to the safe server summary — never a throw.
    expect(describeAuthError(make("INTERNAL_ERROR", 500)).message).toBe("raw server text");
    expect(describeAuthError(new Error("programmer error")).message).toBe("Something went wrong. Try again.");
  });
});
