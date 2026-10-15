import type { SyncStatus } from "@/lib/useConsole";
import { Button } from "./ui";

const ITEM_LABEL: Record<string, string> = {
  vault: "vault state",
  sources: "verifier sources",
  m1: "tranche 1",
  m2: "tranche 2",
  m3: "tranche 3",
  protocol: "protocol totals",
};

/** Honest connection state. A partial failure names the items that are stale
 * and says they are still showing their last good value. */
export function SyncAlert({
  sync,
  now,
  onRetry,
}: {
  sync: SyncStatus;
  now: number;
  onRetry: () => void;
}) {
  if (sync.phase === "ok" || sync.phase === "idle") {
    if (sync.phase === "idle") return null;
    return (
      <p role="status" className="text-xs text-muted">
        Synced {sync.lastSyncedAt ? ago(now - sync.lastSyncedAt) : "just now"} from Studio Next.
      </p>
    );
  }
  if (sync.phase === "syncing") {
    return (
      <p role="status" className="text-xs text-muted">
        Reading the chain…
      </p>
    );
  }
  const items = sync.failedItems.map((k) => ITEM_LABEL[k] ?? k);
  const down = sync.phase === "down";
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
        down ? "border-slash/40 bg-slash-soft text-[#a40e26]" : "border-hold/50 bg-hold-soft text-hold-ink"
      }`}
    >
      <span>
        {down ? (
          <>
            <strong>Studio Next is not answering.</strong> What you see was last read{" "}
            {sync.lastSyncedAt ? ago(now - sync.lastSyncedAt) : "before this session"} and may be out of date.
          </>
        ) : (
          <>
            <strong>Partial read.</strong> {items.join(", ")} could not be refreshed and{" "}
            {items.length === 1 ? "is" : "are"} showing the last value received. The rest is current.
          </>
        )}
        {sync.error ? <span className="mt-0.5 block font-mono text-xs opacity-80">{sync.error}</span> : null}
      </span>
      <Button onClick={onRetry}>Retry now</Button>
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}
