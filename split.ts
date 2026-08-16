/**
 * split.ts — Aus einer Transaktion die Anteile pro User berechnen.
 *
 * Kernfrage: "Wer hat wie viel von dieser Ausgabe konsumiert?"
 * Antwort ist eine Map<UserId, Minor> in der ORIGINALWÄHRUNG der Transaktion.
 * (FX-Konvertierung passiert erst eine Ebene höher, in netting.ts.)
 *
 * Regeln (Invariante 4 aus dem ERM):
 *  - Keine Subexpenses  => Gleichverteilung auf alle aktiven Log-Member.
 *  - Mit Subexpenses    => jeder Subexpense-Betrag wird gleichmäßig auf
 *    seine allocatedTo-Liste verteilt.
 *  - Ein NICHT durch Subexpenses abgedeckter Restbetrag gilt als Eigenanteil
 *    des Payers (erzeugt keinen Claim). Beispiel: 30 € Rechnung, Subexpense
 *    10 € für B → B schuldet 10, die restlichen 20 hat der Payer für sich
 *    selbst ausgegeben.
 *
 * Rundung: Largest-Remainder-Verfahren. Bei Gleichverteilung sind alle
 * Reste identisch, daher entscheidet eine DETERMINISTISCHE Reihenfolge
 * (sortierte UserIds), wer die übrigen Cents trägt. Deterministisch ist
 * Pflicht: Server und Offline-Client müssen zum selben Ergebnis kommen.
 */

import { Minor, Subexpense, Transaction, UserId } from './types.js';

/** Fehlerklasse für verletzte Invarianten — bewusst laut statt still korrigieren. */
export class InvariantViolation extends Error {}

/**
 * Verteilt `amount` gleichmäßig auf `users` (Largest Remainder).
 *
 * Beispiel: 100 Cent auf 3 User → [34, 33, 33] — die ersten
 * (amount mod n) User in sortierter Reihenfolge bekommen je 1 Cent mehr.
 * Garantie: Summe der Anteile === amount, exakt, immer.
 */
export function splitEqually(amount: Minor, users: readonly UserId[]): Map<UserId, Minor> {
  if (users.length === 0) {
    throw new InvariantViolation('splitEqually: leere User-Liste');
  }
  if (amount < 0n) {
    throw new InvariantViolation('splitEqually: negativer Betrag');
  }

  const n = BigInt(users.length);
  const base = amount / n;        // ganzzahliger Grundanteil
  const remainder = amount % n;   // 0..n-1 übrige Cents

  // Deterministische Reihenfolge: lexikografisch sortierte UserIds.
  // (UUIDv7 ist zeitlich sortierbar — damit tragen tendenziell die
  // "ältesten" Accounts den Extra-Cent. Fair genug für Cent-Beträge.)
  const sorted = [...users].sort();

  const shares = new Map<UserId, Minor>();
  sorted.forEach((userId, i) => {
    const extra = BigInt(i) < remainder ? 1n : 0n;
    shares.set(userId, base + extra);
  });
  return shares;
}

/**
 * Anteile pro User für EINE Transaktion, in Originalwährung.
 *
 * @param tx             die Transaktion
 * @param activeMembers  aktive Member des Logs (left_at IS NULL)
 * @returns Map<UserId, Minor> — enthält auch den Payer, falls er selbst
 *          konsumiert hat (sein Anteil erzeugt später schlicht keinen Claim).
 */
export function computeShares(
  tx: Transaction,
  activeMembers: readonly UserId[],
): Map<UserId, Minor> {
  // --- Invarianten-Prüfungen (Invariante 3 + 4 aus dem ERM) ---------------
  if (!activeMembers.includes(tx.payerUserId)) {
    throw new InvariantViolation(
      `Transaction ${tx.transactionId}: Payer ${tx.payerUserId} ist kein aktiver Log-Member`,
    );
  }

  // Fall 1: keine Subexpenses → Gleichverteilung auf ALLE aktiven Member.
  if (tx.subexpenses.length === 0) {
    return splitEqually(tx.amountMinor, activeMembers);
  }

  // Fall 2: explizite Subexpenses.
  const sumSub = tx.subexpenses.reduce((acc, s) => acc + s.amountMinor, 0n);
  if (sumSub > tx.amountMinor) {
    throw new InvariantViolation(
      `Transaction ${tx.transactionId}: Summe Subexpenses (${sumSub}) > Transaktionsbetrag (${tx.amountMinor})`,
    );
  }

  const shares = new Map<UserId, Minor>();
  const add = (userId: UserId, amount: Minor) =>
    shares.set(userId, (shares.get(userId) ?? 0n) + amount);

  for (const sub of tx.subexpenses) {
    validateSubexpense(sub, activeMembers, tx.transactionId);
    // Jeder Subexpense-Betrag wird gleichmäßig auf SEINE Member verteilt —
    // so bildet man "Anna und Ben teilen sich die Vorspeise" ab.
    const subShares = splitEqually(sub.amountMinor, sub.allocatedTo);
    for (const [userId, amount] of subShares) add(userId, amount);
  }

  // Nicht abgedeckter Rest → Eigenanteil des Payers (siehe Kopfkommentar).
  const rest = tx.amountMinor - sumSub;
  if (rest > 0n) add(tx.payerUserId, rest);

  return shares;
}

/** Subexpense-Invarianten: nicht leer, nur aktive Member, Betrag >= 0. */
function validateSubexpense(
  sub: Subexpense,
  activeMembers: readonly UserId[],
  txId: string,
): void {
  if (sub.allocatedTo.length === 0) {
    throw new InvariantViolation(`Transaction ${txId}: Subexpense ohne Allocation`);
  }
  if (sub.amountMinor < 0n) {
    throw new InvariantViolation(`Transaction ${txId}: Subexpense mit negativem Betrag`);
  }
  for (const userId of sub.allocatedTo) {
    if (!activeMembers.includes(userId)) {
      throw new InvariantViolation(
        `Transaction ${txId}: Allocation an Nicht-Member ${userId}`,
      );
    }
  }
}
