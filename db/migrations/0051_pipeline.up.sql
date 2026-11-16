-- COPI-145 (JAC-757, Epic JAC-732): die Job-Queue der autonomen Entwicklungspipeline (Confluence TEAM 127172609,
-- Abschnitt 3). Koordinator (n8n) legt Jobs an, der Runner auf dem Mini-PC holt sie per Lease, meldet Ereignisse und schließt ab.
--
-- **Im Schema `cockpit`, mit Präfix `pipeline_`,** nicht in einem eigenen Schema `pipeline`, wie das Konzept es skizziert:
-- die Rolle `cockpit` darf bewusst keine Schemas anlegen (0001, COPI-66), und die ADR sieht genau ein Schema vor. Die
-- Spaltennamen folgen dem Konzept (englisch), damit Konzept, API und Tabelle dieselben Wörter benutzen.
--
-- Nie löschen (0025): jede Tabelle weist `DELETE` ab. Ereignisse und Verbrauch sind nach dem Schreiben unveränderlich —
-- „append-only" gilt hier per Trigger, weil es keine eigene Rolle der Anwendung gibt, der man `UPDATE` entziehen könnte.

-- Je Repo, das die Pipeline bearbeitet: Herkunft der Aufgaben (Jira oder GitHub Issues, Stefan 16.10.2026), Basis-Branch,
-- Phase und Schalter. Pflegt nur Stefan (Server-Kommando `pipeline-repo`).
CREATE TABLE "cockpit"."pipeline_repo_config" (
    repo            text        PRIMARY KEY,
    quelle          text        NOT NULL,
    jira_project    text,
    base_branch     text        NOT NULL DEFAULT 'main',
    auto_merge      boolean     NOT NULL DEFAULT false,
    phase           smallint    NOT NULL DEFAULT 0,
    reviewers       text[]      NOT NULL DEFAULT ARRAY['codex']::text[],
    protected_paths text[]      NOT NULL DEFAULT ARRAY[]::text[],
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_repo_form CHECK (repo ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
    CONSTRAINT pipeline_repo_quelle CHECK (quelle IN ('jira', 'github')),
    CONSTRAINT pipeline_repo_jira_project CHECK (
        (quelle = 'jira' AND jira_project ~ '^[A-Z][A-Z0-9]{1,19}$')
        OR (quelle = 'github' AND (jira_project IS NULL OR jira_project ~ '^[A-Z][A-Z0-9]{1,19}$'))
    ),
    CONSTRAINT pipeline_repo_base_branch CHECK (base_branch ~ '^[A-Za-z0-9._/-]{1,100}$'),
    CONSTRAINT pipeline_repo_phase CHECK (phase BETWEEN 0 AND 2),
    CONSTRAINT pipeline_repo_reviewers CHECK (reviewers <@ ARRAY['codex', 'gemini', 'copilot']::text[])
);

CREATE TABLE "cockpit"."pipeline_job" (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_key   text        NOT NULL,
    repo         text        NOT NULL REFERENCES "cockpit"."pipeline_repo_config" ("repo"),
    kind         text        NOT NULL,
    -- Wer die Arbeit macht: Umsetzung und Nacharbeit Claude, ein Review der genannte Reviewer.
    provider     text        GENERATED ALWAYS AS (
        CASE WHEN kind IN ('implement', 'rework') THEN 'claude' ELSE substr(kind, 8) END
    ) STORED,
    status       text        NOT NULL DEFAULT 'queued',
    priority     smallint    NOT NULL DEFAULT 3,
    due_date     date,
    attempt      integer     NOT NULL DEFAULT 0,
    max_attempts integer     NOT NULL DEFAULT 2,
    lease_owner  text,
    lease_until  timestamptz,
    payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    result       jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_job_ticket_key CHECK (char_length(ticket_key) BETWEEN 1 AND 200),
    CONSTRAINT pipeline_job_kind CHECK (kind IN ('implement', 'rework', 'review:codex', 'review:gemini', 'review:copilot')),
    CONSTRAINT pipeline_job_status CHECK (status IN ('queued', 'leased', 'done', 'failed', 'parked')),
    CONSTRAINT pipeline_job_priority CHECK (priority BETWEEN 1 AND 5),
    CONSTRAINT pipeline_job_attempt CHECK (attempt >= 0 AND max_attempts BETWEEN 0 AND 10),
    CONSTRAINT pipeline_job_lease CHECK (
        (status = 'leased') = (lease_until IS NOT NULL) AND (status <> 'leased' OR lease_owner IS NOT NULL)
    ),
    CONSTRAINT pipeline_job_payload CHECK (jsonb_typeof(payload) = 'object')
);

-- Höchstens ein Umsetzungsjob je Repo gleichzeitig (Merge-Konflikte, Baselines, Migrationen) — die Auswahl beim `claim`
-- beachtet das, der Index hält es auch gegen einen Fehler darin fest.
CREATE UNIQUE INDEX "pipeline_job_umsetzung_je_repo" ON "cockpit"."pipeline_job" (repo)
    WHERE status = 'leased' AND kind IN ('implement', 'rework');
-- Koordinator legt denselben Job nicht doppelt an, solange einer offen ist (Polling alle fünf Minuten).
CREATE UNIQUE INDEX "pipeline_job_offen_einmal" ON "cockpit"."pipeline_job" (ticket_key, kind)
    WHERE status IN ('queued', 'leased');
CREATE INDEX "pipeline_job_wartend" ON "cockpit"."pipeline_job" (status, due_date, priority, created_at);
CREATE INDEX "pipeline_job_lease" ON "cockpit"."pipeline_job" (lease_until) WHERE status = 'leased';

CREATE TRIGGER "pipeline_job_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_job"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "pipeline_repo_config_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_repo_config"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Das Audit: jede Statusänderung (vom Cockpit, ohne `event_id`) und jede Meldung des Runners (mit `event_id`, die eine
-- doppelt gesendete Meldung abfängt).
CREATE TABLE "cockpit"."pipeline_job_event" (
    id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id   uuid        NOT NULL REFERENCES "cockpit"."pipeline_job" ("id"),
    event_id uuid        UNIQUE,
    runner   text,
    ts       timestamptz NOT NULL DEFAULT now(),
    type     text        NOT NULL,
    data     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT pipeline_job_event_type CHECK (type ~ '^[a-z][a-z0-9_.]{0,62}$'),
    CONSTRAINT pipeline_job_event_data CHECK (jsonb_typeof(data) = 'object')
);

CREATE INDEX "pipeline_job_event_job" ON "cockpit"."pipeline_job_event" (job_id, id);

-- Ein Lauf eines Werkzeugs (Konzept Abschnitt 9): Tokens, rechnerische Kosten zum API-Listenpreis, reale nur beim
-- API-Fallback.
CREATE TABLE "cockpit"."pipeline_usage" (
    id                bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id            uuid          NOT NULL REFERENCES "cockpit"."pipeline_job" ("id"),
    ticket_key        text          NOT NULL,
    tool              text          NOT NULL,
    model             text,
    billing           text          NOT NULL,
    input_tokens      bigint        NOT NULL DEFAULT 0,
    output_tokens     bigint        NOT NULL DEFAULT 0,
    cache_tokens      bigint        NOT NULL DEFAULT 0,
    cost_eur_notional numeric(12,6),
    cost_eur_real     numeric(12,6),
    duration_s        integer,
    created_at        timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_usage_tool CHECK (tool ~ '^[a-z][a-z0-9_.-]{0,39}$'),
    CONSTRAINT pipeline_usage_model CHECK (model IS NULL OR char_length(model) BETWEEN 1 AND 100),
    CONSTRAINT pipeline_usage_billing CHECK (billing IN ('abo', 'api')),
    CONSTRAINT pipeline_usage_zahlen CHECK (
        input_tokens >= 0 AND output_tokens >= 0 AND cache_tokens >= 0
        AND (cost_eur_notional IS NULL OR cost_eur_notional >= 0)
        AND (cost_eur_real IS NULL OR cost_eur_real >= 0)
        AND (duration_s IS NULL OR duration_s >= 0)
    )
);

CREATE INDEX "pipeline_usage_ticket" ON "cockpit"."pipeline_usage" (ticket_key);

CREATE FUNCTION "cockpit"."pipeline_unveraenderlich"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'pipeline_unveraenderlich: % wird nur angehaengt, nie geaendert', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "pipeline_job_event_unveraenderlich" BEFORE UPDATE ON "cockpit"."pipeline_job_event"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."pipeline_unveraenderlich"();
CREATE TRIGGER "pipeline_job_event_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_job_event"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();
CREATE TRIGGER "pipeline_usage_unveraenderlich" BEFORE UPDATE ON "cockpit"."pipeline_usage"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."pipeline_unveraenderlich"();
CREATE TRIGGER "pipeline_usage_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_usage"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Ist ein Abo erschöpft, vergibt `claim` keine Jobs dieses Anbieters, bis `until` vorbei ist (ohne `until`: bis es
-- jemand zurücksetzt). `disabled` schaltet ihn ab.
CREATE TABLE "cockpit"."pipeline_provider_state" (
    provider   text        PRIMARY KEY,
    state      text        NOT NULL,
    until      timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT pipeline_provider_form CHECK (provider IN ('claude', 'codex', 'gemini', 'copilot')),
    CONSTRAINT pipeline_provider_state CHECK (state IN ('ok', 'exhausted', 'disabled'))
);

CREATE TRIGGER "pipeline_provider_state_nie_loeschen" BEFORE DELETE ON "cockpit"."pipeline_provider_state"
    FOR EACH ROW EXECUTE FUNCTION "cockpit"."nie_loeschen"();

-- Das Recht für Koordinator (n8n): Jobs anlegen, lesen und abgelaufene Leases aufräumen (Regel aus 0016: ein neues Recht kommt
-- mit dem Ticket, das es braucht). In einem Befehl ersetzt, damit die Bedingung nie fehlt.
ALTER TABLE "cockpit"."api_token"
    DROP CONSTRAINT "api_token_scopes_bekannt",
    ADD CONSTRAINT "api_token_scopes_bekannt" CHECK (
        cardinality(scopes) > 0
        AND scopes <@ ARRAY['befund_schreiben', 'agenten_schreiben', 'eingriff_verwalten', 'chat_antworten', 'zustand_lesen', 'vorgang_lesen', 'verbrauch_schreiben', 'verbrauch_lesen', 'pipeline_verwalten']::text[]
    );
