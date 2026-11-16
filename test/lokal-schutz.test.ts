/**
 * `scripts/dev/lokal-schutz.ts` (COPI-80): die Dev-Werkzeuge `./dev demo` und `./dev vorschau`
 * dürfen niemals gegen eine Kundeninstanz laufen. Reine Funktion, ohne Datenbank und ohne Prozess.
 */
import { describe, expect, it } from 'vitest';
import { lokalPruefen, sicherstellenLokal, sicherstellenLokaleDatenbankUrl } from '../scripts/dev/lokal-schutz.js';

const LOKALE_URL = 'postgres://postgres:dev@localhost:5432/cockpit';

describe('lokalPruefen (COPI-80)', () => {
  it('erlaubt localhost in der Entwicklung', () => {
    expect(lokalPruefen({ nodeEnv: 'development', databaseUrl: LOKALE_URL })).toEqual({ ok: true });
  });

  it.each(['127.0.0.1', '[::1]'])('erlaubt %s als Host', (host) => {
    const ergebnis = lokalPruefen({ nodeEnv: 'development', databaseUrl: `postgres://u:p@${host}:5432/cockpit` });
    expect(ergebnis.ok).toBe(true);
  });

  it('bricht bei NODE_ENV=production ab, auch mit lokaler URL', () => {
    const ergebnis = lokalPruefen({ nodeEnv: 'production', databaseUrl: LOKALE_URL });
    expect(ergebnis.ok).toBe(false);
  });

  it('bricht ohne DATABASE_URL ab', () => {
    const ergebnis = lokalPruefen({ nodeEnv: 'development', databaseUrl: undefined });
    expect(ergebnis.ok).toBe(false);
  });

  it('bricht bei einer leeren DATABASE_URL ab', () => {
    const ergebnis = lokalPruefen({ nodeEnv: 'development', databaseUrl: '' });
    expect(ergebnis.ok).toBe(false);
  });

  it('bricht bei einem fremden Host ab', () => {
    const ergebnis = lokalPruefen({ nodeEnv: 'development', databaseUrl: 'postgres://u:p@db.kunde.example:5432/cockpit' });
    expect(ergebnis.ok).toBe(false);
  });

  it('bricht bei einer kaputten URL ab', () => {
    const ergebnis = lokalPruefen({ nodeEnv: 'development', databaseUrl: 'nicht-eine-url' });
    expect(ergebnis.ok).toBe(false);
  });

  it('erlaubt NODE_ENV=test gegen localhost (Vitest selbst)', () => {
    expect(lokalPruefen({ nodeEnv: 'test', databaseUrl: LOKALE_URL })).toEqual({ ok: true });
  });
});

describe('sicherstellenLokal (COPI-80)', () => {
  it('wirft mit dem Grund, wenn die Prüfung scheitert', () => {
    expect(() => sicherstellenLokal({ nodeEnv: 'production', databaseUrl: undefined })).toThrow(/production/);
  });

  it('wirft nicht, wenn die Prüfung besteht', () => {
    expect(() => sicherstellenLokal({ nodeEnv: 'development', databaseUrl: LOKALE_URL })).not.toThrow();
  });
});

describe('sicherstellenLokaleDatenbankUrl (COPI-80)', () => {
  it('liefert die geprüfte DATABASE_URL zurück', () => {
    expect(sicherstellenLokaleDatenbankUrl({ nodeEnv: 'development', databaseUrl: LOKALE_URL })).toBe(LOKALE_URL);
  });

  it('wirft wie sicherstellenLokal, wenn die Prüfung scheitert', () => {
    expect(() =>
      sicherstellenLokaleDatenbankUrl({ nodeEnv: 'development', databaseUrl: 'postgres://u:p@kunde.example:5432/db' }),
    ).toThrow(/localhost/);
  });
});
