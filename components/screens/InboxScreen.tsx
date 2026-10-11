"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  GmailMessageDetailDto,
  GmailMessageSummaryDto,
  GmailSyncStatusDto,
} from "../../game/backend/contract";
import { playSound } from "../../game/audio/audioManager";
import {
  ApiError,
  fetchGmailMessage,
  fetchGmailMessages,
  fetchGmailSyncStatus,
  startGmailSync,
} from "../apiClient";
import { isSessionLoss, reportSessionLost } from "../authStore";

/**
 * Inbox tab (Phase B9) — the in-game Gmail inbox.
 *
 * Reads the LOCAL mirror (kept fresh by the reconcile-on-open sync job). On
 * mount it shows sync status, then loads the newest message page. "Sync now"
 * enqueues a durable job — NO Gmail work happens in this component, and there
 * is no network call in any Phaser update loop (spec §9). Bodies are PLAIN
 * TEXT only (HTML is never rendered, spec §5); attachments are metadata only.
 *
 * States (spec §9): no-mailbox, initial-sync progress, empty, list, delayed,
 * error, and reconnect-required are all surfaced honestly — a stale list is
 * never shown as freshly synced without its status.
 */
export default function InboxScreen() {
  const [status, setStatus] = useState<GmailSyncStatusDto | null>(null);
  const [messages, setMessages] = useState<GmailMessageSummaryDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<GmailMessageDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listLoaded, setListLoaded] = useState(false);

  const loadStatus = useCallback(async (): Promise<GmailSyncStatusDto | null> => {
    const next = await fetchGmailSyncStatus();
    setStatus(next);
    return next;
  }, []);

  const loadFirstPage = useCallback(async (): Promise<void> => {
    const page = await fetchGmailMessages();
    setMessages(page.messages);
    setNextCursor(page.nextCursor);
    setListLoaded(true);
  }, []);

  // Mount: fetch status, then the newest page (only when a mailbox exists).
  // Reconcile-on-open (user decision 2026-10-11): opening the inbox enqueues a
  // DURABLE sync job so the local mirror catches up. The dedupeKey on the job
  // means a repeat open while one is already pending/running is a no-op — no
  // duplicate jobs, no duplicate messages (spec §6). No Gmail call here.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadStatus();
        if (cancelled) return;
        if (next?.connected) {
          if (!next.reconnectRequired) {
            // Fire-and-forget reconcile; the status poll below picks up the result.
            void startGmailSync()
              .then(() => loadStatus().then((s) => !cancelled && setStatus(s)))
              .catch(() => {
                /* a failed reconcile must not block reading the existing mirror */
              });
          }
          await loadFirstPage();
        }
      } catch (error_) {
        if (cancelled) return;
        if (error_ instanceof ApiError && (isSessionLoss(error_) || error_.status === 401)) return;
        setError(error_ instanceof ApiError ? error_.message : "Could not reach the server.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadStatus, loadFirstPage]);

  async function onSyncNow(): Promise<void> {
    playSound("ui-click");
    setBusy(true);
    setError("");
    try {
      await startGmailSync();
      setStatus((prev) => (prev ? { ...prev, status: "syncing", syncInFlight: true } : prev));
      // Poll status until the worker settles it, then reload the list.
      await settleSync();
    } catch (error_) {
      setBusy(false);
      if (error_ instanceof ApiError && isSessionLoss(error_)) {
        reportSessionLost(error_.code);
        return;
      }
      if (error_ instanceof ApiError && error_.code === "RECONNECT_REQUIRED") {
        setStatus((prev) => (prev ? { ...prev, status: "reconnect_required", reconnectRequired: true } : prev));
      }
      setError(error_ instanceof ApiError ? error_.message : "Could not reach the server.");
    }
  }

  /** Reconcile-on-open: poll the durable job's outcome (bounded attempts). */
  async function settleSync(): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      try {
        const next = await loadStatus();
        if (!next || !next.syncInFlight) {
          if (next?.connected) await loadFirstPage();
          setBusy(false);
          return;
        }
      } catch {
        break;
      }
    }
    setBusy(false);
  }

  async function onOpenMessage(messageId: string): Promise<void> {
    playSound("ui-click");
    setError("");
    try {
      const detail = await fetchGmailMessage(messageId);
      setSelected(detail);
      // Reflect read-state locally (the row was unread).
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, isUnread: false } : m)));
    } catch (error_) {
      if (error_ instanceof ApiError && isSessionLoss(error_)) {
        reportSessionLost(error_.code);
        return;
      }
      setError(error_ instanceof ApiError ? error_.message : "Could not load the message.");
    }
  }

  async function onLoadMore(): Promise<void> {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await fetchGmailMessages(nextCursor);
      setMessages((prev) => [...prev, ...page.messages]);
      setNextCursor(page.nextCursor);
    } catch (error_) {
      if (error_ instanceof ApiError && isSessionLoss(error_)) {
        reportSessionLost(error_.code);
        return;
      }
      setError(error_ instanceof ApiError ? error_.message : "Could not load more.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm opacity-70">Loading inbox…</p>;
  }

  // No connected mailbox — point at the Google connection card in Settings.
  if (!status?.connected) {
    return (
      <div className="rounded border-2 border-[var(--mailxp-walnut)]/40 bg-white/60 p-4 text-sm">
        <h3 className="font-bold text-[var(--mailxp-teal)]">No mailbox connected</h3>
        <p className="mt-1 opacity-80">
          Connect a real Gmail in Settings → Google to fill your inbox.
        </p>
      </div>
    );
  }

  // A selected message — plain-text reader (never HTML).
  if (selected) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => {
            playSound("ui-click");
            setSelected(null);
          }}
          className="self-start rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1 text-sm font-bold transition hover:bg-white/70"
        >
          ← Back to inbox
        </button>
        <article className="rounded border-2 border-[var(--mailxp-walnut)]/40 bg-white/70 p-3">
          <h3 className="font-bold text-[var(--mailxp-teal)]">{selected.subject ?? "(no subject)"}</h3>
          <p className="text-xs opacity-70">
            {selected.sender} · {new Date(selected.receivedAt).toLocaleString()}
          </p>
          <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">
            {selected.bodyText ?? "(no preview available)"}
          </pre>
          {selected.attachments.length > 0 ? (
            <ul className="mt-3 border-t border-[var(--mailxp-walnut)]/30 pt-2 text-xs opacity-80">
              {selected.attachments.map((attachment, index) => (
                <li key={`${attachment.filename}-${index}`}>
                  📎 {attachment.filename}{" "}
                  <span className="opacity-60">
                    ({attachment.mimeType}, {formatSize(attachment.size)})
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </article>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Sync status banner — honest about delayed / error / reconnect. */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs opacity-80">
          <span className="font-semibold">{status.email}</span>
          <span> · {status.messageCount} messages</span>
          {status.unreadCount > 0 ? <span> · {status.unreadCount} unread</span> : null}
          <div className="opacity-70">{describeStatus(status)}</div>
        </div>
        <button
          type="button"
          disabled={busy || status.reconnectRequired}
          onClick={() => void onSyncNow()}
          className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1 text-sm font-bold transition hover:bg-white/70 disabled:opacity-50"
        >
          {busy || status.syncInFlight ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {status.reconnectRequired ? (
        <p role="alert" className="rounded border border-amber-600/50 bg-amber-100/80 px-2 py-1.5 text-xs text-amber-900">
          This mailbox needs reconnecting in Settings → Google before it can sync again.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded border border-red-700/50 bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {error}
        </p>
      ) : null}

      {!listLoaded || messages.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {messages.map((message) => (
            <li key={message.id}>
              <button
                type="button"
                onClick={() => void onOpenMessage(message.id)}
                className={`w-full rounded border border-[var(--mailxp-walnut)]/30 px-2 py-1.5 text-left transition hover:bg-white/70 ${
                  message.isUnread ? "bg-white/80 font-semibold" : "bg-white/40"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate font-bold text-[var(--mailxp-teal)]">{message.sender}</span>
                  <span className="shrink-0 opacity-60">{formatDate(message.receivedAt)}</span>
                </div>
                <div className="truncate text-sm">{message.subject ?? "(no subject)"}</div>
                {message.snippet ? (
                  <div className="truncate text-xs opacity-70">{message.snippet}</div>
                ) : null}
                {message.hasAttachments ? (
                  <div className="text-xs opacity-60">📎 {message.attachmentCount}</div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {listLoaded && messages.length === 0 && status.status === "synced" ? (
        <p className="rounded border-2 border-[var(--mailxp-walnut)]/30 bg-white/50 p-4 text-center text-sm opacity-70">
          Your inbox is empty.
        </p>
      ) : null}

      {nextCursor ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void onLoadMore()}
          className="rounded border-2 border-[var(--mailxp-walnut)] px-3 py-1 text-sm font-bold transition hover:bg-white/70 disabled:opacity-50"
        >
          {busy ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

function describeStatus(status: GmailSyncStatusDto): string {
  switch (status.status) {
    case "syncing":
      return "Syncing…";
    case "synced":
      return status.lastSuccessAt ? `Synced ${new Date(status.lastSuccessAt).toLocaleTimeString()}` : "Synced";
    case "delayed":
      return "Sync delayed — will retry.";
    case "error":
      return "Sync hit a snag — try again.";
    case "reconnect_required":
      return "Needs reconnect.";
    default:
      return "Not synced yet.";
  }
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
