-- Nimmt 0013 zurück: offene Challenges gehen verloren, die Vorgänge selbst bleiben.
ALTER TABLE "cockpit"."anmeldevorgang"
    DROP CONSTRAINT "anmeldevorgang_challenge_mit_ablauf";

ALTER TABLE "cockpit"."anmeldevorgang"
    DROP COLUMN "passkey_challenge",
    DROP COLUMN "passkey_challenge_ablauf_am";
