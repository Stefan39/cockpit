/**
 * Der Vertrag des Koordinators (`docs/koordinator-api.md`, COPI-61) hält mit dem Code Schritt — rein, ohne Datenbank.
 *
 * Die Agenten-Seite (`agent-koordinator.yaml`, n8n) schaut nicht in diesen Code. Deshalb prüft der Test, was der Workflow
 * nachbauen muss: der Beispiel-Rumpf ist genau der, den das Cockpit sendet, die Beispiel-Signatur lässt sich nachrechnen,
 * und Kopfzeilen, Grenzen und die Meldung bei Nichterreichbarkeit stehen so im Vertrag, wie der Code sie verwendet.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRIST_STANDARD_SEKUNDEN, GEHEIMNIS_MINDESTENS, rumpfBauen, signatur, ZEITLIMIT_MS } from '../src/chat/koordinator.js';
import { INHALT_HOECHSTENS } from '../src/chat/nachricht-speicher.js';
import { NICHT_ERREICHBAR } from '../src/server/routes/chat.js';

const vertrag = readFileSync('docs/koordinator-api.md', 'utf8');
const agentenApi = readFileSync('docs/agenten-api.md', 'utf8');

/** Der erste Treffer einer Gruppe, oder ein Fehler, der sagt, was im Vertrag fehlt. */
function aus(muster: RegExp, was: string): string {
  const treffer = muster.exec(vertrag)?.[1];
  if (treffer === undefined) {
    throw new Error(`Im Vertrag fehlt ${was}`);
  }
  return treffer;
}

describe('docs/koordinator-api.md', () => {
  const rumpf = aus(/Rumpf \(genau diese Felder[^\n]*\n\n```json\n(.+)\n```/, 'der Beispiel-Rumpf');
  const geheimnis = aus(/mit dem Geheimnis `([^`]+)`/, 'das Beispiel-Geheimnis');
  const zeitpunkt = Number(aus(/dem Zeitpunkt `(\d+)`/, 'der Beispiel-Zeitpunkt'));
  const erwartet = aus(/```text\n(sha256=[0-9a-f]{64})\n```/, 'die Beispiel-Signatur');

  it('zeigt genau den Rumpf, den das Cockpit sendet', () => {
    const felder = JSON.parse(rumpf) as { nachricht_id: number; benutzer: { id: string; rolle: string; name: string }; text: string; zeitpunkt: string };
    expect(
      rumpfBauen({ nachrichtId: felder.nachricht_id, benutzer: felder.benutzer, text: felder.text, zeitpunkt: new Date(felder.zeitpunkt) }),
    ).toBe(rumpf);
  });

  it('beschreibt jedes Feld des Rumpfs', () => {
    const felder = JSON.parse(rumpf) as Record<string, unknown>;
    const benutzer = felder.benutzer as Record<string, unknown>;
    const namen = [
      ...Object.keys(felder).filter((feld) => feld !== 'benutzer'),
      ...Object.keys(benutzer).map((feld) => `benutzer.${feld}`),
    ];
    for (const feld of namen) {
      expect(vertrag).toContain(`| \`${feld}\` |`);
    }
  });

  it('rechnet die Beispiel-Signatur so vor, wie das Cockpit signiert', () => {
    expect(signatur(geheimnis, zeitpunkt, rumpf)).toBe(erwartet);
    expect(geheimnis.length).toBeGreaterThanOrEqual(GEHEIMNIS_MINDESTENS);
  });

  it('nennt Kopfzeilen, Grenzen und Voreinstellungen wie der Code', () => {
    for (const kopf of ['content-type', 'x-cockpit-zeitpunkt', 'x-cockpit-signatur']) {
      expect(vertrag).toContain(`| \`${kopf}\` |`);
    }
    expect(vertrag).toContain(`höchstens ${String(ZEITLIMIT_MS / 1000)} Sekunden`);
    expect(vertrag).toContain(`Standard ${String(FRIST_STANDARD_SEKUNDEN)}`);
    expect(vertrag).toContain(`mindestens ${String(GEHEIMNIS_MINDESTENS)} Zeichen`);
    expect(vertrag).toContain(`höchstens ${String(INHALT_HOECHSTENS)} Zeichen`);
  });

  it('zeigt ein Beispiel, das der Code-Knoten von n8n annimmt (COPI-70)', () => {
    // NODE_FUNCTION_ALLOW_BUILTIN vergleicht den Modulnamen wörtlich: 'node:crypto' bleibt gesperrt.
    const beispiel = aus(/```js\n([\s\S]+?)\n```/, 'das Node-Beispiel');
    expect(beispiel).not.toContain("require('node:");
    expect(beispiel).toContain("require('crypto')");
    expect(vertrag).toContain('`NODE_FUNCTION_ALLOW_BUILTIN=crypto`');
  });

  it('sagt, wie der Workflow in n8n zu bauen ist (COPI-71)', () => {
    const umsetzung = aus(/\n## Umsetzung in n8n\n([\s\S]+?)\n## /, 'der Abschnitt „Umsetzung in n8n"');
    // Mit dem AI-Agent v3 läuft nur der normale HTTP-Request-Knoten als Werkzeug.
    expect(umsetzung).toContain('`n8n-nodes-base.httpRequestTool`');
    expect(umsetzung).toContain('`@n8n/n8n-nodes-langchain.toolHttpRequest`');
    // Die Signatur geht über den rohen Rumpf; ohne „Raw Body" gibt es ihn nicht.
    expect(umsetzung).toContain('Raw Body');
    // Das Geheimnis nie über $env, denn das öffnet jedem Code-Knoten alle Env-Werte.
    expect(umsetzung).toContain('`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`');
    expect(vertrag).not.toContain('Respond Immediately');
  });

  it('zitiert die Meldung bei Nichterreichbarkeit wörtlich', () => {
    expect(vertrag).toContain(`„${NICHT_ERREICHBAR}"`);
  });

  it('nennt Routen, Rechte und Fehlercodes des Koordinators', () => {
    for (const teil of ['`POST /intern/chat/antwort`', '`GET /intern/zustand`', '`GET /intern/chat/verbrauch`', '`chat_antworten`', '`zustand_lesen`']) {
      expect(vertrag).toContain(teil);
    }
    for (const code of ['ungueltige_anfrage', 'nicht_angemeldet', 'nicht_erlaubt', 'nicht_gefunden', 'schon_beantwortet']) {
      expect(vertrag).toContain(`"fehler": "${code}"`);
    }
  });

  it('wird aus dem Vertrag der Agenten-API verlinkt', () => {
    expect(agentenApi).toContain('(koordinator-api.md)');
  });
});
