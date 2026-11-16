import { describe, expect, it } from 'vitest';
import { passwortHashen, passwortPruefen } from '../src/auth/passwort.js';

describe('Passwort-Hashing', () => {
  it('hasht mit Argon2id (nicht mit dem Better-Auth-Default scrypt)', async () => {
    const hash = await passwortHashen('ein-sehr-langes-passwort');

    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('erzeugt für dasselbe Passwort unterschiedliche Hashes (Salt)', async () => {
    const einer = await passwortHashen('ein-sehr-langes-passwort');
    const anderer = await passwortHashen('ein-sehr-langes-passwort');

    expect(einer).not.toBe(anderer);
  });

  it('bestätigt das richtige Passwort', async () => {
    const hash = await passwortHashen('ein-sehr-langes-passwort');

    expect(await passwortPruefen({ hash, password: 'ein-sehr-langes-passwort' })).toBe(true);
  });

  it('weist ein falsches Passwort ab', async () => {
    const hash = await passwortHashen('ein-sehr-langes-passwort');

    expect(await passwortPruefen({ hash, password: 'falsch' })).toBe(false);
  });

  it('liefert bei kaputtem Hash false statt eines Fehlers', async () => {
    expect(await passwortPruefen({ hash: 'kein-gueltiger-hash', password: 'egal' })).toBe(
      false,
    );
  });
});
