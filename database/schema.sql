-- ============================================================================
-- CyberGuard AI - PostgreSQL schema
-- Implements the core entities of the dissertation data model (Appendix A):
-- organisations, users/memberships, assets, assessments, evidence, risks,
-- immutable risk versions, controls catalogue, recommendations, actions,
-- action reviews, alerts, AI runs and reports.
--
-- NOTE: at runtime the NestJS backend manages the schema through TypeORM
-- (synchronize mode for the prototype). This file is the reference DDL
-- contract for the model and can be applied manually to a fresh database.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Global identity -----------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenant --------------------------------------------------------------------
CREATE TABLE organisations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    sector          TEXT,
    size            TEXT CHECK (size IN ('small','medium','large')),
    owner_user_id   UUID NOT NULL REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Assets ---------------------------------------------------------------------
CREATE TABLE assets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    name            TEXT NOT NULL,
    asset_type      TEXT NOT NULL,
    criticality     SMALLINT NOT NULL CHECK (criticality BETWEEN 1 AND 5),
    product         TEXT,
    version         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_assets_org ON assets(organisation_id);

-- Assessments ----------------------------------------------------------------
CREATE TABLE assessments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    title           TEXT NOT NULL,
    horizon_months  SMALLINT NOT NULL DEFAULT 12,
    status          TEXT NOT NULL DEFAULT 'draft',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_assessments_org ON assessments(organisation_id);

-- Evidence -------------------------------------------------------------------
CREATE TABLE evidence_documents (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id   UUID NOT NULL REFERENCES organisations(id),
    assessment_id     UUID REFERENCES assessments(id),
    filename          TEXT NOT NULL,
    source_type       TEXT NOT NULL,               -- pdf | docx | csv | txt
    content_hash      TEXT NOT NULL,               -- sha256 of the original bytes
    extracted_text    TEXT,                        -- immutable extracted content
    extraction_status TEXT NOT NULL DEFAULT 'pending',  -- pending|extracted|failed
    evidence_status   TEXT NOT NULL DEFAULT 'reported', -- reported|documented|verified|outdated|awaiting_review
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_evidence_assessment ON evidence_documents(assessment_id);

-- Risks and immutable versions -----------------------------------------------
CREATE TABLE risks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    assessment_id   UUID NOT NULL REFERENCES assessments(id),
    asset_id        UUID REFERENCES assets(id),
    title           TEXT NOT NULL,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'open',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_risks_assessment ON risks(assessment_id);

CREATE TABLE risk_versions (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    risk_id            UUID NOT NULL REFERENCES risks(id),
    version_no         INT NOT NULL,
    likelihood         SMALLINT CHECK (likelihood BETWEEN 1 AND 5),
    impact             SMALLINT CHECK (impact BETWEEN 1 AND 5),
    score              SMALLINT,                    -- likelihood * impact, computed server-side
    band               TEXT,                        -- low|medium|high|critical
    basis              TEXT NOT NULL DEFAULT 'current',  -- current | projected
    rationale          TEXT,
    status             TEXT NOT NULL DEFAULT 'draft',    -- draft | approved
    consequence_review BOOLEAN NOT NULL DEFAULT FALSE,   -- impact = 5 rule (R02)
    approved_by        UUID REFERENCES users(id),
    approved_at        TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (risk_id, version_no)
);

-- Controls catalogue (global, seeded) ----------------------------------------
CREATE TABLE controls (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    control_code    TEXT NOT NULL UNIQUE,            -- e.g. CG-AC-01
    description     TEXT NOT NULL,
    complexity      TEXT NOT NULL,                   -- essential | recommended | advanced
    framework       TEXT NOT NULL,                   -- e.g. "NIST CSF 2.0"
    reference_code  TEXT NOT NULL                    -- e.g. "PR.AA"
);

CREATE TABLE recommendations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    risk_version_id UUID NOT NULL REFERENCES risk_versions(id),
    control_id      UUID NOT NULL REFERENCES controls(id),
    priority        TEXT NOT NULL,                   -- immediate | scheduled | longer_term
    rationale       TEXT,
    status          TEXT NOT NULL DEFAULT 'proposed',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (risk_version_id, control_id)
);

-- Actions and verification ----------------------------------------------------
CREATE TABLE actions (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id    UUID NOT NULL REFERENCES organisations(id),
    title              TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'assigned',
    -- draft|assigned|in_progress|awaiting_verification|verified|returned
    owner_email        TEXT,
    due_at             TIMESTAMPTZ,
    recommendation_ids JSONB NOT NULL DEFAULT '[]',
    submission_note    TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_actions_org ON actions(organisation_id, status);

CREATE TABLE action_reviews (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    action_id       UUID NOT NULL REFERENCES actions(id),
    reviewer_id     UUID NOT NULL REFERENCES users(id),
    decision        TEXT NOT NULL,                   -- verified | returned
    reason          TEXT,
    reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Alerts ----------------------------------------------------------------------
CREATE TABLE alerts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    severity        TEXT NOT NULL,                   -- low|medium|high|critical
    state           TEXT NOT NULL DEFAULT 'open',    -- open|acknowledged|resolved
    message         TEXT NOT NULL,
    source          TEXT NOT NULL,                   -- overdue_action | urgent_risk | consequence_review | evidence_review
    dedup_key       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- one active alert per condition (deduplication rule, FR10)
CREATE UNIQUE INDEX uq_alerts_active ON alerts(organisation_id, dedup_key)
    WHERE state <> 'resolved';

-- AI provenance ---------------------------------------------------------------
CREATE TABLE ai_runs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    assessment_id   UUID REFERENCES assessments(id),
    parent_run_id   UUID REFERENCES ai_runs(id),     -- Claude review points at OpenAI draft
    provider        TEXT NOT NULL,                   -- openai | anthropic
    model           TEXT NOT NULL,
    status          TEXT NOT NULL,                   -- succeeded | failed
    output_json     JSONB,
    error           TEXT,
    usage_json      JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reports ---------------------------------------------------------------------
CREATE TABLE reports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organisation_id UUID NOT NULL REFERENCES organisations(id),
    assessment_id   UUID NOT NULL REFERENCES assessments(id),
    requested_by    UUID NOT NULL REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'generated',
    snapshot_json   JSONB NOT NULL,                  -- frozen deterministic snapshot
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
