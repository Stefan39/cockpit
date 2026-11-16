-- Nimmt 0019 zurück: die Arten wieder als Liste in der CHECK-Bedingung `protokoll_art_bekannt`.
--
-- Die Liste entsteht aus der Tabelle, nicht abgeschrieben: sie enthält jede Art, die bis hierher bekannt war, auch jede,
-- die ein Eintrag nutzt. Die Bedingung gilt deshalb für alle bestehenden Einträge. Sie hat die Form der früheren
-- Migrationen (`art IN ('…', '…')`, jede Art ein eigenes Literal) — daraus liest 0019 sie beim erneuten Anwenden.

DO $$
DECLARE
    arten text;
BEGIN
    SELECT string_agg(quote_literal(art), ', ' ORDER BY art) INTO arten FROM "cockpit"."protokoll_art";
    ALTER TABLE "cockpit"."protokoll" DROP CONSTRAINT "protokoll_art_bekannt";
    EXECUTE format('ALTER TABLE "cockpit"."protokoll" ADD CONSTRAINT "protokoll_art_bekannt" CHECK (art IN (%s))', arten);
END;
$$;

DROP TABLE "cockpit"."protokoll_art";
