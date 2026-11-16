-- Nimmt 0042 zurück. Entwertete Ersatzcodes würden dabei wieder gültig: ein Werkzeug für die Entwicklung, kein Weg im
-- Betrieb. Die Protokollarten nur, soweit kein Eintrag sie nutzt (0019).
DROP FUNCTION "cockpit"."totp_entfernen"(text);
ALTER TABLE "cockpit"."ersatzcode" DROP COLUMN entwertet_am;
ALTER TABLE "cockpit"."passkey_vorgang" DROP COLUMN zweck;

DELETE FROM "cockpit"."protokoll_art" a
 WHERE a.art IN ('zweiter_faktor_hinzugefuegt', 'zweiter_faktor_entfernt', 'ersatzcodes_erneuert', 'faktor_bestaetigt')
   AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
