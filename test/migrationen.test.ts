/**
 * Migrationen (COPI-31) — die reinen Teile, ohne Datenbank: die Migrationsdateien lesen und die
 * Meldungen der Start-Prüfung. Die Erwartungen stehen als Literale.
 */
import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ausstehendMeldung,
  MIGRATIONEN_ORDNER,
  migrationenLaden,
  type Migrationsstand,
} from '../src/datenbank/migrationen.js';
import { migrationsOrdnerBauen } from './leere-datenbank.js';

const aufraeumer: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const aufraeumen of aufraeumer.splice(0)) {
    await aufraeumen();
  }
});

async function ordner(migrationen: Parameters<typeof migrationsOrdnerBauen>[0]): Promise<string> {
  const gebaut = await migrationsOrdnerBauen(migrationen);
  aufraeumer.push(gebaut.aufraeumen);
  return gebaut.ordner;
}

describe('migrationenLaden — die echten Migrationen', () => {
  const dateien = readdirSync(MIGRATIONEN_ORDNER);
  const ups = dateien.filter((datei) => datei.endsWith('.up.sql')).sort();

  it('findet jede Migration des Repos, in der Reihenfolge ihrer Nummern, jede mit ihrem down-Paar', async () => {
    const geladen = await migrationenLaden();

    expect(geladen.map((migration) => migration.id)).toEqual(ups.map((datei) => datei.replace('.up.sql', '')));
    expect(geladen.length).toBeGreaterThanOrEqual(14);
    expect(geladen[0]?.id).toBe('0001_init');
    for (const migration of geladen) {
      expect(dateien).toContain(`${migration.id}.down.sql`);
    }
  });

  it('nummeriert lückenlos ab 0001: eine übersprungene Nummer wäre ein vergessenes Paar', async () => {
    const nummern = (await migrationenLaden()).map((migration) => Number(migration.id.slice(0, 4)));

    expect(nummern).toEqual(nummern.map((_wert, index) => index + 1));
  });
});

describe('migrationenLaden — erfundene Ordner', () => {
  it('sortiert nach der Nummer, nicht nach der Reihenfolge der Dateien', async () => {
    const verzeichnis = await ordner([
      { id: '0010_zehn', up: 'SELECT 1', down: 'SELECT 1' },
      { id: '0002_zwei', up: 'SELECT 1', down: 'SELECT 1' },
      { id: '0001_eins', up: 'SELECT 1', down: 'SELECT 1' },
    ]);

    expect((await migrationenLaden(verzeichnis)).map((migration) => migration.id)).toEqual([
      '0001_eins',
      '0002_zwei',
      '0010_zehn',
    ]);
  });

  it('weist eine Migration ohne down-Paar ab und nennt sie: ohne down gäbe es keinen Rückweg', async () => {
    const verzeichnis = await ordner([
      { id: '0001_eins', up: 'SELECT 1', down: 'SELECT 1' },
      { id: '0002_ohne_down', up: 'SELECT 1' },
    ]);

    await expect(migrationenLaden(verzeichnis)).rejects.toThrow(/0002_ohne_down.*down/);
  });

  it.each(['migration.up.sql', '1_zu_kurz.up.sql', 'ABCD_gross.up.sql', '0001_Mit-Bindestrich.up.sql'])(
    'weist den ungültigen Namen %s ab',
    async (name) => {
      const id = name.replace('.up.sql', '');
      const verzeichnis = await ordner([{ id, up: 'SELECT 1', down: 'SELECT 1' }]);

      await expect(migrationenLaden(verzeichnis)).rejects.toThrow(/Migrationsname/);
    },
  );

  it('liefert für einen leeren Ordner eine leere Liste', async () => {
    expect(await migrationenLaden(await ordner([]))).toEqual([]);
  });
});

describe('ausstehendMeldung', () => {
  function migration(id: string) {
    return { id, upPfad: `${id}.up.sql`, downPfad: `${id}.down.sql` };
  }
  function stand(teil: Partial<Migrationsstand>): Migrationsstand {
    return { schemaFehlt: false, angewendet: [], ausstehend: [], unbekannt: [], ...teil };
  }

  it('meldet nichts, wenn nichts aussteht', () => {
    expect(ausstehendMeldung(stand({ angewendet: ['0001_init'] }))).toBeUndefined();
  });

  it('nennt bei einer ausstehenden Migration ihren Namen', () => {
    expect(ausstehendMeldung(stand({ ausstehend: [migration('0014_zugang_wiederherstellung')] }))).toBe(
      'Das Schema ist nicht auf dem Stand dieses Images. Migration 0014_zugang_wiederherstellung ausstehend.',
    );
  });

  it('nennt bei mehreren die erste und zählt die übrigen', () => {
    expect(
      ausstehendMeldung(
        stand({ ausstehend: [migration('0012_passkey'), migration('0013_a'), migration('0014_b')] }),
      ),
    ).toBe(
      'Das Schema ist nicht auf dem Stand dieses Images. Migration 0012_passkey ausstehend (und 2 weitere).',
    );
  });

  it('sagt bei fehlendem Schema, dass es fehlt, und beginnt mit der ersten Migration', () => {
    expect(
      ausstehendMeldung(stand({ schemaFehlt: true, ausstehend: [migration('0001_init'), migration('0002_auth')] })),
    ).toBe('Das Schema cockpit fehlt in der Datenbank. Migration 0001_init ausstehend (und 1 weitere).');
  });
});
