/**
 * Shared API contract types (Phase B5).
 *
 * Single source for the shapes exchanged between the Next.js routes and the
 * React client (BACKEND_API_CONTRACT.md: "shared contract types — frontend
 * imports types read-only"). TYPES ONLY, zero imports: safe for both
 * lib/server/** (implementation) and components/** (UI) to import — this file
 * never pulls server code into a client bundle.
 */

/** The six-key preference allowlist (contract game.preferencesUpdate). */
export type GamePreferences = {
  masterVolume: number;
  uiVolume: number;
  gameVolume: number;
  muted: boolean;
  motion: "full" | "reduced";
  touchControls: "auto" | "on" | "off";
};

/** `me.get` / `auth.login` / `auth.register` player projection (§2). */
export interface MePlayer {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

/** GET /api/v1/game/state body (contract §3 `game.state`). */
export interface GameStateDto {
  playerId: string;
  draftCoin: number;
  xp: number;
  level: number;
  stats: { mailCount: number };
  ownedItems: { itemId: string; ownedSince: string }[];
  equippedOutfit: string | null;
  placedDecor: { itemId: string; x: number; y: number }[];
  preferences: GamePreferences;
  version: number;
}

/** PATCH /api/v1/game/preferences success body. */
export interface PreferencesUpdateResult {
  preferences: GamePreferences;
  version: number;
}

/** One ledger row (contract §3 `game.ledger` item). */
export interface LedgerItem {
  id: string;
  type: "quest_reward" | "purchase" | "adjustment";
  amount: number;
  reason: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerItem[];
  nextCursor: string | null;
}

/** Stable error codes the UI branches on (contract §1.4). */
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "INVALID_CREDENTIALS"
  | "CSRF_ORIGIN_REJECTED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_VERSION"
  | "EMAIL_EXISTS"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  // B6: idempotency outcomes (§1.6) + purchase rejection (§4).
  | "IDEMPOTENCY_MISMATCH"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "INSUFFICIENT_FUNDS";

// ------------------------------------------------------- B6 economy (contract §4) --

/** One item of GET /api/v1/shop (`shop.catalog`). Prices are server truth. */
export interface ShopCatalogItem {
  itemId: string;
  name: string;
  price: number;
  kind: "outfit" | "decor";
  /** False when already owned (re-purchase → 409 CONFLICT). */
  available: boolean;
}

export interface ShopCatalogDto {
  items: ShopCatalogItem[];
  /** Stable content hash of the catalog (ids + prices + kinds). */
  catalogVersion: string;
}

/** POST /api/v1/shop/purchases success body (201). */
export interface PurchaseResultDto {
  transactionId: string;
  itemId: string;
  balance: number;
  version: number;
}

/** GET /api/v1/rewards/rules (`rewards.rules`, contract §7.5). */
export interface RewardsRulesDto {
  questRewardDraftCoin: number;
  dailyCapDraftCoin: number;
  resetUtcHour: number;
}

/** GET /api/v1/rewards/status (`rewards.status`, contract §7.5). */
export interface RewardsStatusDto {
  earnedToday: number;
  dailyCapDraftCoin: number;
  remainingToday: number;
  resetsAtUtc: string;
}

/** POST /api/v1/dev/rewards (development-only fixture; 404 in production). */
export interface DevRewardResultDto {
  awarded: number;
  capped: boolean;
  balance: number;
  version: number;
}

// ------------------------------------------------- Phase B8: Google OAuth ---
// Schemas finalized for the contract §7.1 family (amendment recorded in
// docs/BACKEND_API_CONTRACT.md). Token material is server-only and can never
// appear in these shapes.

/** One linked Google identity (owner-scoped projection). */
export interface GoogleAccountDto {
  id: string;
  email: string;
  status: "connected" | "released";
  scopes: string[];
  connectedAt: string;
}

/** GET /api/v1/integrations/google (`google.status`) success body. */
export interface GoogleStatusDto {
  /** Server has Google OAuth credentials configured. */
  configured: boolean;
  /** Variable NAMES only when configured=false — never values. */
  missing: string[];
  /** Connect gate: verified email required (contract §7.1). */
  emailVerified: boolean;
  accounts: GoogleAccountDto[];
}

/** POST /api/v1/integrations/google/start (`google.connectStart`) body. */
export interface GoogleStartDto {
  /** Absolute Google consent URL — navigate the browser here. */
  authUrl: string;
}
