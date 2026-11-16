-- Epic E2 (COPI-46): Die Protokollarten für das Bearbeiten von Konten in der Oberfläche.
--
-- `name_geaendert`, `rolle_geaendert` (mit `von`/`an`) und `konto_entfernt`; Akteur ist das handelnde Konto, Ziel das
-- bearbeitete. Das Zurücksetzen des zweiten Faktors schreibt das bekannte `konto_entsperrt` (0014), mit `weg`.
-- Seit 0019 eine Zeile je Art (`ON CONFLICT`: eine Art, die beim Zurücknehmen stehen blieb, ist schon da).

INSERT INTO "cockpit"."protokoll_art" (art)
VALUES ('name_geaendert'), ('rolle_geaendert'), ('konto_entfernt')
ON CONFLICT (art) DO NOTHING;
