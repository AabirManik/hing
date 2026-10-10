/**
 * PostgreSQL-backed job queue (Phase B7, phase_b7.md §5).
 *
 * Source of truth is the Job table (migration 20261010132336_b7_outbox_jobs);
 * there is no in-memory queue fallback. Semantics:
 *
 * - CLAIM is a conditional UPDATE guarded by
 *     (pending AND availableAt <= now) OR (running AND lease expired).
 *   Two competing workers can never both hold the same active lease: the
 *   loser's UPDATE matches 0 rows. An expired lease (crashed worker) is
 *   simply reclaimable by the next claim scan — no sweeper job needed.
 * - attempts increments AT CLAIM time, and success is recorded only after the
 *   handler's durable effect returns: delivery is AT-LEAST-ONCE and handlers
 *   must be idempotent (§5). We never claim exactly-once execution.
 * - Retries: bounded exponential backoff with symmetric jitter
 *   (computeBackoffMs), capped at BACKOFF_CAP_MS; terminal after
 *   MAX_ATTEMPTS or immediately for PERMANENT_ERROR_CLASSES — validation,
 *   unsupported job types, and refused side effects must not retry forever.
 * - Time and randomness are injected (options.now / options.random) so tests
 *   are deterministic (§5 "inject time/randomness").
 * - Unknown job types and invalid payloads fail SAFELY: the dispatcher never
 *   executes arbitrary code — it looks the handler up in an explicit registry
 *   and dead-letters anything unknown (worker.ts) or malformed (handler
 *   validation before side effects, deletion.ts).
 * - dedupeKey is unique across the table: one job row per key EVER. A dead
 *   job is retried by requeueDeadJob (update in place), never by inserting a
 *   second row; outbox conversion is deduped by the unique outboxEventId.
 *
 * Payloads carry internal identifiers only and are NEVER logged: every log
 * line in this module passes a whitelist of scalar fields through the
 * redacting logger (lib/server/logger.ts).
 */

import type { Prisma } from "@prisma/client";
import { isUniqueViolation } from "@/lib/server/http";

// ---------------------------------------------------------------------------
// Retry policy (engineering call — no numbers exist in requirements; recorded
// in B7_REPORT.md §5). Backoff for attempt N (1-based):
//   raw   = BASE * 2^(N-1)                      (N capped at 31 for safety)
//   delay = clamp(0, CAP, raw * (1 - J + 2J*random()))
// With BASE=1s, J=0.25: attempt 1 -> [750ms, 1250ms], 2 -> [1.5s, 2.5s],
// 3 -> [3s, 5s], 4 -> [6s, 10s], attempt 5+ -> [225s, 300s] (absolute cap 5 min).
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 300_000; // 5 minutes — max delay
export const BACKOFF_JITTER = 0.25; // ±25 % symmetric jitter
export const DEFAULT_LEASE_MS = 60_000; // worker lease; expired => reclaimable

/**
 * Failure classes that are terminal on the FIRST attempt — a retry cannot
 * fix them (malformed payload, unknown job type, a refused-by-policy side
 * effect such as erasing an account that never requested deletion).
 * Transient classes (db, timeout, unexpected handler errors) retry with backoff.
 */
export const PERMANENT_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "validation",
  "unsupported_type",
  "not_requested",
  "config",
]);

/** Throw from a handler BEFORE side effects to dead-letter without retrying. */
export class PermanentJobError extends Error {
  readonly errorClass: string;

  constructor(errorClass: string, message?: string) {
    super(message ?? `job: permanent failure (${errorClass})`);
    this.name = "PermanentJobError";
    this.errorClass = errorClass;
  }
}

/** Bounded exponential backoff with symmetric jitter; `random` injectable. */
export function computeBackoffMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(Math.max(attempts, 1) - 1, 30); // 2^30 * 1s ~ 12 days
  const raw = BACKOFF_BASE_MS * 2 ** exp;
  const jittered = raw * (1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * random());
  return Math.min(BACKOFF_CAP_MS, Math.max(0, Math.round(jittered)));
}

