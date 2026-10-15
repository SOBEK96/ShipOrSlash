import { Card } from "./ui";

const CARDS = [
  {
    title: "Milestones, not calendars",
    body: "Vesting that pays on a date pays founders who ship nothing. Here a tranche unlocks only when a signed SemVer release exists, its CI passed, and its package is published. Tranches are fixed at 20%, 30% and 50%, in integer basis points, with no rounding drift.",
  },
  {
    title: "Three hosts, three operators",
    body: "Each vault commits three verifier mirrors on three different hostnames run by three different operators. Two must agree on the same tag and commit. One compromised or lagging mirror can neither release funds nor block them.",
  },
  {
    title: "Outages never punish",
    body: "If fewer than two mirrors answer, or the silent one could still complete the quorum, the result is retryable. It records an attempt and nothing else: no penalty, no lock-out, no slashing for someone else's downtime.",
  },
  {
    title: "Capital stays escrowed",
    body: "Unshipped tranches sit in the contract. The registry (repository, signer, package targets, mirrors) cannot be edited after creation. If the project misses the deadline, the funder slashes what was not shipped. Released tranches are pulled by the beneficiary, never pushed.",
  },
];

export function ProtocolExplainer() {
  return (
    <section aria-labelledby="how" className="space-y-3">
      <h2 id="how" className="text-sm font-semibold">
        How the protocol decides
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        {CARDS.map((c) => (
          <Card key={c.title} title={c.title}>
            <p className="text-sm leading-6 text-muted">{c.body}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
