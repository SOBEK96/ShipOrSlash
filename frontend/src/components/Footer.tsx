import { CONTRACT_ADDRESS, DEFAULT_NETWORK, explorerAddressUrl } from "@/lib/networks";
import { shortHash } from "@/lib/format";

export function Footer({ contractAddress = CONTRACT_ADDRESS }: { contractAddress?: string }) {
  return (
    <footer className="mt-10 border-t border-line bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs text-muted">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-ink">ShipOrSlash</span>
          <span>{DEFAULT_NETWORK.label} · chain {DEFAULT_NETWORK.chainId}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span>Contract</span>
          <a
            className="rounded-md border border-line bg-canvas px-2 py-0.5 font-mono text-ink"
            href={explorerAddressUrl(DEFAULT_NETWORK, contractAddress)}
            target="_blank"
            rel="noreferrer"
            title={contractAddress}
          >
            {shortHash(contractAddress, 8, 6)}
          </a>
          <a href="https://github.com/SOBEK96/ShipOrSlash" target="_blank" rel="noreferrer">
            Source
          </a>
        </div>
      </div>
    </footer>
  );
}
