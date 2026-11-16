/**
 * Der neutrale Erweiterungspunkt des Kerns (COPI-193; Entscheidung Stefan, 21.10.2026, COPI-191): ein Modul kann Routen
 * und einen Navigationseintrag anmelden, ohne dass der Kern es kennt. Im Kundenimage ist die Liste leer — dann gibt es
 * weder eine zusätzliche Route noch einen zusätzlichen Hook, und die Navigation ist die von vorher.
 *
 * Der Kern kennt keinen Schalter und kein dynamisches `import()`: die Erweiterungen kommen als Liste über
 * `AppAbhaengigkeiten.erweiterungen` in `buildApp`. Was eine Erweiterung darf, erzwingt dieser Teil:
 *
 *   * **Gekapselt.** Alle Routen hängen in einem eigenen Fastify-Kontext. Seine Haken wirken nur dort; das Tor
 *     (Sitzung und zweiter Faktor, `auth/zwei-faktor-tor.ts`) liegt auf der App und gilt vor allem anderen.
 *   * **Nur lesen.** Erlaubt sind `GET` und `HEAD`. Jede andere Methode, ein Sammelpfad (`*`) und ein Pfad, der auf
 *     `/intern` oder `/pipeline` zeigt (in jeder Schreibweise, auch `/INTERN`, `/%69ntern`), lässt den Start scheitern:
 *     der `onRoute`-Wächter wirft, `app.ready()` schlägt fehl. Die beiden Bereiche lässt das Tor ohne Sitzung durch.
 *   * **Recht.** Jede Route der Erweiterung prüft das geforderte Recht (`hatRecht`); wer es nicht hat, bekommt dieselbe
 *     neutrale 404 wie sonst überall — auch ohne die Navigation zu sehen.
 *   * **Höchstens ein Eintrag je Erweiterung**, der nur Konten zeigt, die das Recht haben (`zugangLesenMitErweiterungen`).
 */
import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify';
import './fastify-render.js';
import { hatRecht, OHNE_ZUGANG, type ErweiterungEintrag, type Recht, type Zugang, type ZugangLesen } from '../auth/berechtigung.js';
import { beruehrtMaschinellenBereich } from '../auth/zwei-faktor-tor.js';
import { nichtGefunden } from './routes/neutral.js';

/** Der Navigationseintrag einer Erweiterung: Text und Ziel (eine `GET`-Route der Erweiterung). */
export interface ErweiterungNavigation {
  readonly text: string;
  readonly href: string;
}

/** Was der Kern dem Plugin als Optionen gibt: den Zugangsleser samt der Einträge, damit die Seite die Navigation baut. */
export interface ErweiterungsKontext {
  readonly zugangLesen: ZugangLesen;
}

export interface Erweiterung {
  /** Kurzname; die Navigation markiert damit den Eintrag. Eindeutig je Instanz. */
  readonly kennung: string;
  /** Das Recht, das jede Route und der Eintrag verlangen. */
  readonly recht: Recht;
  /** Höchstens ein Eintrag. Ohne ihn hat die Erweiterung nur Routen. */
  readonly navigation?: ErweiterungNavigation;
  /** Das Fastify-Plugin mit den Routen. Es bekommt die gekapselte Instanz. */
  readonly plugin: FastifyPluginAsync<ErweiterungsKontext>;
}

/** Ohne Zugangsleser (keine Anmeldung eingerichtet) sieht jede Erweiterungsseite ohnehin nur die neutrale 404. */
const OHNE_ZUGANGSLESER: ZugangLesen = () => Promise.resolve(OHNE_ZUGANG);

const ERLAUBTE_METHODEN: readonly string[] = ['GET', 'HEAD'];

/** Warum diese Route nicht angemeldet werden darf; `undefined`, wenn sie in Ordnung ist. */
export function erweiterungsPfadFehler(url: string): string | undefined {
  if (!url.startsWith('/') || url.startsWith('//')) {
    return 'der Pfad muss mit genau einem „/" beginnen';
  }
  if (url.includes('*')) {
    return 'Sammelrouten (*) sind nicht erlaubt';
  }
  // Ein Parameter im ersten Segment könnte sonst einen Bereich des Kerns überdecken.
  if (url.split('/')[1]?.includes(':') === true) {
    return 'das erste Pfadsegment muss fest sein';
  }
  if (beruehrtMaschinellenBereich(url)) {
    return 'Pfade unter /intern und /pipeline sind den maschinellen Schnittstellen des Kerns vorbehalten';
  }
  return undefined;
}

