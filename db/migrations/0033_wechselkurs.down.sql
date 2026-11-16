-- Nimmt 0033 zurück. Die gemeldeten Kurse gehen verloren — ein Werkzeug für die Entwicklung, kein Weg im Betrieb
-- (wie 0028).
DROP FUNCTION "cockpit"."in_eur"(numeric, text, date);
DROP TABLE "cockpit"."wechselkurs";
