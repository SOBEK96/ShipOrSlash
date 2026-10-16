"use client";

import { useEffect, useMemo, useState } from "react";
import type { CreateVaultInput } from "@/lib/contract";
import { formatGen, isAddress, parseGen, sameAddress } from "@/lib/format";
import {
  MAX_WINDOW_S,
  MIN_DEPOSIT,
  MIN_DEADLINE_DAYS,
  MIN_DEADLINE_S,
  assessFeeds,
  canonHash,
  fingerprintHash,
  normalizeRepo,
  trancheAmounts,
  validArtifactTarget,
} from "@/lib/protocol";
import { Button, Card, Field, Pill, inputClass } from "./ui";

/** Commit that holds the demo mirror fixtures. Override at build time with
 * NEXT_PUBLIC_FEED_PIN to point the defaults at another commit. */
const PIN = process.env.NEXT_PUBLIC_FEED_PIN ?? "2d32a3d0968cb48960374dcceb7a0f75434e4d59";
const DEFAULT_FEEDS = {
  a: `https://raw.githubusercontent.com/SOBEK96/ShipOrSlash/${PIN}/deployments/mock_feeds/a/`,
  b: `https://cdn.jsdelivr.net/gh/SOBEK96/ShipOrSlash@${PIN}/deployments/mock_feeds/b/`,
  c: `https://raw.githack.com/SOBEK96/ShipOrSlash/${PIN}/deployments/mock_feeds/c/`,
};
const DEMO_FINGERPRINT = "3AA5 C34371567BD2 5FA4E14A9D8C1B7E00F26A41";

