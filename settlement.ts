/**
 * settlement.ts — Transfers auf offene Claims anwenden (Invariante 6).
 *
 * Regeln aus dem ERM:
 *  - Ein SETTLEMENT referenziert nur Claims mit status='open'.
 *    (Erzwingt automatisch: keine Transfers in geschlossenen Logs, denn
 *    dort existieren nach der Schließung keine offenen Claims mehr.)
 *  - Teilzahlungen sind erlaubt; Σ Settlements pro Claim <= Claim-Betrag.
 *  - Überschüsse werden NICHT still verrechnet (Randfall 2/3 aus dem
 *    Review): dieser Code lehnt sie ab, die Behandlung (Gegen-Claim im
 *    Root o. ä.) ist eine bewusste spätere Produktentscheidung.
 */

import { InvariantViolation } from './split.js';
import { Claim, Minor, Settlement, Transfer } from './types.js';

export interface ApplyTransferResult {
  /** Zu persistierende Settlement-Zeilen. */
  settlements: Settlement[];
  /** Claims, die dadurch VOLL beglichen sind → status='settled'. */
  settledClaimIds: string[];
  /**
   * Restbeträge pro Claim nach diesem Transfer (für Anzeige/Folge-Logik).
   * Ein Claim mit Rest > 0 bleibt status='open' — Teilzahlung.
   */
  remainingByClaimId: Map<string, Minor>;
}

/**
 * Wendet einen Transfer auf eine geordnete Liste offener Claims an.
 *
 * @param transfer        der Transfer (Sender zahlt an Receiver)
 * @param openClaims      offene Claims mit debtor=sender & creditor=receiver,
 *                        in Tilgungs-Reihenfolge (Aufrufer entscheidet, z. B.
 *                        älteste zuerst — bei Kontokorrent-Roots ist es eh
 *                        max. einer pro Root)
 * @param alreadySettled  bereits getilgter Betrag je Claim (Σ vorhandener
 *                        Settlements) — nötig für die <=-Invariante
 */
export function applyTransferToClaims(
  transfer: Transfer,
  openClaims: readonly Claim[],
  alreadySettled: ReadonlyMap<string, Minor>,
): ApplyTransferResult {
  // --- Invarianten-Prüfungen ----------------------------------------------
  if (transfer.amountMinor <= 0n) {
    throw new InvariantViolation(`Transfer ${transfer.transferId}: Betrag <= 0`);
  }
  for (const claim of openClaims) {
    if (claim.status !== 'open') {
      throw new InvariantViolation(
        `Transfer ${transfer.transferId}: Claim ${claim.claimId} ist '${claim.status}', nur 'open' settelbar`,
      );
    }
    if (
      claim.debtorUserId !== transfer.senderUserId ||
      claim.creditorUserId !== transfer.receiverUserId
    ) {
      throw new InvariantViolation(
        `Transfer ${transfer.transferId}: Claim ${claim.claimId} gehört nicht zum Paar Sender→Receiver`,
      );
    }
  }

  const result: ApplyTransferResult = {
    settlements: [],
    settledClaimIds: [],
    remainingByClaimId: new Map(),
  };

  // --- Tilgung: Transfer-Betrag der Reihe nach auf die Claims verteilen ----
  let budget = transfer.amountMinor;

  for (const claim of openClaims) {
    const paid = alreadySettled.get(claim.claimId) ?? 0n;
    const outstanding = claim.amountMinor - paid; // was noch offen ist

    if (outstanding <= 0n) {
      // Sollte nicht vorkommen (Claim wäre dann 'settled') — defensiv prüfen.
      throw new InvariantViolation(
        `Claim ${claim.claimId}: als 'open' markiert, aber Restschuld ${outstanding}`,
      );
    }
    if (budget === 0n) {
      result.remainingByClaimId.set(claim.claimId, outstanding);
      continue;
    }

    // So viel tilgen wie möglich, aber nie mehr als die Restschuld
    // (Σ Settlements <= Claim-Betrag, Invariante 6).
    const portion = budget < outstanding ? budget : outstanding;
    result.settlements.push({
      transferId: transfer.transferId,
      claimId: claim.claimId,
      amountMinor: portion,
    });
    budget -= portion;

    const remaining = outstanding - portion;
    result.remainingByClaimId.set(claim.claimId, remaining);
    if (remaining === 0n) result.settledClaimIds.push(claim.claimId);
  }

  // --- Überschuss: bewusst ablehnen statt still schlucken ------------------
  // (Randfall 2/3: "Transfer ohne/über Claim" ist eine offene Produkt-
  // entscheidung. Bis dahin ist ein zu hoher Transfer ein Nutzerfehler,
  // den die UI vor dem Absenden verhindern soll.)
  if (budget > 0n) {
    throw new InvariantViolation(
      `Transfer ${transfer.transferId}: Überschuss von ${budget} Minor Units — ` +
        `übersteigt die offenen Claims. Überzahlung ist (noch) nicht definiert.`,
    );
  }

  return result;
}
