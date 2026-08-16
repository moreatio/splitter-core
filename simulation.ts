/**
 * simulation.ts — Der Härtetest aus der Modell-Diskussion.
 *
 * Teil A: gezielte Unit-Checks für die Randfälle aus dem ERM-Review.
 * Teil B: Zufallssimulation — hunderte Transaktionen über mehrere Logs,
 *         User und Währungen; alle Logs schließen; alle Root-Claims
 *         setteln; dann die Kern-Assertion:
 *
 *              JEDER ROOT STEHT EXAKT AUF 0.
 *
 * Der Zufall ist GESEEDET (deterministisches PRNG) — ein Fehlschlag ist
 * damit exakt reproduzierbar, was bei Rundungs-Bugs Gold wert ist.
 *
 * Ausführen:  npx tsx test/simulation.ts
 */

import { closeLog } from '../src/closing.js';
import { convertMinor, computeLogPairBalances, pairKeyString } from '../src/netting.js';
import { computeShares, splitEqually, InvariantViolation } from '../src/split.js';
import { applyTransferToClaims } from '../src/settlement.js';
import {
  Claim,
  FX_SCALE,
  FxRate,
  fxKey,
  Log,
  Minor,
  Transaction,
  UserId,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Mini-Test-Infrastruktur (kein Framework nötig)
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✘ ${name}\n     ${(e as Error).message}`);
  }
}

function assertEq<T>(actual: T, expected: T, msg = ''): void {
  if (actual !== expected) {
    throw new Error(`${msg} — erwartet ${expected}, erhalten ${actual}`);
  }
}

function assertThrows(fn: () => void, msg = ''): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${msg} — erwarteter Fehler blieb aus`);
}

