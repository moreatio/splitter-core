/**
 * netting.ts — Paarweise Salden ("wer schuldet wem wie viel").
 *
 * Zentrale Datenstruktur: PairBalance mit KANONISCHEM Schlüssel.
 * Ein Paar (A,B) wird immer als (min(A,B), max(A,B)) gespeichert; der Saldo
 * ist VORZEICHENBEHAFTET: positiv = userLow schuldet userHigh, negativ =
 * umgekehrt. Dadurch ist Netting (Forderungen in beide Richtungen
 * verrechnen) eine simple Addition — kein Sonderfall-Code.
 */

import { computeShares } from './split.js';
import {
  CurrencyCode,
  FX_SCALE,
  FxRateTable,
  fxKey,
  Minor,
  Transaction,
  UserId,
} from './types.js';
import { InvariantViolation } from './split.js';

// ---------------------------------------------------------------------------
// Kanonische Paar-Schlüssel
// ---------------------------------------------------------------------------

export interface PairKey {
  userLow: UserId;  // lexikografisch kleinere UserId
  userHigh: UserId; // lexikografisch größere UserId
}

export function pairKey(a: UserId, b: UserId): PairKey {
  if (a === b) throw new InvariantViolation('pairKey: identische User');
  return a < b ? { userLow: a, userHigh: b } : { userLow: b, userHigh: a };
}

export function pairKeyString(a: UserId, b: UserId): string {
  const k = pairKey(a, b);
  return `${k.userLow}|${k.userHigh}`;
}

/**
 * Saldo eines Paares in EINER Währung.
 * amountSigned > 0  →  userLow schuldet userHigh
 * amountSigned < 0  →  userHigh schuldet userLow
 * amountSigned == 0 →  ausgeglichen
 */
export interface PairBalance {
  userLow: UserId;
  userHigh: UserId;
  currency: CurrencyCode;
  amountSigned: bigint;
}

// ---------------------------------------------------------------------------
// FX-Konvertierung (exakt, mit skaliertem bigint-Kurs)
// ---------------------------------------------------------------------------

/**
 * Konvertiert einen Minor-Betrag mit einem skalierten Kurs.
 * Rundung: kaufmännisch (round half away from zero), symmetrisch für
 * negative Salden — wichtig, damit convert(x) === -convert(-x) gilt und
 * das Netting richtungsunabhängig bleibt.
 */
export function convertMinor(amount: bigint, rateScaled: bigint): bigint {
  const product = amount * rateScaled;
  const half = FX_SCALE / 2n;
  // Vorzeichen merken, Betrag runden, Vorzeichen wieder anwenden.
  const sign = product < 0n ? -1n : 1n;
  const abs = product < 0n ? -product : product;
  return sign * ((abs + half) / FX_SCALE);
}

/** Kurs nachschlagen; Identität (from === to) ist implizit 1.0. */
export function lookupRate(
  table: FxRateTable,
  from: CurrencyCode,
  to: CurrencyCode,
): bigint {
  if (from === to) return FX_SCALE; // 1.0
  const rate = table.get(fxKey(from, to));
  if (!rate) {
    // Bewusst hart: lieber Fehler als stiller Falschbetrag. Der Aufrufer
    // (Server) muss die Kurse zum Stichtag bereitstellen (Invariante:
    // Kurs wird persistiert, nie live nachgeschlagen).
    throw new InvariantViolation(`FX-Kurs fehlt: ${from} -> ${to}`);
  }
  return rate.rateScaled;
}

// ---------------------------------------------------------------------------
// Salden eines Logs aus seinen Transaktionen berechnen
// ---------------------------------------------------------------------------

/**
 * Berechnet die paarweisen NETTO-Salden eines Logs in dessen baseCurrency.
 *
 * Ablauf pro Transaktion:
 *  1. Anteile pro User in Originalwährung (split.ts)
 *  2. Anteil jedes Users ≠ Payer in log.baseCurrency konvertieren (Stichtagskurs)
 *  3. Als Schuld gegenüber dem Payer auf den Paar-Saldo addieren
 *
 * WICHTIG zur Rundung: Konvertiert wird der ANTEIL, nicht der Gesamtbetrag.
 * Dadurch kann Σ(konvertierte Anteile) um wenige Cent vom konvertierten
 * Gesamtbetrag abweichen — das ist die im ERM dokumentierte Entscheidung
 * "Rundungsdifferenz trägt der Payer": sein Eigenanteil ist der Rest und
 * wird nie als Claim materialisiert.
 *
 * @param baseCurrency  Zielwährung (log.baseCurrency)
 * @param transactions  alle Transaktionen des Logs
 * @param activeMembers aktive Member (für Gleichverteilungs-Default)
 * @param fxRates       Kurstabelle zum jeweiligen Stichtag
 */
export function computeLogPairBalances(
  baseCurrency: CurrencyCode,
  transactions: readonly Transaction[],
  activeMembers: readonly UserId[],
  fxRates: FxRateTable,
): PairBalance[] {
  // Saldo-Akkumulator: kanonischer Paar-String → vorzeichenbehafteter Betrag
  const acc = new Map<string, bigint>();

  for (const tx of transactions) {
    const shares = computeShares(tx, activeMembers);
    const rate = lookupRate(fxRates, tx.currency, baseCurrency);

    for (const [userId, shareOriginal] of shares) {
      // Der Payer schuldet sich selbst nichts (Invariante 6: debtor != creditor).
      if (userId === tx.payerUserId) continue;
      if (shareOriginal === 0n) continue;

      const shareConverted = convertMinor(shareOriginal, rate);

      // userId schuldet dem Payer → Vorzeichen hängt an der kanonischen Ordnung.
      const key = pairKeyString(userId, tx.payerUserId);
      const { userLow } = pairKey(userId, tx.payerUserId);
      const signed = userId === userLow ? shareConverted : -shareConverted;
      acc.set(key, (acc.get(key) ?? 0n) + signed);
    }
  }

  // Map → strukturierte Liste. Paare mit Saldo 0 bleiben drin — der Aufrufer
  // (closing.ts) braucht sie, um alte Claims als netted_out zu markieren.
  return [...acc.entries()].map(([key, amountSigned]) => {
    const [userLow, userHigh] = key.split('|');
    return { userLow, userHigh, currency: baseCurrency, amountSigned };
  });
}

/**
 * Verrechnet einen neuen Saldo gegen einen bestehenden (z. B. Log-Saldo
 * gegen Root-Saldo). Dank Vorzeichen-Konvention ist das reine Addition —
 * beide müssen aber in derselben Währung und mit demselben Paar vorliegen.
 */
export function netBalances(existing: PairBalance, incoming: PairBalance): PairBalance {
  if (
    existing.userLow !== incoming.userLow ||
    existing.userHigh !== incoming.userHigh
  ) {
    throw new InvariantViolation('netBalances: unterschiedliche Paare');
  }
  if (existing.currency !== incoming.currency) {
    throw new InvariantViolation(
      `netBalances: Währungsmix ${existing.currency} vs ${incoming.currency}`,
    );
  }
  return { ...existing, amountSigned: existing.amountSigned + incoming.amountSigned };
}
