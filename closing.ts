/**
 * closing.ts — Die Log-Schließung (Invariante 7 aus dem ERM).
 *
 * Das ist die kritischste Operation des Systems. Sie ist hier als REINE
 * Funktion implementiert: Input = kompletter relevanter Zustand,
 * Output = Beschreibung aller nötigen Änderungen ("Effekte").
 * Der Server führt diese Effekte dann in EINER DB-Transaktion aus —
 * Atomarität ist damit ein Persistenz-Problem, kein Logik-Problem mehr.
 * (Nebeneffekt: exakt dieselbe Funktion kann ein Offline-Client zur
 * optimistischen Vorschau nutzen.)
 *
 * Ablauf:
 *  1. Paarweise Netto-Salden des Logs berechnen (netting.ts)
 *  2. Pro Paar mit Saldo ≠ 0:
 *     a. Ziel-Root bestimmen (existiert oder wird lazy erstellt)
 *     b. Log-Saldo in die baseCurrency des Roots konvertieren (Stichtag)
 *     c. Gegen bestehenden offenen Root-Claim netten
 *     d. Neuen Root-Claim ausgeben, alten Root-Claim ablösen
 *  3. Alle offenen Log-Claims markieren:
 *     - Paar-Saldo ≠ 0 → status=transferred + Verweis auf den Root-Claim
 *     - Paar-Saldo = 0 → status=netted_out (explizit "gegeneinander aufgehoben")
 */

import { computeLogPairBalances, convertMinor, lookupRate, pairKeyString } from './netting.js';
import { InvariantViolation } from './split.js';
import {
  Claim,
  ClaimId,
  CurrencyCode,
  FxRateTable,
  Log,
  LogId,
  Minor,
  Transaction,
  UserId,
} from './types.js';

// ---------------------------------------------------------------------------
// Input / Output der Schließung
// ---------------------------------------------------------------------------

export interface CloseLogInput {
  /** Das zu schließende Log. Muss status='closing' haben (alle bestätigt). */
  log: Log;
  /** Alle Transaktionen des Logs. */
  transactions: readonly Transaction[];
  /** Aktive Member (für Gleichverteilungs-Default). */
  activeMembers: readonly UserId[];
  /** Alle offenen Claims DES LOGS (werden transferred/netted_out). */
  openLogClaims: readonly Claim[];
  /**
   * Bestehende Roots pro Paar: kanonischer Paar-String → Root.
   * Fehlt ein Paar, wird ein Root lazy erstellt (Effekt createRoots).
   */
  existingRoots: ReadonlyMap<string, Log>;
  /**
   * Der aktuell OFFENE Claim je Root (max. einer pro Root — Kontokorrent-
   * Modell). Schlüssel: kanonischer Paar-String.
   */
  openRootClaims: ReadonlyMap<string, Claim>;
  /**
   * Basiswährung für lazy erstellte Roots, pro Paar. Kommt aus der
   * Einigungs-Mechanik (preferred_currency-Match oder Dialog) — Logik hier
   * bewusst NICHT enthalten, das ist ein UI/Server-Anliegen.
   */
  newRootCurrency: (userLow: UserId, userHigh: UserId) => CurrencyCode;
  /** FX-Kurse zum Schließungs-Stichtag. */
  fxRates: FxRateTable;
  /** ID-Fabrik — als Parameter, damit die Funktion pur & testbar bleibt. */
  newId: () => string;
}

/** Beschreibung aller Änderungen. Der Server persistiert das atomar. */
export interface CloseLogEffects {
  /** log.status → 'closed', closed_at = now (setzt der Server). */
  closeLogId: LogId;
  /** Lazy zu erstellende Roots (inkl. ihrer 2 Memberships). */
  createRoots: Log[];
  /** Neue offene Claims in den Roots (Ergebnis des Nettings). */
  createClaims: Claim[];
  /** Statusübergänge bestehender Claims. */
  updateClaims: ClaimUpdate[];
}

export interface ClaimUpdate {
  claimId: ClaimId;
  newStatus: 'transferred' | 'netted_out';
  /** Bei transferred: der Ziel-Claim im Root. Bei netted_out: null. */
  transferredToClaimId: ClaimId | null;
}

// ---------------------------------------------------------------------------
// Die Schließung selbst
// ---------------------------------------------------------------------------

