/**
 * Das Token der Agenten-API (COPI-35) — rein, ohne Datenbank und ohne Server.
 *
 * Geprüft werden Erzeugung, Hash und vor allem das Lesen der `Authorization`-Kopfzeile: Nur ein
 * wohlgeformtes Token darf überhaupt zur Datenbank durchdringen. Die Beispiele stehen als
 * Literale, damit der Test eine aufgeweichte Regel nicht einfach mitrechnet.
 */
import { describe, expect, it } from 'vitest';
import { tokenHashen } from '../src/auth/einmal-token.js';
import {
  API_SCOPES,
  API_TOKEN_NAME,
  API_TOKEN_PRAEFIX,
  apiTokenErzeugen,
  istApiScope,
  tokenAusKopf,
} from '../src/intern/token.js';

/** So sieht ein Token aus: `cpk_` und 43 Zeichen base64url (32 Byte). */
const GUELTIG = `cpk_${'A1b2C3d4E5'.repeat(4)}xYz`;

describe('apiTokenErzeugen', () => {
  it('erzeugt ein Token mit erkennbarem Präfix und 32 Byte Zufall', () => {
    const { token } = apiTokenErzeugen();

    expect(token.startsWith('cpk_')).toBe(true);
    expect(API_TOKEN_PRAEFIX).toBe('cpk_');
    // 4 Zeichen Präfix + 43 Zeichen base64url für 32 Byte.
    expect(token).toHaveLength(47);
    expect(token).toMatch(/^cpk_[A-Za-z0-9_-]{43}$/);
  });

  it('liefert den SHA-256-Hash des Tokens und nichts anderes zum Speichern', () => {
    const { token, hash } = apiTokenErzeugen();

    expect(hash).toBe(tokenHashen(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.slice(4, 20));
  });

  it('erzeugt jedes Mal ein anderes Token', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => apiTokenErzeugen().token));

    expect(tokens.size).toBe(200);
  });
});

describe('tokenAusKopf — nur ein wohlgeformtes Token kommt durch', () => {
  it('liest „Bearer <token>"', () => {
    expect(tokenAusKopf(`Bearer ${GUELTIG}`)).toBe(GUELTIG);
  });

  it('liest das Schema ohne Rücksicht auf die Schreibweise (RFC 7235)', () => {
    expect(tokenAusKopf(`bearer ${GUELTIG}`)).toBe(GUELTIG);
    expect(tokenAusKopf(`BEARER ${GUELTIG}`)).toBe(GUELTIG);
  });

  it.each([
    ['fehlt ganz', undefined],
    ['ist leer', ''],
    ['nennt nur das Schema', 'Bearer'],
    ['nennt das Schema mit Leerzeichen, aber ohne Token', 'Bearer '],
    ['nutzt ein anderes Schema', `Basic ${GUELTIG}`],
    ['gibt das Token ohne Schema', GUELTIG],
    ['hat zwei Leerzeichen', `Bearer  ${GUELTIG}`],
    ['hat ein Leerzeichen am Ende', `Bearer ${GUELTIG} `],
    ['hat ein Leerzeichen am Anfang', ` Bearer ${GUELTIG}`],
    ['hat einen Tabulator statt des Leerzeichens', `Bearer\t${GUELTIG}`],
    ['enthält einen Zeilenumbruch', `Bearer ${GUELTIG}\nX-Andere: 1`],
    ['nennt zwei Token', `Bearer ${GUELTIG}, Bearer ${GUELTIG}`],
    ['hat ein falsches Präfix', `Bearer xyz_${'A'.repeat(43)}`],
    ['ist zu kurz', `Bearer cpk_${'A'.repeat(42)}`],
    ['ist zu lang', `Bearer cpk_${'A'.repeat(44)}`],
    ['enthält ein Zeichen außerhalb von base64url', `Bearer cpk_${'A'.repeat(42)}+`],
    ['enthält ein Gleichheitszeichen (base64 mit Auffüllung)', `Bearer cpk_${'A'.repeat(42)}=`],
    ['ist ein anderes Einmal-Token der Anwendung', `Bearer ${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v'}`],
  ])('lehnt einen Kopf ab, der %s', (_name, kopf) => {
    expect(tokenAusKopf(kopf)).toBeUndefined();
  });

  it('wirft bei keiner Eingabe, auch nicht bei ungewöhnlichen Zeichen', () => {
    for (const kopf of ['Bearer \u0000', 'Bearer ä', `Bearer ${'A'.repeat(100_000)}`, 'Bearer %s%s%s']) {
      expect(() => tokenAusKopf(kopf)).not.toThrow();
      expect(tokenAusKopf(kopf)).toBeUndefined();
    }
  });
});

describe('Scopes', () => {
  it('kennt genau die Berechtigungen der Agenten-API', () => {
    expect([...API_SCOPES]).toEqual(['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben', 'verbrauch_lesen', 'pipeline_verwalten']);
  });

  it.each(['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben', 'verbrauch_lesen', 'pipeline_verwalten'])('erkennt %s', (scope) => {
    expect(istApiScope(scope)).toBe(true);
  });

  it.each(['', 'admin', 'befund:schreiben', 'BEFUND_SCHREIBEN', 'befund_schreiben ', '*', 'alles'])(
    'lehnt %j als Scope ab',
    (scope) => {
      expect(istApiScope(scope)).toBe(false);
    },
  );
});

describe('Name eines Zugangs', () => {
  it.each(['admin-agent', 'koordinator', 'agent_1', 'a', 'a'.repeat(40)])('nimmt %s an', (name) => {
    expect(API_TOKEN_NAME.test(name)).toBe(true);
  });

  it.each(['', 'Admin', '-zuerst', '_zuerst', 'mit leerzeichen', 'mit.punkt', 'a'.repeat(41), 'ä', 'x@y'])(
    'lehnt %j ab',
    (name) => {
      // Der Name landet im Protokoll (Kennung, höchstens 40 Zeichen) — dort passt keine Adresse hinein.
      expect(API_TOKEN_NAME.test(name)).toBe(false);
    },
  );
});
