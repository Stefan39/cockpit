-- Nimmt 0005_anmeldeversuch zurück. Laufende Sperren und offene
-- Anmeldevorgänge gehen dabei verloren; beides ist kurzlebig.
DROP TABLE IF EXISTS "cockpit"."anmeldevorgang";
DROP TABLE IF EXISTS "cockpit"."anmeldeversuch";
