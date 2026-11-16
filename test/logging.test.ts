/**
 * Token im Pfad dürfen nicht in den Log (COPI-28) — rein, ohne Datenbank.
 *
 * `/erststart/<token>`, `/einladung/<token>` und `/zugang-wiederherstellen/<token>` tragen
 * ein Einmal-Token im Pfad. Fastify loggt die Adresse jeder Anfrage; wer den Log liest,
 * hätte sonst ein gültiges Token (bis zu 24 Stunden lang). Deshalb maskiert die Adresse,
 * die in den Log geht, den Teil nach dem Präfix. Die erwarteten Werte stehen als Literale.
 *
 * Maskiert wird lieber zu viel als zu wenig: auch andere Schreibweisen, die noch zur
 * Route führen könnten (Groß-/Kleinschreibung, Prozent-Kodierung, doppelte Schrägstriche,
 * `..`), und der ganze Rest des Pfades samt Abfrage.
 */
import { describe, expect, it } from 'vitest';
import { urlOhneToken } from '../src/server/logging.js';

describe('urlOhneToken', () => {
  it.each([
    ['/erststart/abc123', '/erststart/<token>'],
    ['/einladung/A1b2-C3_d4', '/einladung/<token>'],
    ['/zugang-wiederherstellen/tok', '/zugang-wiederherstellen/<token>'],
  ])('maskiert das Token in %s', (url, erwartet) => {
    expect(urlOhneToken(url)).toBe(erwartet);
  });

  it.each([
    ['/einladung/tok?next=/x&t=geheim', '/einladung/<token>'],
    ['/einladung/tok/extra', '/einladung/<token>'],
    ['/EINLADUNG/tok', '/einladung/<token>'],
    ['/%65inladung/tok', '/einladung/<token>'],
    ['//einladung/tok', '/einladung/<token>'],
    ['/anmelden/../einladung/tok', '/einladung/<token>'],
    ['/Zugang-Wiederherstellen/tok', '/zugang-wiederherstellen/<token>'],
    ['/erststart/%41bc', '/erststart/<token>'],
  ])('maskiert auch die Schreibweise %s', (url, erwartet) => {
    expect(urlOhneToken(url)).toBe(erwartet);
  });

  it.each([
    '/anmelden',
    '/anmelden/code',
    '/gesund',
    '/',
    '/einladung',
    '/einladung/',
    '/erststart',
    '/zugang-wiederherstellen',
    '/anmelden?x=1',
    '/zwei-faktor/passkey/optionen',
    '/api/auth/get-session',
  ])('lässt %s unverändert: dort steht kein Token', (url) => {
    expect(urlOhneToken(url)).toBe(url);
  });

  it('wirft bei kaputter Kodierung nicht, sondern maskiert im Zweifel', () => {
    expect(urlOhneToken('/einladung/%E0%A4%A')).toBe('/einladung/<token>');
    expect(urlOhneToken('/%E0%A4%A')).toBe('/%E0%A4%A');
  });
});

/**
 * Die Agenten-API (COPI-35) nimmt das Token nur in der `Authorization`-Kopfzeile. Fastify loggt keine
 * Kopfzeilen, die Adresse aber samt Abfrage: hängt ein Client das Token versehentlich an
 * (`?token=…`, `?access_token=…`), stünde es sonst im Log. Deshalb geht unter `/intern` nur der
 * Pfad in den Log, nie die Abfrage — auch bei Schreibweisen, die nicht zur Route führen.
 */
describe('urlOhneToken — Agenten-API', () => {
  it.each([
    ['/intern/befund?token=cpk_geheim', '/intern/befund'],
    ['/intern/befund?access_token=cpk_geheim&x=1', '/intern/befund'],
    ['/intern/ping?', '/intern/ping'],
    ['/intern?token=cpk_geheim', '/intern'],
    ['/INTERN/befund?token=cpk_geheim', '/INTERN/befund'],
    ['/%69ntern/befund?token=cpk_geheim', '/%69ntern/befund'],
    ['//intern/befund?token=cpk_geheim', '//intern/befund'],
  ])('lässt die Abfrage von %s aus dem Log', (url, erwartet) => {
    expect(urlOhneToken(url)).toBe(erwartet);
  });

  it('lässt den Pfad unter /intern unverändert, damit der Log weiter nützlich bleibt', () => {
    expect(urlOhneToken('/intern/eingriffe/7')).toBe('/intern/eingriffe/7');
  });

  it('ändert Adressen außerhalb von /intern nicht (die Abfrage dort bleibt wie bisher)', () => {
    expect(urlOhneToken('/anmelden?next=/x')).toBe('/anmelden?next=/x');
    expect(urlOhneToken('/internal?x=1')).toBe('/internal?x=1');
  });
});