export function closeLog(input: CloseLogInput): CloseLogEffects {
  const { log } = input;

  // Roots schließen nie (Invariante 1) — harte Absicherung.
  if (log.type === 'root') {
    throw new InvariantViolation(`closeLog: Root ${log.logId} kann nicht geschlossen werden`);
  }
  // Zweistufige Schließung: erst 'closing' (alle bestätigt), dann diese Funktion.
  // Twigs überspringen die Bestätigung (Invariante 2) und kommen direkt als 'open'.
  if (log.type === 'log' && log.status !== 'closing') {
    throw new InvariantViolation(
      `closeLog: Log ${log.logId} ist '${log.status}', erwartet 'closing' (Bestätigungen fehlen?)`,
    );
  }

  // Schritt 1: Netto-Salden des Logs in seiner baseCurrency.
  const pairBalances = computeLogPairBalances(
    log.baseCurrency,
    input.transactions,
    input.activeMembers,
    input.fxRates,
  );

  const effects: CloseLogEffects = {
    closeLogId: log.logId,
    createRoots: [],
    createClaims: [],
    updateClaims: [],
  };

  // Merker: Paar-String → neuer Root-Claim (für die Verweiskette in Schritt 3).
  const newRootClaimByPair = new Map<string, Claim>();

  // Schritt 2: pro Paar mit Saldo ≠ 0 in den Root übertragen.
  for (const balance of pairBalances) {
    if (balance.amountSigned === 0n) continue; // → netted_out in Schritt 3

    const pKey = pairKeyString(balance.userLow, balance.userHigh);

    // 2a. Root bestimmen oder lazy erstellen.
    let root = input.existingRoots.get(pKey);
    if (!root) {
      root = {
        logId: input.newId(),
        type: 'root',
        status: 'open', // Roots sind immer offen
        baseCurrency: input.newRootCurrency(balance.userLow, balance.userHigh),
      };
      effects.createRoots.push(root);
    }

    // 2b. Log-Saldo in die Root-Währung konvertieren (Stichtagskurs).
    const rate = lookupRate(input.fxRates, log.baseCurrency, root.baseCurrency);
    const incomingSigned = convertMinor(balance.amountSigned, rate);

    // 2c. Gegen den bestehenden offenen Root-Claim netten.
    // Bestehenden Claim in die Vorzeichen-Konvention übersetzen:
    // positiv = userLow schuldet userHigh.
    const existingClaim = input.openRootClaims.get(pKey) ?? null;
    let existingSigned = 0n;
    if (existingClaim) {
      existingSigned =
        existingClaim.debtorUserId === balance.userLow
          ? existingClaim.amountMinor
          : -existingClaim.amountMinor;
    }
    const totalSigned = existingSigned + incomingSigned;

    // 2d. Neuen Root-Claim erzeugen (falls Gesamt-Saldo ≠ 0) und den
    // alten ablösen. Wir erzeugen IMMER einen neuen Claim statt den alten
    // zu mutieren — Claims bleiben damit append-only (offline-sync-freundlich,
    // vgl. Architektur-Entscheidung) und die Historie bleibt nachvollziehbar.
    let newClaim: Claim | null = null;
    if (totalSigned !== 0n) {
      newClaim = {
        claimId: input.newId(),
        logId: root.logId,
        debtorUserId: totalSigned > 0n ? balance.userLow : balance.userHigh,
        creditorUserId: totalSigned > 0n ? balance.userHigh : balance.userLow,
        amountMinor: totalSigned > 0n ? totalSigned : -totalSigned, // |x|
        status: 'open',
        transferredToClaimId: null,
      };
      effects.createClaims.push(newClaim);
      newRootClaimByPair.set(pKey, newClaim);
    }

    if (existingClaim) {
      // Alter Root-Claim ist im neuen aufgegangen (oder hat sich zu 0 gehoben).
      effects.updateClaims.push({
        claimId: existingClaim.claimId,
        newStatus: newClaim ? 'transferred' : 'netted_out',
        transferredToClaimId: newClaim ? newClaim.claimId : null,
      });
    }
  }

  // Schritt 3: alle offenen LOG-Claims abschließen.
  for (const claim of input.openLogClaims) {
    if (claim.status !== 'open') continue; // settled bleibt settled
    const pKey = pairKeyString(claim.debtorUserId, claim.creditorUserId);
    const target = newRootClaimByPair.get(pKey) ?? null;
    effects.updateClaims.push({
      claimId: claim.claimId,
      newStatus: target ? 'transferred' : 'netted_out',
      transferredToClaimId: target ? target.claimId : null,
    });
  }

  return effects;
}
