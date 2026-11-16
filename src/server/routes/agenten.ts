import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { hatRecht, type ZugangLesen } from '../../auth/berechtigung.js';
import { agentenLesen } from '../../status/agenten-speicher.js';
import type { AgentZeile } from '../../status/agenten-speicher.js';
import { agentenAnsicht, zeitplanAnsicht, type AgentenSicht } from '../../status/agenten.js';
import { navigationFuerZugang, type NavSeite } from '../navigation.js';

export interface AgentenSeitenAbhaengigkeiten {
  /** Ohne Datenbank zeigen die Seiten den Leerzustand (Tests und Entwicklung ohne Datenbank). */
  readonly pool?: pg.Pool;
  /** Ohne Zugangsleser (keine Anmeldung eingerichtet) gilt die Kundensicht. */
  readonly zugangLesen?: ZugangLesen;
  readonly jetzt: () => Date;
}

interface Seite {
  readonly pfad: string;
  readonly nav: NavSeite;
  readonly vorlage: string;
  readonly titel: string;
  /** Die Daten der Vorlage aus dem Inventar. */
  readonly daten: (zeilen: readonly AgentZeile[], sicht: AgentenSicht, jetzt: Date) => Record<string, unknown>;
}

const SEITEN: readonly Seite[] = [
  {
    pfad: '/agenten',
    nav: 'agenten',
    vorlage: 'agenten.eta',
    titel: 'Agenten',
    daten: (zeilen, sicht, jetzt) => ({ agenten: agentenAnsicht(zeilen, sicht, jetzt) }),
  },
  {
    pfad: '/zeitplan',
    nav: 'zeitplan',
    vorlage: 'zeitplan.eta',
    titel: 'Zeitplan',
    daten: (zeilen, _sicht, jetzt) => ({ zeitplan: zeitplanAnsicht(zeilen, jetzt) }),
  },
];

/**
 * Die Seiten **Agenten** (Rolle, Grenzen, Version) und **Zeitplan** (alle Takte), beide nur lesend
 * (COPI-38, Architektur-Vorschlag Abschnitt 5). Sie zeigen, was der Admin-Agent per `PUT /intern/agenten`
 * gemeldet hat; das Cockpit liest nie YAML und rechnet nichts aus dem Zeitplan.
 *
 * **Zwei Sichten auf dasselbe Inventar.** Jedes angemeldete Konto sieht Rolle, Grenzen und Zeitplan; **Kennung und
 * Version sieht nur, wer das Recht `technik_sehen` hat** (der Betreuer). Der Unterschied liegt in der Form der
 * Daten (`agenten.ts`), nicht in der Vorlage: die Karte der Kundensicht hat kein Feld dafür. Ein Konto mit
 * unbekannter Rolle bekommt die Kundensicht — im Zweifel sieht es weniger.
 *
 * Die Rolle kommt aus der Datenbank (`zugangLesen`), nicht aus der Sitzung: eine Herabstufung wirkt sofort. Die
 * Seiten sind rollenabhängig und deshalb `no-store`.
 */
export function registerAgentenRoutes(app: FastifyInstance, abhaengigkeiten: AgentenSeitenAbhaengigkeiten): void {
  const { pool, zugangLesen, jetzt } = abhaengigkeiten;

  for (const seite of SEITEN) {
    app.get(seite.pfad, async (request, reply) => {
      const zugang = zugangLesen ? await zugangLesen(request) : undefined;
      const sicht: AgentenSicht = zugang && hatRecht(zugang, 'technik_sehen') ? 'betreuer' : 'kunde';
      const zeilen = pool ? await agentenLesen(pool) : [];

      const html = await app.render(seite.vorlage, {
        titel: seite.titel,
        sicht,
        nav: navigationFuerZugang(seite.nav, zugang),
        ...seite.daten(zeilen, sicht, jetzt()),
      });
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
    });
  }
}
