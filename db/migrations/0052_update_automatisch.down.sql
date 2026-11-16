-- Nimmt 0052 zurück: kein automatischer Antrag mehr. Steht ein Bereich auf `automatisch`, scheitert der Rückweg laut an
-- der alten Bedingung, statt die Einstellung zu verfälschen (nie löschen, 0025) — vorher auf `direkt` oder `rueckfrage`
-- umschalten. Die Anträge behalten `freigabe_modus = direkt`, nur das Merkmal `automatisch` geht verloren.
DROP INDEX "cockpit"."eingriff_automatisch_juengste";
DROP TRIGGER "eingriff_kette_automatisch" ON "cockpit"."eingriff";
DROP FUNCTION "cockpit"."eingriff_automatisch_fest"();
ALTER TABLE "cockpit"."eingriff" DROP CONSTRAINT "eingriff_automatisch_direkt";
ALTER TABLE "cockpit"."eingriff" DROP COLUMN "automatisch";

ALTER TABLE "cockpit"."update_freigabemodus" DROP CONSTRAINT "update_freigabemodus_modus";
ALTER TABLE "cockpit"."update_freigabemodus"
    ADD CONSTRAINT "update_freigabemodus_modus" CHECK (modus IN ('rueckfrage', 'direkt'));