/** Deterministisches PRNG (mulberry32) — Simulation ist reproduzierbar. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
const newId = () => `id-${String(++idCounter).padStart(6, '0')}`;

// ---------------------------------------------------------------------------
// Teil A — gezielte Randfall-Tests
// ---------------------------------------------------------------------------
console.log('\nTeil A: Randfall-Tests');

check('Gleichverteilung: Summe der Anteile == Betrag (Largest Remainder)', () => {
  const shares = splitEqually(100n, ['u-c', 'u-a', 'u-b']);
  const sum = [...shares.values()].reduce((a, b) => a + b, 0n);
  assertEq(sum, 100n, 'Summe');
  // 100 / 3 → [34, 33, 33]; Extra-Cent an den lexikografisch ersten (u-a)
  assertEq(shares.get('u-a'), 34n, 'u-a');
  assertEq(shares.get('u-b'), 33n, 'u-b');
  assertEq(shares.get('u-c'), 33n, 'u-c');
});

check('Szenario "A zahlt für B" (Root-Fall): voller Claim bei B', () => {
  const tx: Transaction = {
    transactionId: newId(), logId: 'root-ab', payerUserId: 'u-a',
    amountMinor: 3000n, currency: 'EUR', kind: 'expense',
    subexpenses: [{ amountMinor: 3000n, allocatedTo: ['u-b'] }],
  };
  const shares = computeShares(tx, ['u-a', 'u-b']);
  assertEq(shares.get('u-b'), 3000n, 'Anteil B');
  assertEq(shares.get('u-a') ?? 0n, 0n, 'Anteil A');
});

check('Unallokierter Rest ist Eigenanteil des Payers (kein Claim)', () => {
  const tx: Transaction = {
    transactionId: newId(), logId: 'l1', payerUserId: 'u-a',
    amountMinor: 3000n, currency: 'EUR', kind: 'expense',
    subexpenses: [{ amountMinor: 1000n, allocatedTo: ['u-b'] }],
  };
  const shares = computeShares(tx, ['u-a', 'u-b']);
  assertEq(shares.get('u-b'), 1000n);
  assertEq(shares.get('u-a'), 2000n); // Rest 20 € gehört A selbst
  // Paar-Saldo: B schuldet A genau 10 €
  const balances = computeLogPairBalances('EUR', [tx], ['u-a', 'u-b'], new Map());
  assertEq(balances.length, 1);
  assertEq(balances[0].amountSigned > 0n ? balances[0].userLow : balances[0].userHigh, 'u-b');
});

check('Randfall 1: Payer ist kein Log-Member → Fehler', () => {
  const tx: Transaction = {
    transactionId: newId(), logId: 'l1', payerUserId: 'u-x',
    amountMinor: 1000n, currency: 'EUR', kind: 'expense', subexpenses: [],
  };
  assertThrows(() => computeShares(tx, ['u-a', 'u-b']), 'Nicht-Member als Payer');
});

check('Randfall Allocation an Nicht-Member → Fehler', () => {
  const tx: Transaction = {
    transactionId: newId(), logId: 'l1', payerUserId: 'u-a',
    amountMinor: 1000n, currency: 'EUR', kind: 'expense',
    subexpenses: [{ amountMinor: 1000n, allocatedTo: ['u-fremd'] }],
  };
  assertThrows(() => computeShares(tx, ['u-a', 'u-b']), 'Allocation an Fremden');
});

check('Randfall 3: Überzahlung wird abgelehnt (Σ Settlements <= Claim)', () => {
  const claim: Claim = {
    claimId: 'c1', logId: 'root-ab', debtorUserId: 'u-b', creditorUserId: 'u-a',
    amountMinor: 1000n, status: 'open', transferredToClaimId: null,
  };
  assertThrows(() =>
    applyTransferToClaims(
      { transferId: 't1', senderUserId: 'u-b', receiverUserId: 'u-a', amountMinor: 1500n, currency: 'EUR' },
      [claim],
      new Map(),
    ),
  );
});

check('Randfall 4: Teilzahlung — Claim bleibt offen, Rest korrekt', () => {
  const claim: Claim = {
    claimId: 'c1', logId: 'root-ab', debtorUserId: 'u-b', creditorUserId: 'u-a',
    amountMinor: 1000n, status: 'open', transferredToClaimId: null,
  };
  const res = applyTransferToClaims(
    { transferId: 't1', senderUserId: 'u-b', receiverUserId: 'u-a', amountMinor: 400n, currency: 'EUR' },
    [claim],
    new Map(),
  );
  assertEq(res.settledClaimIds.length, 0, 'nichts voll getilgt');
  assertEq(res.remainingByClaimId.get('c1'), 600n, 'Rest');
});

check('Randfall 5: Paar-Saldo 0 nach Netting → Claims netted_out, kein Root', () => {
  // A zahlt 10 € für B, B zahlt 10 € für A → Saldo 0.
  const txs: Transaction[] = [
    { transactionId: newId(), logId: 'l1', payerUserId: 'u-a', amountMinor: 1000n,
      currency: 'EUR', kind: 'expense', subexpenses: [{ amountMinor: 1000n, allocatedTo: ['u-b'] }] },
    { transactionId: newId(), logId: 'l1', payerUserId: 'u-b', amountMinor: 1000n,
      currency: 'EUR', kind: 'expense', subexpenses: [{ amountMinor: 1000n, allocatedTo: ['u-a'] }] },
  ];
  const log: Log = { logId: 'l1', type: 'log', status: 'closing', baseCurrency: 'EUR' };
  const oldClaim: Claim = {
    claimId: 'c-old', logId: 'l1', debtorUserId: 'u-b', creditorUserId: 'u-a',
    amountMinor: 1000n, status: 'open', transferredToClaimId: null,
  };
  const effects = closeLog({
    log, transactions: txs, activeMembers: ['u-a', 'u-b'],
    openLogClaims: [oldClaim], existingRoots: new Map(), openRootClaims: new Map(),
    newRootCurrency: () => 'EUR', fxRates: new Map(), newId,
  });
  assertEq(effects.createRoots.length, 0, 'kein Root nötig');
  assertEq(effects.createClaims.length, 0, 'kein Root-Claim');
  assertEq(effects.updateClaims[0].newStatus, 'netted_out');
  assertEq(effects.updateClaims[0].transferredToClaimId, null);
});

check('Randfall 6: FX — Log in CHF, Root in EUR, Stichtagskurs persistierbar', () => {
  const rate: FxRate = { from: 'CHF', to: 'EUR', rateScaled: 10_537_000_000n }; // 1.0537
  const fx = new Map([[fxKey('CHF', 'EUR'), rate]]);
  // B schuldet A 100 CHF aus dem Log …
  const tx: Transaction = {
    transactionId: newId(), logId: 'l-chf', payerUserId: 'u-a', amountMinor: 10_000n,
    currency: 'CHF', kind: 'expense', subexpenses: [{ amountMinor: 10_000n, allocatedTo: ['u-b'] }],
  };
  const log: Log = { logId: 'l-chf', type: 'log', status: 'closing', baseCurrency: 'CHF' };
  const effects = closeLog({
    log, transactions: [tx], activeMembers: ['u-a', 'u-b'],
    openLogClaims: [], existingRoots: new Map(), openRootClaims: new Map(),
    newRootCurrency: () => 'EUR', fxRates: fx, newId,
  });
  // … das sind zum Stichtag 105.37 EUR im Root.
  assertEq(effects.createClaims[0].amountMinor, 10_537n, 'konvertierter Root-Claim');
  // Symmetrie der Rundung: convert(-x) === -convert(x)
  assertEq(convertMinor(-10_000n, rate.rateScaled), -10_537n, 'symmetrische Rundung');
});

check('Netting gegen bestehenden Root-Saldo in Gegenrichtung', () => {
  // Root sagt: A schuldet B 10 €. Log ergibt: B schuldet A 6 €. → A schuldet B 4 €.
  const tx: Transaction = {
    transactionId: newId(), logId: 'l1', payerUserId: 'u-a', amountMinor: 600n,
    currency: 'EUR', kind: 'expense', subexpenses: [{ amountMinor: 600n, allocatedTo: ['u-b'] }],
  };
  const log: Log = { logId: 'l1', type: 'log', status: 'closing', baseCurrency: 'EUR' };
  const root: Log = { logId: 'root-ab', type: 'root', status: 'open', baseCurrency: 'EUR' };
  const rootClaim: Claim = {
    claimId: 'c-root', logId: 'root-ab', debtorUserId: 'u-a', creditorUserId: 'u-b',
    amountMinor: 1000n, status: 'open', transferredToClaimId: null,
  };
  const pKey = pairKeyString('u-a', 'u-b');
  const effects = closeLog({
    log, transactions: [tx], activeMembers: ['u-a', 'u-b'],
    openLogClaims: [], existingRoots: new Map([[pKey, root]]),
    openRootClaims: new Map([[pKey, rootClaim]]),
    newRootCurrency: () => 'EUR', fxRates: new Map(), newId,
  });
  const c = effects.createClaims[0];
  assertEq(c.debtorUserId, 'u-a', 'Richtung bleibt A→B');
  assertEq(c.amountMinor, 400n, 'genetteter Betrag');
  // Alter Root-Claim wurde abgelöst und verweist auf den neuen.
  const upd = effects.updateClaims.find((u) => u.claimId === 'c-root')!;
  assertEq(upd.newStatus, 'transferred');
  assertEq(upd.transferredToClaimId, c.claimId);
});

check('Root kann nicht geschlossen werden', () => {
  const root: Log = { logId: 'r1', type: 'root', status: 'open', baseCurrency: 'EUR' };
  assertThrows(() =>
    closeLog({
      log: root, transactions: [], activeMembers: [], openLogClaims: [],
      existingRoots: new Map(), openRootClaims: new Map(),
      newRootCurrency: () => 'EUR', fxRates: new Map(), newId,
    }),
  );
});

// ---------------------------------------------------------------------------
// Teil B — Zufallssimulation: "Alle Roots gehen exakt auf 0"
// ---------------------------------------------------------------------------
console.log('\nTeil B: Zufallssimulation');

function runSimulation(seed: number, nLogs: number, nTxPerLog: number): void {
  const rng = makeRng(seed);
  const users: UserId[] = ['u-anna', 'u-ben', 'u-cara', 'u-dave', 'u-emil'];
  const currencies = ['EUR', 'CHF', 'USD'];

  // Feste Kurstabelle (Stichtag) — alle Paare in beide Richtungen.
  // Hinweis: bewusst NICHT exakt invers zueinander; das simuliert reale
  // Referenzkurse und testet, dass die Logik daran nicht zerbricht,
  // solange pro Konvertierung genau EIN Kurs benutzt wird.
  const fx = new Map<string, FxRate>();
  const rawRates: Array<[string, string, bigint]> = [
    ['EUR', 'CHF', 9_490_000_000n], ['CHF', 'EUR', 10_537_000_000n],
    ['EUR', 'USD', 10_820_000_000n], ['USD', 'EUR', 9_242_000_000n],
    ['CHF', 'USD', 11_400_000_000n], ['USD', 'CHF', 8_772_000_000n],
  ];
  for (const [from, to, rateScaled] of rawRates) {
    fx.set(fxKey(from, to), { from, to, rateScaled });
  }

  // Zustand der "Welt": Roots + deren offener Claim, wie ihn eine DB hielte.
  const roots = new Map<string, Log>();               // Paar-String → Root
  const openRootClaims = new Map<string, Claim>();    // Paar-String → offener Claim

  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

  for (let l = 0; l < nLogs; l++) {
    // Zufälliges Log: 2–5 Member, zufällige Basiswährung.
    const memberCount = 2 + Math.floor(rng() * 4);
    const members = [...users].sort(() => rng() - 0.5).slice(0, memberCount);
    const log: Log = {
      logId: newId(), type: 'log', status: 'closing', baseCurrency: pick(currencies),
    };

    // Zufällige Transaktionen: mal Gleichverteilung, mal Subexpenses,
    // mal Fremdwährung — genau der Mix, der Rundungsfehler provoziert.
    const txs: Transaction[] = [];
    for (let t = 0; t < nTxPerLog; t++) {
      const payer = pick(members);
      const amount = BigInt(1 + Math.floor(rng() * 50_000)); // bis 500.00
      const useSub = rng() < 0.5;
      let subexpenses: Transaction['subexpenses'] = [];
      if (useSub) {
        // Ein Subexpense über einen Teilbetrag an eine zufällige Teilmenge.
        const subAmount = BigInt(1 + Math.floor(rng() * Number(amount)));
        const subMembers = members.filter(() => rng() < 0.6);
        if (subMembers.length === 0) subMembers.push(pick(members));
        subexpenses = [{ amountMinor: subAmount, allocatedTo: subMembers }];
      }
      txs.push({
        transactionId: newId(), logId: log.logId, payerUserId: payer,
        amountMinor: amount, currency: pick(currencies),
        kind: 'expense', subexpenses,
      });
    }

    // Log schließen → Effekte in den Welt-Zustand einspielen
    // (das simuliert, was der Server in einer DB-Transaktion täte).
    const effects = closeLog({
      log, transactions: txs, activeMembers: members,
      openLogClaims: [], // Salden werden hier direkt aus Transaktionen gerechnet
      existingRoots: roots, openRootClaims,
      newRootCurrency: () => 'EUR', // Einigungs-Mechanik: hier fix EUR
      fxRates: fx, newId,
    });
    for (const root of effects.createRoots) {
      const [a, b2] = inferRootPair(root, effects.createClaims);
      roots.set(pairKeyString(a, b2), root);
    }
    // Abgelöste Root-Claims austragen, neue eintragen.
    for (const upd of effects.updateClaims) {
      for (const [k, c] of openRootClaims) {
        if (c.claimId === upd.claimId) openRootClaims.delete(k);
      }
    }
    for (const c of effects.createClaims) {
      openRootClaims.set(pairKeyString(c.debtorUserId, c.creditorUserId), c);
    }
  }

  // Alle offenen Root-Claims exakt setteln …
  let settledCount = 0;
  for (const claim of openRootClaims.values()) {
    const res = applyTransferToClaims(
      { transferId: newId(), senderUserId: claim.debtorUserId,
        receiverUserId: claim.creditorUserId, amountMinor: claim.amountMinor,
        currency: 'EUR' },
      [claim],
      new Map(),
    );
    if (res.settledClaimIds.length !== 1 || res.remainingByClaimId.get(claim.claimId) !== 0n) {
      throw new Error(`Claim ${claim.claimId} ging nicht exakt auf 0`);
    }
    settledCount++;
  }

  console.log(
    `  ✔ Seed ${seed}: ${nLogs} Logs, ${nLogs * nTxPerLog} Transaktionen, ` +
    `${roots.size} Roots, ${settledCount} Claims gesettelt — ALLE ROOTS AUF 0`,
  );
  passed++;
}

/** Hilfsfunktion: das User-Paar eines frisch erstellten Roots ermitteln. */
function inferRootPair(root: Log, claims: readonly Claim[]): [UserId, UserId] {
  const c = claims.find((x) => x.logId === root.logId);
  if (!c) throw new Error(`Root ${root.logId} ohne Claim erstellt?`);
  return [c.debtorUserId, c.creditorUserId];
}

// Mehrere Seeds — Rundungsfehler sind konstellationsabhängig.
for (const seed of [1, 42, 1337, 20260708]) {
  try {
    runSimulation(seed, 20, 25); // 20 Logs à 25 Transaktionen = 500 pro Seed
  } catch (e) {
    failed++;
    console.error(`  ✘ Simulation Seed ${seed}: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
process.exit(failed > 0 ? 1 : 0);
