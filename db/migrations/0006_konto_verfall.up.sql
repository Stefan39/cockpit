-- Epic E2 (COPI-17): Halbfertige Konten verfallen nach 72 Stunden.
--
-- Neuer Aktivierungs-Marker auf dem Better-Auth-Benutzertisch: ein Konto ohne
-- eingerichteten zweiten Faktor kann mit seinem Passwort zwar die
-- Einrichtungsseite erreichen, ist aber sonst unveräußerlich. Wer das Passwort
-- kennt (z. B. aus einem alten Einladungs-Leak), kann daran einen Authenticator
-- binden — unbegrenzt lange. COPI-17 setzt eine 72h-Frist: Konten, deren
-- zweiter Faktor **nie** aktiviert wurde, verfallen und werden gelöscht.
--
-- Das Kriterium ist „nie aktiviert" (aktiviert_am IS NULL) und nicht „gerade
-- kein zweiter Faktor" (twoFactorEnabled = false). Sonst würde ein aktives
-- Konto, das seinen Faktor über die Better-Auth-Route /api/auth/two-factor/disable
-- abschaltet, beim nächsten Aufräumlauf gelöscht.

ALTER TABLE "cockpit"."user"
    ADD COLUMN "aktiviert_am" timestamptz;

-- Bestandskonten mit aktivem zweitem Faktor waren bereits in Betrieb, ihre
-- Aktivierung liegt zeitlich vor dieser Migration. Sie bekommen ein Update-Datum
-- zugewiesen (die genaue Zeit spielt keine Rolle, wichtig ist nur der Marker
-- "war nie aktiviert" = aktiviert_am IS NULL). Andere Bestandskonten ohne zweiten
-- Faktor bekommen kein Datum und verfallen nach 72h ab ihrer Anlage (createdAt).
UPDATE "cockpit"."user"
   SET "aktiviert_am" = now()
 WHERE "twoFactorEnabled" = true;
