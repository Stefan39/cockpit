/**
 * `fehlerhafteFelder` und `abfrageLesen` (COPI-36, COPI-38, COPI-164): die Antwort auf ungültige Eingabe nennt nur
 * Feldnamen, nie Werte. Ohne Datenbank; die Zod-Fehler entstehen aus kleinen Schemas per `safeParse`.
 */
import Fastify from 'fastify';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { abfrageLesen, fehlerhafteFelder } from '../src/intern/eingabe.js';

/** Die Fehler, die `safeParse` für `eingabe` meldet; schlägt fehl, wenn die Eingabe gültig ist. */
function fehlerVon(schema: z.ZodType, eingabe: unknown): z.ZodError {
  const ergebnis = schema.safeParse(eingabe);
  if (ergebnis.success) {
    throw new Error('Eingabe ist unerwartet gültig');
  }
  return ergebnis.error;
}

describe('fehlerhafteFelder', () => {
  it('nennt mehrere Felder sortiert und ohne Wiederholung', () => {
    const schema = z.object({
      zeta: z.string(),
      alpha: z.number(),
      liste: z.array(z.string()),
    });
    const fehler = fehlerVon(schema, { zeta: 1, alpha: 'x', liste: [1, 2] });
    expect(fehlerhafteFelder(fehler)).toEqual(['alpha', 'liste.0', 'liste.1', 'zeta']);

    const doppelt = fehlerVon(z.object({ name: z.string().min(5).regex(/^[0-9]+$/) }), { name: 'ab' });
    expect(doppelt.issues.length).toBeGreaterThan(1);
    expect(fehlerhafteFelder(doppelt)).toEqual(['name']);
  });

  it('nennt einen verschachtelten Pfad mit Punkten', () => {
    const schema = z.object({
      agenten: z.array(z.object({ zeitplan: z.array(z.object({ name: z.string() })) })),
    });
    const fehler = fehlerVon(schema, {
      agenten: [{ zeitplan: [] }, { zeitplan: [] }, { zeitplan: [{ name: 5 }] }],
    });
    expect(fehlerhafteFelder(fehler)).toEqual(['agenten.2.zeitplan.0.name']);
  });

  it('beendet den Pfad nach grenzen', () => {
    const schema = z.object({ grenzen: z.record(z.string(), z.number()) });
    const fehler = fehlerVon(schema, { grenzen: { 'Betrag je Rechnung': 'viel' } });
    expect(fehler.issues[0]?.path).toEqual(['grenzen', 'Betrag je Rechnung']);
    expect(fehlerhafteFelder(fehler)).toEqual(['grenzen']);

    const tief = z.object({ agent: z.object({ grenzen: z.record(z.string(), z.number()) }) });
    expect(fehlerhafteFelder(fehlerVon(tief, { agent: { grenzen: { anzahl: 'x' } } }))).toEqual(['agent.grenzen']);
  });

  it('nennt ein harmloses unbekanntes Feld mit Namen', () => {
    const schema = z.strictObject({ name: z.string() });
    const fehler = fehlerVon(schema, { name: 'a', extra_feld: 1 });
    expect(fehlerhafteFelder(fehler)).toEqual(['extra_feld']);
  });

  it('versteckt ein unbekanntes Feld mit Leer- oder Sonderzeichen', () => {
    const schema = z.strictObject({ name: z.string() });
    const fehler = fehlerVon(schema, { name: 'a', 'Betrag je Rechnung': 1, 'a@b.example': 2 });
    expect(fehlerhafteFelder(fehler)).toEqual(['(unbekanntes Feld)']);
  });

  it('hängt ein unbekanntes Feld an den Pfad des Objekts', () => {
    const schema = z.object({ innen: z.strictObject({ ok: z.string() }) });
    const fehler = fehlerVon(schema, { innen: { ok: 'a', fremd: 1, 'mit leer': 2 } });
    expect(fehlerhafteFelder(fehler)).toEqual(['innen.(unbekanntes Feld)', 'innen.fremd']);
  });

  it('meldet einen Fehler am ganzen Rumpf als (rumpf)', () => {
    const schema = z.object({ name: z.string() });
    const fehler = fehlerVon(schema, 42);
    expect(fehlerhafteFelder(fehler)).toEqual(['(rumpf)']);
  });

  it('gibt keinen Wert der Eingabe zurück', () => {
    const schema = z.strictObject({
      zahl: z.number(),
      liste: z.array(z.number()),
      grenzen: z.record(z.string(), z.number()),
    });
    const eingabe = {
      zahl: 'geheimer-wert-1',
      liste: ['geheimer-wert-2'],
      grenzen: { 'geheimer schluessel': 'geheimer-wert-3' },
      'geheimer name': 'geheimer-wert-4',
    };
    const ergebnis = JSON.stringify(fehlerhafteFelder(fehlerVon(schema, eingabe)));
    expect(ergebnis).not.toContain('geheimer-wert');
    expect(ergebnis).not.toContain('geheimer schluessel');
    expect(ergebnis).not.toContain('geheimer name');
  });
});

describe('abfrageLesen', () => {
  const schema = z.strictObject({ limit: z.coerce.number().int().min(1) });

  /** Eine App, deren Probe-Route `abfrageLesen` aufruft und das Ergebnis der Funktion festhält. */
  function appMitProbe() {
    const app = Fastify();
    const ergebnisse: unknown[] = [];
    app.get('/probe', async (request, reply) => {
      const daten = abfrageLesen(schema, request.query, reply);
      ergebnisse.push(daten);
      if (daten === undefined) {
        return reply;
      }
      return { limit: daten.limit };
    });
    return { app, ergebnisse };
  }

  it('gibt bei gültiger Abfrage die Daten zurück und lässt die Route normal antworten', async () => {
    const { app, ergebnisse } = appMitProbe();
    const antwort = await app.inject({ method: 'GET', url: '/probe?limit=5' });
    expect(antwort.statusCode).toBe(200);
    expect(antwort.json()).toEqual({ limit: 5 });
    expect(ergebnisse).toEqual([{ limit: 5 }]);
    await app.close();
  });

  it('antwortet bei ungültiger Abfrage mit 400 und Feldnamen, ohne den Wert', async () => {
    const { app, ergebnisse } = appMitProbe();
    const antwort = await app.inject({ method: 'GET', url: '/probe?limit=geheimer-wert' });
    expect(antwort.statusCode).toBe(400);
    expect(antwort.json()).toEqual({ fehler: 'ungueltige_anfrage', felder: ['limit'] });
    expect(antwort.headers['cache-control']).toBe('no-store');
    expect(antwort.body).not.toContain('geheimer-wert');
    expect(ergebnisse).toEqual([undefined]);
    await app.close();
  });
});
