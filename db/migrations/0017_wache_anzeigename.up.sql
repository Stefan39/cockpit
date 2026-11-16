-- Epic E3 (COPI-37): Der Anzeigename einer Wache — wie sie dem Kunden heißt.
--
-- Die Kennung einer Wache (`container`, `backup.taeglich`) ist für Maschinen und den Betreuer. Für den
-- Kunden ist sie Techniksprache (Architektur-Vorschlag 1: „Buchungen", „läuft", nicht „Container").
-- Auf der Übersicht trägt jede Kachel deshalb einen Namen in Betriebssprache („Buchungs-Agent"), den der
-- Agent mit dem Befund mitschickt. Ohne Namen bekommt der Kunde nie die Kennung zu sehen, sondern
-- „Bereich"; der Betreuer sieht sie ohnehin.
--
-- Der Name gehört zur Wache, nicht zu einem Befund: ein späterer Befund ohne Namen lässt ihn stehen, einer
-- mit Namen ersetzt ihn. Höchstens 60 Zeichen und mindestens ein sichtbares Zeichen — auch ein Tabulator
-- oder ein Zeilenumbruch allein ist kein Name (`btrim` würde nur Leerzeichen abziehen).
ALTER TABLE "cockpit"."wache" ADD COLUMN "anzeigename" text;

ALTER TABLE "cockpit"."wache"
    ADD CONSTRAINT "wache_anzeigename_form" CHECK (
        anzeigename IS NULL OR (anzeigename ~ '[^[:space:]]' AND char_length(anzeigename) <= 60)
    );
