import { ATTO } from "./protocol";

/** Wei -> "0.5" GEN, integer arithmetic only. Trims trailing zeros. */
export function formatGen(wei: bigint, maxDecimals = 6): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / ATTO;
  const frac = (abs % ATTO).toString().padStart(18, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

/** "0.5" -> wei. Rejects anything that is not a plain decimal with <= 18 places. */
export function parseGen(input: string): bigint | null {
  const s = input.trim();
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(s)) return null;
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * ATTO + BigInt(f.padEnd(18, "0"));
}

/** Basis points -> "20%" (integer percent, or two-decimal where needed). */
export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = bps % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
}

export function shortHash(h: string, head = 6, tail = 4): string {
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Unix seconds -> "2026-10-15 19:06 UTC". Deterministic, locale-free. */
export function formatUtc(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "—";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** Seconds -> "12d 3h" style countdown. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s) && !/^0x0{40}$/i.test(s);
}