function methoden(route: RouteOptions): string[] {
  return (Array.isArray(route.method) ? route.method : [route.method]).map((methode) => methode.toUpperCase());
}

/** Der `onRoute`-Wächter: jeder Verstoß wirft und lässt den Start (`app.ready()`) scheitern. */
function routeWaechter(kennung: string): (route: RouteOptions) => void {
  return (route) => {
    const unerlaubt = methoden(route).filter((methode) => !ERLAUBTE_METHODEN.includes(methode));
    if (unerlaubt.length > 0) {
      throw new Error(`Erweiterung „${kennung}": ${unerlaubt.join(', ')} ${route.url} — nur GET und HEAD sind erlaubt`);
    }
    const fehler = erweiterungsPfadFehler(route.url);
    if (fehler !== undefined) {
      throw new Error(`Erweiterung „${kennung}": ${route.url} — ${fehler}`);
    }
  };
}

/** Prüft die Liste, bevor irgendetwas registriert wird: doppelte Kennungen und ein Ziel, das der Wächter abwiese. */
function listePruefen(erweiterungen: readonly Erweiterung[]): void {
  const kennungen = new Set<string>();
  for (const erweiterung of erweiterungen) {
    if (kennungen.has(erweiterung.kennung)) {
      throw new Error(`Erweiterung „${erweiterung.kennung}": die Kennung ist doppelt vergeben`);
    }
    kennungen.add(erweiterung.kennung);
    const fehler = erweiterung.navigation ? erweiterungsPfadFehler(erweiterung.navigation.href) : undefined;
    if (fehler !== undefined) {
      throw new Error(`Erweiterung „${erweiterung.kennung}": Ziel des Eintrags ${erweiterung.navigation?.href ?? ''} — ${fehler}`);
    }
  }
}

/**
 * Hängt die Erweiterungen ein. Ohne Erweiterung passiert nichts. Muss nach dem Tor und nach dem `routenSammler`
 * aufgerufen werden, damit beide auch die Routen der Erweiterungen sehen.
 */
export function registriereErweiterungen(
  app: FastifyInstance,
  erweiterungen: readonly Erweiterung[],
  zugangLesen: ZugangLesen | undefined,
): void {
  if (erweiterungen.length === 0) {
    return;
  }
  // Als Plugin, damit auch ein Fehler in der Liste erst `app.ready()` scheitern lässt, wie der Wächter der Routen.
  void app.register(async () => {
    listePruefen(erweiterungen);
  });
  for (const erweiterung of erweiterungen) {
    void app.register(async (kapsel) => {
      kapsel.addHook('onRoute', routeWaechter(erweiterung.kennung));
      // Nach dem Tor (das auf der App liegt): wer angemeldet ist, aber das Recht nicht hat, sieht die neutrale 404.
      kapsel.addHook('onRequest', async (request, reply) => {
        const zugang = zugangLesen ? await zugangLesen(request) : undefined;
        if (zugang === undefined || !hatRecht(zugang, erweiterung.recht)) {
          await nichtGefunden(kapsel, reply);
        }
      });
      await kapsel.register(erweiterung.plugin, { zugangLesen: zugangLesen ?? OHNE_ZUGANGSLESER });
    });
  }
}

/**
 * Reichert einen `ZugangLesen` um die Einträge der Erweiterungen an, die dieser Zugang sehen darf — wie
 * `zugangLesenMitModulen` für die Module: jede Seite bekommt die richtige Navigation, ohne dass ihre Route davon weiß.
 */
export function zugangLesenMitErweiterungen(lesen: ZugangLesen, erweiterungen: readonly Erweiterung[]): ZugangLesen {
  return async (request) => {
    const zugang = await lesen(request);
    const eintraege = erweiterungen.flatMap((erweiterung): ErweiterungEintrag[] =>
      erweiterung.navigation && hatRecht(zugang, erweiterung.recht)
        ? [{ kennung: erweiterung.kennung, text: erweiterung.navigation.text, href: erweiterung.navigation.href }]
        : [],
    );
    return eintraege.length > 0 ? ({ ...zugang, erweiterungen: eintraege } satisfies Zugang) : zugang;
  };
}
