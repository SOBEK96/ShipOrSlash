export interface NetworkConfig {
  key: string;
  label: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  /** Name of the chain object genlayer-js ships for this network. */
  sdkChain: "studioDevnet" | "studionet";
}

/**
 * GenLayer Studio Next. Chain 61997 is served by two hostnames that answer
 * identically (`studio-next` and `studio-dev`); the brief names studio-next and
 * the explorer matches it. Override per deployment with
 * NEXT_PUBLIC_GENLAYER_RPC_URL.
 */
export const STUDIO_NEXT: NetworkConfig = {
  key: "studio-next",
  label: "GenLayer Studio Next",
  chainId: 61997,
  rpcUrl: process.env.NEXT_PUBLIC_GENLAYER_RPC_URL ?? "https://studio-next.genlayer.com/api",
  explorerUrl: "https://explorer-studio-next.genlayer.com",
  sdkChain: "studioDevnet",
};

export const DEFAULT_NETWORK = STUDIO_NEXT;

/** The deployed ShipOrSlash contract. Set NEXT_PUBLIC_SHIPORSLASH_ADDRESS to
 * point the console at a different instance without a code change. */
export const CONTRACT_ADDRESS =
  process.env.NEXT_PUBLIC_SHIPORSLASH_ADDRESS ?? "0xe5578Ae6bc82767F86EC6Ff158A113bAF224E271";

export function explorerAddressUrl(net: NetworkConfig, address: string): string {
  return `${net.explorerUrl}/address/${address}`;
}

export function explorerTxUrl(net: NetworkConfig, hash: string): string {
  return `${net.explorerUrl}/tx/${hash}`;
}
