/**
 * Push bei neuen Einträgen im Posteingang (COPI-116) ohne Datenbank: was als neu gilt, der Text ohne Inhalt und das
 * Kennzeichen eines Eintrags.
 */
import { describe, expect, it } from 'vitest';
import {
  eintragKennzeichen,
  GESEHEN_HOECHSTENS,
  posteingangPushRumpf,
  pushAuswerten,
  pushText,
  type PosteingangTeile,
} from '../src/posteingang/push.js';
import type { PosteingangEintrag, PosteingangQuelle } from '../src/posteingang/posteingang.js';

function eintrag(quelle: PosteingangQuelle, nummer: number): PosteingangEintrag {
  return {
    quelle,
    herkunft: quelle,
    titel: `Titel ${String(nummer)} – Familie Brandt`,
    anriss: 'GEHEIM: Inhalt',
    zeit: new Date(Date.UTC(2026, 9, 2, 10, nummer)),
    href: `/ziel/${String(nummer)}`,
  };
}

function teile(eintraege: readonly PosteingangEintrag[], zusatz = 0): PosteingangTeile {
  const ergebnis: Partial<Record<PosteingangQuelle, { eintraege: PosteingangEintrag[]; anzahl: number }>> = {};
  for (const e of eintraege) {
    const teil = (ergebnis[e.quelle] ??= { eintraege: [], anzahl: 0 });
    teil.eintraege.push(e);
    teil.anzahl++;
  }
  if (zusatz > 0) {
    const teil = (ergebnis.postfach ??= { eintraege: [], anzahl: 0 });
    teil.anzahl += zusatz;
  }
  return ergebnis;
}

describe('pushAuswerten', () => {
  const alt = [eintrag('postfach', 1), eintrag('meldung', 2)];

  it('meldet beim ersten Lauf nichts, merkt sich aber alles', () => {
    const auswertung = pushAuswerten(teile(alt), undefined);

    expect(auswertung.push).toBeUndefined();
    expect(auswertung.stand).toEqual({ gesamt: 2, gesehen: alt.map(eintragKennzeichen) });
  });

  it('meldet nichts, wenn nichts neu ist — auch wenn etwas gelesen wurde', () => {
    const stand = pushAuswerten(teile(alt), undefined).stand;

    expect(pushAuswerten(teile(alt), stand).push).toBeUndefined();
    expect(pushAuswerten(teile([eintrag('postfach', 1)]), stand).push).toBeUndefined();
  });

  it('meldet einen neuen Eintrag mit dem Satz seiner Quelle', () => {
    const stand = pushAuswerten(teile(alt), undefined).stand;

    expect(pushAuswerten(teile([...alt, eintrag('meldung', 3)]), stand).push).toEqual({
      text: 'Neue Meldung: ein Dienst braucht Aufmerksamkeit.',
      neu: 1,
    });
  });

  it('meldet neu, auch wenn gleichzeitig etwas gelesen wurde (die Zahl bleibt gleich)', () => {
    const stand = pushAuswerten(teile(alt), undefined).stand;

    expect(pushAuswerten(teile([eintrag('postfach', 1), eintrag('chat', 4)]), stand).push).toEqual({ text: 'Neue Nachricht im Chat.', neu: 1 });
  });

  it('meldet einen Zuwachs jenseits der jüngsten Einträge über die Gesamtzahl', () => {
    const stand = pushAuswerten(teile(alt), undefined).stand;

    expect(pushAuswerten(teile(alt, 2), stand).push).toEqual({ text: '2 neue Einträge im Posteingang.', neu: 2 });
  });

  it('fasst mehrere zusammen; eine Freigabe geht im Text vor', () => {
    const stand = pushAuswerten(teile(alt), undefined).stand;

    expect(pushAuswerten(teile([...alt, eintrag('postfach', 5), eintrag('freigabe', 6)]), stand).push).toEqual({
      text: 'Freigabe nötig – insgesamt 2 neue Einträge im Posteingang.',
      neu: 2,
    });
    expect(pushAuswerten(teile([...alt, eintrag('freigabe', 6)]), stand).push?.text).toBe('Freigabe nötig: eine Antwort wartet auf dich.');
  });

  it('merkt sich höchstens 200 Kennzeichen, die jüngsten zuerst', () => {
    const viele = Array.from({ length: 150 }, (_wert, index) => eintrag('postfach', index));
    const stand = pushAuswerten(teile(viele), undefined).stand;
    const weitere = Array.from({ length: 150 }, (_wert, index) => eintrag('meldung', index));

    const neu = pushAuswerten(teile(weitere), stand).stand;

    expect(neu.gesehen).toHaveLength(GESEHEN_HOECHSTENS);
    expect(neu.gesehen[0]).toBe(eintragKennzeichen(weitere[0] as PosteingangEintrag));
  });
});

describe('Inhalt des Push', () => {
  it('nennt nie Titel oder Text eines Eintrags', () => {
    const neu = [eintrag('postfach', 1)];
    const rumpf = posteingangPushRumpf(pushText(neu, 1), 3);

    expect(rumpf).not.toContain('Brandt');
    expect(rumpf).not.toContain('GEHEIM');
    expect(JSON.parse(rumpf)).toEqual({ titel: 'Cockpit', text: 'Neuer Eintrag im Posteingang.', ziel: 'posteingang', anzahl: 3 });
  });

  it('kennzeichnet einen Eintrag mit 16 Hex, ohne Klartext, und unterscheidet den Zeitpunkt', () => {
    const a = eintrag('meldung', 1);

    expect(eintragKennzeichen(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(eintragKennzeichen({ ...a, zeit: new Date(a.zeit.getTime() + 1000) })).not.toBe(eintragKennzeichen(a));
  });
});
