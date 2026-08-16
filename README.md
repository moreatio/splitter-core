# splitter-core

IO-freie Kernlogik für Splitter: Anteile, Netting, Log-Schließung, Settlement.

## Struktur

| Datei | Inhalt |
|---|---|
| `src/types.ts` | Typen (bigint Minor Units, FX als skalierter bigint 10^10) |
| `src/split.ts` | Anteile pro User (Gleichverteilung / Subexpenses, Largest Remainder) |
| `src/netting.ts` | Paarweise Salden, FX-Konvertierung, Saldo-Verrechnung |
| `src/closing.ts` | Log-Schließung als reine Funktion: Input Zustand → Output Effekte |
| `src/settlement.ts` | Transfers auf offene Claims (Teilzahlung, Überzahlungs-Abwehr) |
| `test/simulation.ts` | Randfall-Tests + geseedete Zufallssimulation ("alle Roots auf 0") |

## Architektur-Entscheidungen

- **IO-frei**: keine DB, keine Uhr, kein Zufall, keine FX-API. Alles kommt
  als Parameter — derselbe Code läuft auf Server, Web und (später) mobil offline.
- **closeLog gibt Effekte zurück** statt zu persistieren. Der Server schreibt
  sie in einer DB-Transaktion → Atomarität ist ein Persistenz-Problem.
- **Claims append-only**: Netting erzeugt neue Claims und löst alte per
  `transferred_to_claim_id`-Verweis ab. Offline-Sync-freundlich.
- **Überzahlung wirft Fehler** (bewusst offene Produktentscheidung, Randfall 2/3).
- **MVP-Grenze**: nur 2-Dezimal-Währungen (kein JPY/BHD).

## Ausführen

```bash
npm install
npx tsc --noEmit          # Typprüfung (strict)
npx tsx test/simulation.ts # Randfälle + Simulation
```
