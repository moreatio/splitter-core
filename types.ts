/**
 * types.ts — Kern-Typen der Splitter-Logik.
 *
 * Designprinzipien (aus dem ERM übernommen):
 *  - Alle Geldbeträge sind `bigint` in Minor Units (Cent). NIEMALS float.
 *  - Dieses Modul ist bewusst IO-frei: keine DB, kein HTTP, keine Uhr,
 *    keine Zufallsquelle. Alles kommt als Parameter rein, alles geht als
 *    Rückgabewert raus. Dadurch läuft derselbe Code unverändert auf
 *    Server (Node/Bun), im Web und später in React Native (Offline-Fall).
 *  - MVP-Einschränkung: nur Währungen mit 2 Dezimalstellen (EUR, USD, CHF …).
 *    JPY/BHD etc. brauchen später eine Exponent-Tabelle (ISO 4217).
 */

// ---------------------------------------------------------------------------
// ID-Typen: nur Aliase auf string (UUIDv7 in der DB). Die Branded-Type-
// Variante (z. B. `string & { __brand: 'UserId' }`) wäre strenger, kostet
// aber Boilerplate — für den MVP reichen Aliase plus Disziplin.
// ---------------------------------------------------------------------------
export type UserId = string;
export type LogId = string;
export type TransactionId = string;
export type ClaimId = string;
export type TransferId = string;

/** ISO-4217-Code, z. B. "EUR". Im MVP nur 2-Dezimal-Währungen. */
export type CurrencyCode = string;

/** Geldbetrag in Minor Units (Cent). Immer >= 0, Richtung steckt in der Semantik. */
export type Minor = bigint;

// ---------------------------------------------------------------------------
// Log (deckt per `type` alle drei Fälle ab: Gruppe, Zwei-Personen, Ad-hoc)
// ---------------------------------------------------------------------------
export type LogType = 'root' | 'log' | 'twig';
export type LogStatus = 'open' | 'closing' | 'closed';

export interface Log {
  logId: LogId;
  type: LogType;
  status: LogStatus;
  /**
   * Basiswährung.
   * - type=root: von beiden Usern vereinbart, immutable sobald Claims existieren.
   * - type=log/twig: Anzeige-/Verrechnungswährung des Logs.
   */
  baseCurrency: CurrencyCode;
}

/** Aktive Mitgliedschaft (left_at IS NULL). Ausgetretene Member tauchen hier nicht auf. */
export interface ActiveMembership {
  logId: LogId;
  userId: UserId;
}

// ---------------------------------------------------------------------------
// Transaction + Subexpense
// ---------------------------------------------------------------------------
export type TransactionKind = 'expense' | 'adjustment';

export interface Subexpense {
  /** Teilbetrag in Minor Units, gleiche Währung wie die Parent-Transaction. */
  amountMinor: Minor;
  /**
   * User, auf die dieser Teilbetrag GLEICHMÄSSIG verteilt wird.
   * Invariante (App-Logik): nur aktive Log-Member erlaubt.
   */
  allocatedTo: UserId[];
}

export interface Transaction {
  transactionId: TransactionId;
  logId: LogId;
  /** Wer hat bezahlt. Invariante: muss aktiver Log-Member sein. */
  payerUserId: UserId;
  /** Gesamtbetrag in Originalwährung. */
  amountMinor: Minor;
  /** Originalwährung der Ausgabe (kann von log.baseCurrency abweichen). */
  currency: CurrencyCode;
  /** expense = normale Ausgabe; adjustment = Korrektur-Twig (nicht in Statistiken). */
  kind: TransactionKind;
  /**
   * Keine Subexpenses  => Gleichverteilung auf ALLE aktiven Log-Member
   * (Invariante 4 aus dem ERM). Jede Abweichung braucht explizite Subexpenses.
   */
  subexpenses: Subexpense[];
}

// ---------------------------------------------------------------------------
// Claim / Transfer / Settlement
// ---------------------------------------------------------------------------
export type ClaimStatus = 'open' | 'settled' | 'transferred' | 'netted_out';

export interface Claim {
  claimId: ClaimId;
  logId: LogId;
  debtorUserId: UserId;   // schuldet …
  creditorUserId: UserId; // … an diesen User. Invariante: debtor !== creditor
  /** Betrag in baseCurrency des Logs (bzw. des Ziel-Roots nach Übertrag). */
  amountMinor: Minor;
  status: ClaimStatus;
  /** Verweiskette: wohin wurde dieser Claim bei Log-Schließung übertragen. */
  transferredToClaimId: ClaimId | null;
}

export interface Transfer {
  transferId: TransferId;
  senderUserId: UserId;
  receiverUserId: UserId;
  amountMinor: Minor;
  currency: CurrencyCode;
}

/** Verknüpfung Transfer→Claim mit Teilbetrag (ermöglicht Teilzahlungen). */
export interface Settlement {
  transferId: TransferId;
  claimId: ClaimId;
  amountMinor: Minor;
}

// ---------------------------------------------------------------------------
// FX: Kurse werden REINGEREICHT (IO-frei), nie live geholt.
// ---------------------------------------------------------------------------

/**
 * Kurs als skalierter bigint, Skala 10^10 — Pendant zu numeric(20,10) im ERM.
 * Beispiel: 1 CHF = 1.0537 EUR → rateScaled = 10_537_000_000n.
 * Vorteil gegenüber number: keinerlei Binär-Float-Drift, exakt reproduzierbar.
 */
export const FX_SCALE = 10_000_000_000n; // 10^10

export interface FxRate {
  from: CurrencyCode;
  to: CurrencyCode;
  /** Kurs * FX_SCALE. Persistiert am Claim (Stichtag), nie nachschlagen. */
  rateScaled: bigint;
}

/** Reiner Lookup: (from,to) → Kurs. Identität (from===to) muss NICHT enthalten sein. */
export type FxRateTable = ReadonlyMap<string, FxRate>;

/** Kanonischer Schlüssel für die FX-Tabelle. */
export function fxKey(from: CurrencyCode, to: CurrencyCode): string {
  return `${from}->${to}`;
}
