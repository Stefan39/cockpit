# Beiträge

Danke für dein Interesse am Cockpit. Fehler und Vorschläge als Issue, Änderungen als Pull Request gegen `main`.

## Bevor du anfängst

- Lies [`docs/architektur-leitplanken.md`](docs/architektur-leitplanken.md): Das Cockpit prüft und aktualisiert nichts selbst,
  nichts wird physisch gelöscht, Modulseiten sind deklariert. Änderungen an diesen Grenzen sind keine Implementierungsdetails.
- Größere Änderungen bitte erst als Issue besprechen.

## Entwicklung

```bash
npm ci
npm run typecheck && npm run lint && npm test
```

Die Datenbank-Tests laufen nur mit `TEST_DATABASE_URL` (eine Datenbank, deren Name auf `_test` endet). Pull Requests brauchen
grüne Gates: Typecheck, ESLint, Vitest, Duplikate (`npm run dupes`), Secret-Scan (`npm run secretscan`) und den Docker-Bau.

## Lizenz und Herkunft der Beiträge

Das Projekt steht unter der [Apache-2.0](LICENSE). Mit einem Beitrag erklärst du, dass du ihn selbst geschrieben hast oder
weitergeben darfst, und stimmst der Lizenz zu (Abschnitt 5 der Lizenz). Bestätige das mit einem `Signed-off-by` in jedem
Commit (`git commit -s`, Developer Certificate of Origin). Eine zusätzliche Vereinbarung (CLA) gibt es nicht.
