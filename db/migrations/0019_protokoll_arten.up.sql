-- Epic E3 (COPI-41): Die Protokollarten als Tabelle statt als Liste in einer Bedingung.
--
-- Bisher hielt die CHECK-Bedingung `protokoll_art_bekannt` die bekannten Arten als Liste (0009, erweitert in 0010, 0014,
-- 0016 und 0018). Jede neue Art hieß: die ganze Liste in der Migration wiederholen, und in ihrer Down-Migration noch
-- einmal die alte. Diese Wiederholung wächst mit jedem Ticket, und Gate 4 (jscpd) lässt sie nicht mehr zu — zu Recht:
-- „Migrationen extrahieren statt kopieren" (docs/architektur-leitplanken.md).
--
-- Ab hier ist eine Art eine Zeile in `cockpit.protokoll_art`, und `protokoll.art` verweist per Fremdschlüssel darauf.
-- Die Wirkung bleibt dieselbe — eine unbekannte Art scheitert an der Datenbank, unter demselben Namen
-- `protokoll_art_bekannt` —, aber eine neue Art ist ein `INSERT`:
--
--   up:   INSERT INTO "cockpit"."protokoll_art" (art) VALUES ('neue_art') ON CONFLICT (art) DO NOTHING;
--   down: DELETE FROM "cockpit"."protokoll_art" a WHERE a.art = 'neue_art'
--           AND NOT EXISTS (SELECT 1 FROM "cockpit"."protokoll" p WHERE p.art = a.art);
--
-- Eine Art, die ein Eintrag nutzt, bleibt beim Zurücknehmen stehen: das Protokoll lässt sich nicht bereinigen (0009),
-- und der Fremdschlüssel verlangt sie. Das entspricht dem bisherigen `NOT VALID`.
--
-- Befüllt wird die Tabelle **einmalig aus der bisherigen Bedingung** — jede Art steht dort als Literal — statt die
-- Liste ein weiteres Mal abzuschreiben. Ergibt das weniger als die 19 Arten, die 0018 kennt, bricht die Migration ab:
-- dann hat sich die Form der Bedingung geändert, und eine halbe Liste zu übernehmen wäre schlimmer als ein Abbruch.
-- (Mehr als 19 sind möglich: wer bis vor 0019 zurücknimmt, behält Arten, die ein Eintrag schon nutzt.)
-- Dazu kommt jede Art, die im Protokoll vorkommt, auch eine, die eine frühere Down-Migration aus der Liste genommen hat:
-- der Fremdschlüssel prüft alle bestehenden Einträge.
--
-- Die Form einer Art ist die einer Kennung im Protokoll (`src/auth/protokoll.ts`): Kleinbuchstaben und `_`.

CREATE TABLE "cockpit"."protokoll_art" (
    art text PRIMARY KEY,
    CONSTRAINT protokoll_art_form CHECK (art ~ '^[a-z][a-z_]{0,39}$')
);

DO $$
DECLARE
    uebernommen integer;
BEGIN
    INSERT INTO "cockpit"."protokoll_art" (art)
    SELECT DISTINCT treffer[1]
      FROM pg_constraint c
     CROSS JOIN LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') AS treffer
     WHERE c.conrelid = '"cockpit"."protokoll"'::regclass
       AND c.conname = 'protokoll_art_bekannt';
    GET DIAGNOSTICS uebernommen = ROW_COUNT;
    IF uebernommen < 19 THEN
        RAISE EXCEPTION 'protokoll_art_uebernahme: aus der Bedingung protokoll_art_bekannt kamen % statt mindestens 19 Arten', uebernommen;
    END IF;
END;
$$;

INSERT INTO "cockpit"."protokoll_art" (art)
SELECT DISTINCT art FROM "cockpit"."protokoll"
ON CONFLICT (art) DO NOTHING;

ALTER TABLE "cockpit"."protokoll" DROP CONSTRAINT "protokoll_art_bekannt";

ALTER TABLE "cockpit"."protokoll"
    ADD CONSTRAINT "protokoll_art_bekannt" FOREIGN KEY (art) REFERENCES "cockpit"."protokoll_art" (art);