// ---------------------------------------------------------------------------
// Rows + narrow database surface (structural, so both the real PrismaClient
// and the test double in lib/server/fakeDb.ts satisfy it — B6 convention).
// ---------------------------------------------------------------------------

export type JobStatusValue = "pending" | "running" | "succeeded" | "dead";

export interface JobRow {
  id: string;
  jobType: string;
  payload: unknown;
  status: JobStatusValue;
  dedupeKey: string | null;
  outboxEventId: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastErrorClass: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface JobWhere {
  [key: string]: unknown;
}

export interface QueueDb {
  job: {
    create(args: {
      data: {
        jobType: string;
        // Nullable Json: omitted for SQL NULL (Prisma rejects plain null on
        // create); the fake defaults payload to null.
        payload?: Prisma.InputJsonValue;
        dedupeKey?: string | null;
        outboxEventId?: string | null;
        maxAttempts?: number;
        availableAt?: Date;
      };
    }): Promise<JobRow>;
    findUnique(args: { where: { id: string } }): Promise<JobRow | null>;
    findMany(args: {
      where: JobWhere;
      orderBy?: unknown;
      take?: number;
      select?: { id?: boolean; startedAt?: boolean };
    }): Promise<Array<Record<string, unknown>>>;
    updateMany(args: { where: JobWhere; data: Record<string, unknown> }): Promise<{ count: number }>;
  };
}

export interface EnqueueInput {
  jobType: string;
  payload?: Prisma.InputJsonValue;
  dedupeKey?: string | null;
  outboxEventId?: string | null;
  availableAt?: Date;
  maxAttempts?: number;
}

export interface EnqueueResult {
  jobId: string;
  created: boolean;
}

/**
 * Insert a job. Idempotent under concurrency: a duplicate dedupeKey or
 * outboxEventId collides on the unique index (P2002) and resolves to the
 * existing row instead of a second one.
 */
export async function enqueueJob(db: QueueDb, input: EnqueueInput): Promise<EnqueueResult> {
  try {
    const row = await db.job.create({
      data: {
        jobType: input.jobType,
        ...(input.payload !== undefined && input.payload !== null ? { payload: input.payload } : {}),
        dedupeKey: input.dedupeKey ?? null,
        outboxEventId: input.outboxEventId ?? null,
        ...(input.maxAttempts !== undefined ? { maxAttempts: input.maxAttempts } : {}),
        ...(input.availableAt !== undefined ? { availableAt: input.availableAt } : {}),
      },
    });
    return { jobId: row.id, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const row = await findExistingEnqueue(db, input);
      if (row) return { jobId: row, created: false };
    }
    throw error;
  }
}

async function findExistingEnqueue(db: QueueDb, input: EnqueueInput): Promise<string | null> {
  // Unique-key lookups go through findMany (single-field where), which both
  // the real client and the fake support; a P2002 can only come from the
  // dedupeKey or outboxEventId unique indexes.
  if (input.dedupeKey) {
    const rows = await db.job.findMany({ where: { dedupeKey: input.dedupeKey }, take: 1 });
    return rows.length > 0 ? (rows[0]?.id as string) : null;
  }
  if (input.outboxEventId) {
    const rows = await db.job.findMany({ where: { outboxEventId: input.outboxEventId }, take: 1 });
    return rows.length > 0 ? (rows[0]?.id as string) : null;
  }
  return null;
}

export interface ClaimInput {
  owner: string;
  limit: number;
  leaseMs: number;
  now: Date;
}

/**
 * Atomically claim up to `limit` runnable jobs for `owner`.
 *
 * Per candidate: a single guarded UPDATE (same predicate as the scan) decides
 * ownership — pending rows must still be available, running rows must have an
 * expired lease. Exactly one claimer can flip a row; everyone else matches 0
 * rows. `attempts` increments on every successful claim (at-least-once), and
 * `startedAt` records the first claim only.
 */
export async function claimJobs(db: QueueDb, input: ClaimInput): Promise<JobRow[]> {
  const runnable: JobWhere = {
    OR: [
      { status: "pending", availableAt: { lte: input.now } },
      { status: "running", leaseExpiresAt: { lt: input.now } },
    ],
  };
  const candidates = await db.job.findMany({
    where: runnable,
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    take: input.limit,
    select: { id: true, startedAt: true },
  });

  const claimed: JobRow[] = [];
  for (const candidate of candidates) {
    const id = candidate.id as string;
    const res = await db.job.updateMany({
      where: { id, ...runnable },
      data: {
        status: "running",
        leaseOwner: input.owner,
        leaseExpiresAt: new Date(input.now.getTime() + input.leaseMs),
        attempts: { increment: 1 },
        ...(candidate.startedAt === null || candidate.startedAt === undefined
          ? { startedAt: input.now }
          : {}),
      },
    });
    if (res.count !== 1) continue; // someone else won the claim (or timing moved)
    const row = await db.job.findUnique({ where: { id } });
    if (row) claimed.push(row);
  }
  return claimed;
}

export interface CompleteInput {
  jobId: string;
  owner: string;
  now: Date;
}

/** Record success — only reachable AFTER the handler's durable effect returns. */
export async function completeJob(db: QueueDb, input: CompleteInput): Promise<boolean> {
  const res = await db.job.updateMany({
    where: { id: input.jobId, status: "running", leaseOwner: input.owner },
    data: {
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: input.now,
      lastErrorClass: null,
    },
  });
  return res.count === 1;
}

export interface FailInput {
  jobId: string;
  owner: string;
  errorClass: string;
  permanent?: boolean;
  now: Date;
  random?: () => number;
}

export type FailOutcome = "dead" | "retry" | "lost";

/**
 * Record a failed attempt under the owner's lease:
 *  - permanent class OR attempts >= maxAttempts -> terminal "dead";
 *  - otherwise -> back to "pending" with availableAt = now + backoff;
 *  - "lost" when the lease is no longer ours (expired and reclaimed, or the
 *    job finished elsewhere) — the caller must NOT override the new owner.
 */
export async function failJob(db: QueueDb, input: FailInput): Promise<FailOutcome> {
  const job = await db.job.findUnique({ where: { id: input.jobId } });
  if (!job || job.status !== "running" || job.leaseOwner !== input.owner) return "lost";

  const permanent = input.permanent === true || PERMANENT_ERROR_CLASSES.has(input.errorClass);
  const exhausted = job.attempts >= job.maxAttempts;
  const release = { leaseOwner: null, leaseExpiresAt: null, lastErrorClass: input.errorClass };

  if (permanent || exhausted) {
    const res = await db.job.updateMany({
      where: { id: job.id, status: "running", leaseOwner: input.owner },
      data: { ...release, status: "dead", finishedAt: input.now },
    });
    return res.count === 1 ? "dead" : "lost";
  }

  const delay = computeBackoffMs(job.attempts, input.random ?? Math.random);
  const res = await db.job.updateMany({
    where: { id: job.id, status: "running", leaseOwner: input.owner },
    data: { ...release, status: "pending", availableAt: new Date(input.now.getTime() + delay) },
  });
  return res.count === 1 ? "retry" : "lost";
}

export interface RequeueInput {
  jobId: string;
  now: Date;
  resetAttempts?: boolean;
}

/**
 * Manual dead-letter recovery path (architecture §6: "keep a manual
 * inspection/recovery path for dead or exhausted jobs"). NOT exposed over
 * HTTP — no public route may enqueue or run jobs (contract §7.4); this is an
 * internal/ops function used by tests and documented manual commands.
 */
export async function requeueDeadJob(db: QueueDb, input: RequeueInput): Promise<boolean> {
  const res = await db.job.updateMany({
    where: { id: input.jobId, status: "dead" },
    data: {
      status: "pending",
      availableAt: input.now,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      lastErrorClass: null,
      ...(input.resetAttempts ? { attempts: 0 } : {}),
    },
  });
  return res.count === 1;
}
