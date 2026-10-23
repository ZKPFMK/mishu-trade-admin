ALTER TABLE applications ADD COLUMN management_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN adjustment_limit bigint NOT NULL DEFAULT 1000 CHECK(adjustment_limit>0);
CREATE TABLE operator_mfa (
 operator_id text PRIMARY KEY REFERENCES operators(id), secret text, pending_secret text, pending_until timestamptz,
 last_counter bigint NOT NULL DEFAULT -1, recovery_hashes text[] NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE security_failures (operator_id text PRIMARY KEY REFERENCES operators(id), failures int NOT NULL DEFAULT 0, locked_until timestamptz);
CREATE TABLE management_requests (
 id text PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), case_id text NOT NULL REFERENCES cases(id),
 target_id text NOT NULL, type text NOT NULL, requester_id text NOT NULL REFERENCES operators(id), approver_id text REFERENCES operators(id),
 idempotency_key text NOT NULL, intent jsonb NOT NULL, digest text NOT NULL, preview jsonb NOT NULL, source_command jsonb,
 requester_security text NOT NULL, approver_security text, requester_mfa boolean NOT NULL, approver_mfa boolean,
 state text NOT NULL DEFAULT 'pending_approval' CHECK(state IN ('pending_approval','approved','executing','execution_unknown','succeeded','execution_failed','rejected','canceled','expired')),
 decision_reason text, receipt jsonb, error text, attempts int NOT NULL DEFAULT 0, dispatched_at timestamptz,
 request_expires_at timestamptz NOT NULL, approval_expires_at timestamptz,
 lease_token text, lease_until timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(requester_id,idempotency_key), CHECK(approver_id IS NULL OR approver_id<>requester_id)
);
CREATE UNIQUE INDEX management_active ON management_requests(application_id,target_id)
 WHERE state IN ('pending_approval','approved','executing','execution_unknown');
CREATE INDEX management_poll ON management_requests(state,next_attempt_at);
CREATE TABLE management_attempts (
 id bigserial PRIMARY KEY, request_id text NOT NULL REFERENCES management_requests(id), action text NOT NULL, result text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE cases ADD COLUMN resolution text;
