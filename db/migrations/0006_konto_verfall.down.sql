-- Nimmt 0006_konto_verfall zurück. Der Aktivierungs-Marker geht dabei verloren;
-- nach einem erneuten `up` werden alle Konten mit twoFactorEnabled = true
-- erneut markiert.
ALTER TABLE "cockpit"."user" DROP COLUMN IF EXISTS "aktiviert_am";
