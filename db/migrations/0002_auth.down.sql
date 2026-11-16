-- Nimmt 0002_auth zurück. Reihenfolge wegen der Fremdschlüssel auf "user".
DROP TABLE IF EXISTS "cockpit"."erststart_token";
DROP TABLE IF EXISTS "cockpit"."twoFactor";
DROP TABLE IF EXISTS "cockpit"."verification";
DROP TABLE IF EXISTS "cockpit"."account";
DROP TABLE IF EXISTS "cockpit"."session";
DROP TABLE IF EXISTS "cockpit"."user";