export function VaultCreator({
  account,
  busy,
  onCreate,
}: {
  account: string | null;
  busy: string | null;
  onCreate: (input: CreateVaultInput) => void;
}) {
  const [beneficiary, setBeneficiary] = useState("");
  const [deposit, setDeposit] = useState("0.5");
  const [repo, setRepo] = useState("https://github.com/SOBEK96/ShipOrSlash");
  const [fingerprint, setFingerprint] = useState(DEMO_FINGERPRINT);
  const [signerHash, setSignerHash] = useState("");
  const [prefix, setPrefix] = useState<"" | "v">("v");
  const [npm, setNpm] = useState("@sobek96/shiporslash");
  const [docker, setDocker] = useState("sobek96/shiporslash");
  const [feedA, setFeedA] = useState(DEFAULT_FEEDS.a);
  const [feedB, setFeedB] = useState(DEFAULT_FEEDS.b);
  const [feedC, setFeedC] = useState(DEFAULT_FEEDS.c);
  const [days, setDays] = useState("30");

  // The committed signer is the SHA-256 of the fingerprint, hashed in-browser.
  useEffect(() => {
    let live = true;
    void fingerprintHash(fingerprint).then((h) => {
      if (live) setSignerHash(fingerprint.trim() === "" ? "" : h);
    });
    return () => {
      live = false;
    };
  }, [fingerprint]);

  const check = useMemo(() => {
    const dep = parseGen(deposit);
    const repoNorm = normalizeRepo(repo);
    const feeds = assessFeeds([feedA, feedB, feedC]);
    const d = /^[0-9]+$/.test(days) ? Number(days) : NaN;
    const secs = d * 86_400;
    return {
      dep,
      depError:
        dep === null ? "Enter an amount like 0.5." : dep < MIN_DEPOSIT ? "Minimum deposit is 0.001 GEN." : null,
      benError:
        beneficiary === ""
          ? null
          : !isAddress(beneficiary)
            ? "Enter a 0x wallet address."
            : sameAddress(beneficiary, account)
              ? "The beneficiary must be a different wallet from yours."
              : null,
      repoNorm,
      repoError: repoNorm === "" ? "Use https://github.com/<owner>/<repo> or a GitLab equivalent." : null,
      signerOk: canonHash(signerHash) !== "",
      npmOk: validArtifactTarget(npm),
      dockerOk: validArtifactTarget(docker),
      targetError:
        npm === "" && docker === ""
          ? "Commit at least one package target."
          : !validArtifactTarget(npm) || !validArtifactTarget(docker)
            ? "Package names cannot contain spaces or quotes."
            : null,
      feeds,
      daysError:
        !Number.isFinite(d) || secs < MIN_DEADLINE_S || secs > MAX_WINDOW_S ? `Choose ${MIN_DEADLINE_DAYS} to 1825 days.` : null,
      days: d,
      split: dep !== null && dep >= MIN_DEPOSIT ? trancheAmounts(dep) : null,
    };
  }, [account, beneficiary, deposit, days, docker, feedA, feedB, feedC, npm, repo, signerHash]);

  const valid =
    account !== null &&
    beneficiary !== "" &&
    check.benError === null &&
    check.depError === null &&
    check.repoError === null &&
    check.signerOk &&
    check.targetError === null &&
    check.feeds.independent &&
    check.daysError === null;

  function submit() {
    if (!valid || check.dep === null) return;
    onCreate({
      beneficiary,
      repoUrl: repo,
      signerHash,
      tagPrefix: prefix,
      npmPackage: npm,
      dockerImage: docker,
      feedA,
      feedB,
      feedC,
      deadlineDays: check.days,
      deposit: check.dep,
    });
  }

  return (
    <Card
      id="create"
      title="Create a vault offer"
      aside={<Pill tone="muted">registry is immutable once created</Pill>}
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="rounded-md border border-hold/50 bg-hold-soft px-3 py-2 text-xs text-hold-ink">
          <strong>This creates an offer, not a live vault.</strong> You choose the repository, the signer and the three
          verifier mirrors, so the beneficiary gets 48 hours to inspect them and accept. Your deposit is escrowed meanwhile.
          If they reject it or let the window lapse, you can cancel and recover the whole deposit with no penalty.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Beneficiary wallet" error={check.benError} hint="The project that earns the tranches.">
            <input className={inputClass} value={beneficiary} onChange={(e) => setBeneficiary(e.target.value.trim())} placeholder="0x…" spellCheck={false} />
          </Field>
          <Field label="Deposit (GEN)" error={check.depError} hint="Escrowed now, released in three tranches.">
            <input className={inputClass} inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} />
          </Field>
        </div>

        {check.split ? (
          <p className="rounded-md border border-line bg-canvas px-3 py-2 text-xs text-muted">
            Split: <span className="font-mono text-ink">{formatGen(check.split[0])}</span> (20%) ·{" "}
            <span className="font-mono text-ink">{formatGen(check.split[1])}</span> (30%) ·{" "}
            <span className="font-mono text-ink">{formatGen(check.split[2])}</span> (50%) GEN. The last tranche absorbs
            every rounding remainder.
          </p>
        ) : null}

        <fieldset className="space-y-4 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-semibold text-muted">Repository registry</legend>
          <Field label="Repository" error={check.repoError}>
            <input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value.trim())} spellCheck={false} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Signer GPG fingerprint"
              hint={check.signerOk ? `Committed as sha256 ${signerHash.slice(0, 16)}…` : "Hashed in your browser; only the digest goes on-chain."}
            >
              <input className={inputClass} value={fingerprint} onChange={(e) => setFingerprint(e.target.value)} spellCheck={false} />
            </Field>
            <Field label="Tag format" hint="SemVer 2.0.0. Tags must carry this prefix exactly.">
              <select className={inputClass} value={prefix} onChange={(e) => setPrefix(e.target.value === "v" ? "v" : "")}>
                <option value="v">v1.2.3</option>
                <option value="">1.2.3</option>
              </select>
            </Field>
            <Field label="npm package" error={check.npmOk ? null : "Invalid package name."}>
              <input className={inputClass} value={npm} onChange={(e) => setNpm(e.target.value.trim())} spellCheck={false} />
            </Field>
            <Field label="Docker image" error={check.dockerOk ? null : "Invalid image name."}>
              <input className={inputClass} value={docker} onChange={(e) => setDocker(e.target.value.trim())} spellCheck={false} />
            </Field>
          </div>
          {check.targetError ? (
            <p role="alert" className="text-xs text-slash">
              {check.targetError}
            </p>
          ) : null}
        </fieldset>

        <fieldset className="space-y-4 rounded-md border border-line p-3">
          <legend className="px-1 text-xs font-semibold text-muted">Verifier mirrors (three hosts, three operators)</legend>
          {(
            [
              ["A", "GitHub release verifier", feedA, setFeedA],
              ["B", "CI/CD status mirror", feedB, setFeedB],
              ["C", "Package registry mirror", feedC, setFeedC],
            ] as const
          ).map(([slot, label, value, set], i) => (
            <Field key={slot} label={`Slot ${slot} · ${label}`}>
              <input className={inputClass} value={value} onChange={(e) => set(e.target.value.trim())} spellCheck={false} />
              <span className="mt-1 block text-xs text-muted">
                {check.feeds.hosts[i] ? `${check.feeds.hosts[i]} · operator ${check.feeds.operators[i]}` : " "}
              </span>
            </Field>
          ))}
          {check.feeds.problems.map((p) => (
            <p key={p} role="alert" className="text-xs text-slash">
              {p}
            </p>
          ))}
        </fieldset>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <Field
            label="Deadline (days from now)"
            error={check.daysError}
            hint="After this, the funder may slash unshipped tranches. The minimum is 3 days: the 48-hour acceptance window plus one full day to ship. One hour is added so the deadline still clears that after network delay."
          >
            <input className={`${inputClass} w-28`} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.trim())} />
          </Field>
          <Button type="submit" tone="primary" disabled={!valid || busy !== null}>
            {busy === "Creating vault" ? "Creating offer…" : "Create offer and deposit"}
          </Button>
        </div>
        {account === null ? <p className="text-xs text-muted">Connect a wallet to create a vault.</p> : null}
      </form>
    </Card>
  );
}
