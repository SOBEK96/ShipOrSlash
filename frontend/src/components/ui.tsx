import type { ReactNode } from "react";

export type Tone = "ship" | "hold" | "slash" | "muted" | "link";

const TONES: Record<Tone, string> = {
  ship: "bg-ship-soft text-[#116329] border-ship/40",
  hold: "bg-hold-soft text-hold-ink border-hold/50",
  slash: "bg-slash-soft text-[#a40e26] border-slash/40",
  muted: "bg-inset text-muted border-line",
  link: "bg-[#ddf4ff] text-[#0550ae] border-link/30",
};

export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium leading-5 ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code title={title} className="rounded-md bg-inset px-1.5 py-0.5 font-mono text-[12px] text-ink">
      {children}
    </code>
  );
}

/** A SemVer release tag, set apart the way a GitHub label is. */
export function SemverBadge({ tag, empty = "no tag yet" }: { tag: string; empty?: string }) {
  if (!tag) return <span className="font-mono text-xs text-muted">{empty}</span>;
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-surface px-1.5 py-0.5 font-mono text-xs font-semibold text-ink">
      {tag}
    </span>
  );
}

export function Card({
  title,
  aside,
  children,
  id,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className="rounded-md border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas px-4 py-2.5">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {aside}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  tone = "default",
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "default" | "primary" | "danger";
  type?: "button" | "submit";
  title?: string;
}) {
  const base =
    "inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50";
  const look =
    tone === "primary"
      ? "border-[#1f883d] bg-ship text-white enabled:hover:bg-[#2c974b]"
      : tone === "danger"
        ? "border-line bg-surface text-slash enabled:hover:border-slash enabled:hover:bg-slash-soft"
        : "border-line bg-canvas text-ink enabled:hover:bg-inset";
  return (
    <button type={type} title={title} onClick={onClick} disabled={disabled} className={`${base} ${look}`}>
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink">{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-slash">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-muted">{hint}</span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-muted/70";
