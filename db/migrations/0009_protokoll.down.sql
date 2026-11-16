-- Nimmt 0009 zurück. Das entfernt das gesamte Protokoll mit seinen Einträgen —
-- als bewusster Schritt der Migration, nicht als Weg der Anwendung: die Sperre
-- gilt für Zeilen, nicht für die Tabelle selbst (DROP TABLE löst keinen
-- Zeilen-Trigger aus).
DROP TABLE "cockpit"."protokoll";
DROP FUNCTION "cockpit"."protokoll_nur_anhaengen"();
