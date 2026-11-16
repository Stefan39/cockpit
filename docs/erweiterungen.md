# Erweiterungen im Cockpit-Kern (COPI-193)

Der Kern hat **einen** neutralen Erweiterungspunkt: Ein Modul kann Routen und einen Navigationseintrag anmelden, ohne
dass der Kern es kennt. Beschlossen in COPI-191 (Option B, Entscheidung Stefan, 21.10.2026). Im Kundenimage ist die Liste
der Erweiterungen leer: dann gibt es keine zusätzliche Route, keinen zusätzlichen Haken und keinen zusätzlichen
Navigationseintrag, das Kundenverhalten ändert sich nicht.

Der Kern kennt weder einen Schalter noch ein dynamisches `import()`. Die Erweiterungen kommen als Liste über
`AppAbhaengigkeiten.erweiterungen` in `buildApp`; wer sie übergibt (ein Projekt, das den Kern erweitert, etwa mit eigenen Seiten), baut den Einstieg selbst. Das Kundenimage startet über `dist/server/index.js` ohne Erweiterungen; ein erweiterndes Projekt ruft `cockpitStarten(erweiterungen)` aus demselben Modul auf.
Code: `src/server/erweiterungen.ts`, Test: `test/erweiterungen.test.ts`.

## Eine Erweiterung

```ts
const erweiterung: Erweiterung = {
  kennung: 'beispiel',                 // eindeutig; markiert den Eintrag in der Navigation
  recht: 'update_beantragen',          // jede Route und der Eintrag verlangen dieses Recht (hatRecht)
  navigation: { text: 'Beispiel', href: '/beispiel' },   // höchstens ein Eintrag, optional
  plugin: async (kapsel, { zugangLesen }) => {
    kapsel.get('/beispiel', async (request, reply) => {
      const nav = navigationFuerZugang('erweiterung', await zugangLesen(request), 'beispiel');
      return reply.type('text/html; charset=utf-8').send(await kapsel.render('seite.eta', { titel: 'Beispiel', nav }));
    });
  },
};
```

Das Plugin bekommt eine gekapselte Fastify-Instanz und als Optionen den Zugangsleser des Kerns. Dessen Zugang trägt die
Einträge der Erweiterungen, `navigationFuerZugang('erweiterung', zugang, '<kennung>')` markiert den eigenen Eintrag.

## Was der Kern erzwingt

| Regel | Wirkung |
| --- | --- |
| nur `GET` und `HEAD` | Jede andere Methode lässt den Start scheitern (`app.ready()` wirft, der `onRoute`-Wächter der Kapsel). |
| kein `/pipeline`, kein `/intern`, keine Sammelroute | Pfade, die in **irgendeiner** Schreibweise (`/INTERN`, `/%69ntern`, `/intern%2Fx`) auf die maschinellen Schnittstellen zeigen, und jeder Pfad mit `*` lassen den Start scheitern. Das Tor lässt diese beiden Bereiche ohne Sitzung durch, dort darf keine Erweiterung liegen. Ebenso ein Parameter im ersten Pfadsegment. |
| hinter dem Tor | Die Routen liegen wie jede geschützte Route hinter Sitzung und zweitem Faktor: anonym Umleitung auf `/anmelden`, ohne zweiten Faktor auf `/zwei-faktor`. |
| Recht | Wer das Recht nicht hat, bekommt dieselbe neutrale 404 wie überall und sieht keinen Eintrag. |
| ein Eintrag | Höchstens einer je Erweiterung; sein Ziel unterliegt denselben Pfadregeln. Kennungen sind eindeutig. |

## Navigation

- Am Desktop steht der Eintrag an Position 2, direkt hinter „Übersicht" und vor den angehefteten Modulen (`nurDesktop`).
- Mobil steht er unter „Mehr" (ganz oben in `nav.mehr`, `nurMobil`). Die Tab-Leiste behält ihre fünf festen Plätze.
- Symbol: das vorhandene `agenten`.
- Ohne Erweiterung liefert `navigation()` für jede Rolle genau die Einträge von vorher in derselben Reihenfolge; der Nachweis
  ist ein Test (`test/erweiterungen.test.ts`), kein unveränderter Dateiinhalt.

## Der Kern als Abhängigkeit (COPI-250)

Ein eigenes Projekt, das den Kern erweitert (etwa ein Image mit eigenen Seiten), bindet ihn als Paket ein. Der Kern
heißt `@stefan39/cockpit`, ist per Git-Tag installierbar und ist kein veröffentlichtes npm-Paket.

```jsonc
// package.json des Verbrauchers
"dependencies": { "@stefan39/cockpit": "github:Stefan39/cockpit#v1.2.0" }
```

**Was `npm install` tut:** Nach dem Holen läuft `prepare` des Kerns (`scripts/kern-vorbereiten.mjs`) und baut `dist/` mit den
Typdateien und die Assets (Stylesheet, Schriften), denn beides liegt nicht im Repo. Der Verbraucher braucht dafür weder
TypeScript-Konfiguration des Kerns noch Tailwind. Im Kern selbst und im Dockerfile tut `prepare` nichts.

**Schnittstelle (`exports` in `package.json`):**

| Pfad | Inhalt |
| --- | --- |
| `@stefan39/cockpit` | der Einstieg `dist/server/index.js` (`cockpitStarten`, `istEinstieg`) |
| `@stefan39/cockpit/<ordner>/<datei>` | jedes übersetzte Modul aus `src/`, mit Typen, ohne Endung: `…/server/erweiterungen`, `…/pipeline/queue` |
| `@stefan39/cockpit/testen/<datei>` | die Testhilfen des Kerns (`hilfen`, `testdatenbank`, `global-setup`) als TypeScript-Quelle, nur für Tests |
| `@stefan39/cockpit/testen/fach-migrationen` | der Einspieler für Fachmigrationen (`scripts/dev/fach-migrationen.ts`), nur für Tests |

Eine Stabilitätszusage gibt es für das, was in diesem Dokument und in [`docs/modul-vertrag.md`](modul-vertrag.md) steht
(`Erweiterung`, `navigationFuerZugang`, die Agenten-API); der übrige Teil der Pfade ist die Fläche, die bisher erweiternde
Projekte brauchen, und kann sich mit einer Minor-Version ändern. Die Verbraucher heben den Tag deshalb nur über einen PR mit
voller CI an.

**Zur Laufzeit im Image:** Ein erweiterndes Image ist der Kern plus die eigenen Dateien (etwa `dist/<name>/`, `views/<name>/`). Weil der
Kern ein `exports`-Feld und einen Namen hat, finden die übersetzten Dateien ihn über die Selbstreferenz `@stefan39/cockpit/...`;
ein Link in `node_modules` ist nicht nötig. Die Ansichten der Erweiterung liegen unter `views/<name>/`, denn der Renderer
des Kerns liest nur sein eigenes `views/`.

**Tests des Verbrauchers** brauchen: die Datenbank-Einrichtung des Kerns als `globalSetup`
(`node_modules/@stefan39/cockpit/test/global-setup.ts`, braucht `tsx` als Entwicklungsabhängigkeit; die Testhilfe `hilfen` liest
QR-Codes und braucht `jsqr` als Entwicklungsabhängigkeit), `server.deps.inline` für
`@stefan39/cockpit` in der Vitest-Konfiguration und einen Link vom eigenen `views/<name>/` nach
`node_modules/@stefan39/cockpit/views/<name>`, damit der Renderer des Kerns die Ansichten findet.
