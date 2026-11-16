# Rulesets

`main.json` ist der Branch-Schutz für `main`, importierbar unter Settings → Rules → Rulesets → New ruleset → Import a ruleset:
Pull Request mit einer Freigabe (veraltete Freigaben verfallen, letzter Push muss freigegeben sein), Pflicht-Checks
`Gates 1-4 (typecheck, lint, test, duplication)` und `Gate 6 — Docker-Build`, kein Force-Push, kein Löschen, keine Ausnahmen.
Nur Merge-Commits. Ändert sich der Name eines Checks im Workflow, muss er hier mitgehen.
