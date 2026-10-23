CREATE TABLE applications (
 id text PRIMARY KEY, name text NOT NULL, environment text NOT NULL CHECK(environment IN ('test','production')),
 source_mode text NOT NULL CHECK(source_mode IN ('mock','mishu')), enabled boolean NOT NULL DEFAULT true,
 initialized boolean NOT NULL DEFAULT false, applied_cursor text, received_cursor text,
 last_applied_at timestamptz, last_poll_at timestamptz, source_error text,
 refund_limit bigint NOT NULL DEFAULT 100000, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(name,environment), CHECK(source_mode <> 'mock' OR environment = 'test')
);
CREATE TABLE service_credentials (id text PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), label text NOT NULL, secret_hash text NOT NULL UNIQUE, permissions text[] NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE operators (id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL, roles text[] NOT NULL, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE operator_scopes (operator_id text REFERENCES operators(id), application_id text REFERENCES applications(id), PRIMARY KEY(operator_id,application_id));
CREATE TABLE sessions (token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id), csrf text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE event_inbox (seq bigserial PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), event_id text NOT NULL, source_cursor text NOT NULL, previous_cursor text, digest text NOT NULL, body jsonb NOT NULL, state text NOT NULL DEFAULT 'received' CHECK(state IN ('received','applied','blocked','quarantined')), attempts int NOT NULL DEFAULT 0, error text, received_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz, UNIQUE(application_id,event_id), UNIQUE(application_id,source_cursor));
CREATE INDEX inbox_pending ON event_inbox(application_id,state,seq);
CREATE TABLE event_conflicts (id bigserial PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), event_id text NOT NULL, original_digest text NOT NULL, incoming_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE trade_projections (application_id text REFERENCES applications(id), id text NOT NULL, version bigint NOT NULL, status text NOT NULL, buyer_id text NOT NULL, seller_id text NOT NULL, asset_id text NOT NULL, price bigint NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, document jsonb NOT NULL, PRIMARY KEY(application_id,id));
CREATE INDEX trade_order ON trade_projections(application_id,created_at DESC,id DESC);
CREATE INDEX trade_status ON trade_projections(application_id,status,created_at DESC,id DESC);
CREATE INDEX trade_buyer ON trade_projections(application_id,buyer_id,created_at DESC);
CREATE INDEX trade_seller ON trade_projections(application_id,seller_id,created_at DESC);
CREATE TABLE account_projections (application_id text REFERENCES applications(id), id text NOT NULL, version bigint NOT NULL, owner_id text, kind text NOT NULL, balance bigint NOT NULL, opening_balance bigint NOT NULL, document jsonb NOT NULL, PRIMARY KEY(application_id,id));
CREATE TABLE journal_transactions (application_id text REFERENCES applications(id), id text NOT NULL, kind text NOT NULL, reference_id text NOT NULL, occurred_at timestamptz NOT NULL, digest text NOT NULL, document jsonb NOT NULL, PRIMARY KEY(application_id,id));
CREATE INDEX journal_order ON journal_transactions(application_id,occurred_at DESC,id DESC);
CREATE INDEX journal_reference ON journal_transactions(application_id,reference_id);
CREATE TABLE journal_entries (application_id text NOT NULL, id text NOT NULL, transaction_id text NOT NULL, account_id text NOT NULL, amount bigint NOT NULL, role text NOT NULL, PRIMARY KEY(application_id,id), FOREIGN KEY(application_id,transaction_id) REFERENCES journal_transactions(application_id,id), FOREIGN KEY(application_id,account_id) REFERENCES account_projections(application_id,id));
CREATE INDEX entries_transaction ON journal_entries(application_id,transaction_id);
CREATE INDEX entries_account ON journal_entries(application_id,account_id);
CREATE TABLE job_charge_summaries (application_id text REFERENCES applications(id), id text NOT NULL, version bigint NOT NULL, document jsonb NOT NULL, PRIMARY KEY(application_id,id));
CREATE TABLE operation_requests (id text PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), trade_id text NOT NULL, requester_id text NOT NULL REFERENCES operators(id), idempotency_key text NOT NULL, command jsonb NOT NULL, digest text NOT NULL, state text NOT NULL DEFAULT 'pending_approval', reason text NOT NULL, approver_id text REFERENCES operators(id), approval_digest text, approval_expires_at timestamptz, decision_reason text, receipt jsonb, error text, attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(requester_id,idempotency_key));
CREATE UNIQUE INDEX operation_active ON operation_requests(application_id,trade_id) WHERE state IN ('pending_approval','approved','executing','execution_unknown');
CREATE TABLE command_attempts (id bigserial PRIMARY KEY, operation_id text NOT NULL REFERENCES operation_requests(id), action text NOT NULL, result text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE cases (id text PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), trade_id text, title text NOT NULL, state text NOT NULL DEFAULT 'open', owner_id text REFERENCES operators(id), created_by text NOT NULL REFERENCES operators(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE case_notes (id bigserial PRIMARY KEY, case_id text REFERENCES cases(id), actor_id text REFERENCES operators(id), note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs (id text PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), owner_id text REFERENCES operators(id), kind text NOT NULL CHECK(kind IN ('import','reconcile','export')), state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','succeeded','failed','canceled','expired')), payload jsonb NOT NULL DEFAULT '{}', result jsonb, progress bigint NOT NULL DEFAULT 0, error text, attempts int NOT NULL DEFAULT 0, lease_token text, lease_until timestamptz, cancel_requested boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz);
CREATE INDEX jobs_claim ON jobs(kind,state,created_at);
CREATE TABLE reconciliation_findings (id text PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), rule text NOT NULL, object_id text NOT NULL, state text NOT NULL DEFAULT 'open', detail jsonb NOT NULL, first_run text NOT NULL REFERENCES jobs(id), last_run text NOT NULL REFERENCES jobs(id), resolution_note text, owner_id text REFERENCES operators(id), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(application_id,rule,object_id));
CREATE TABLE reconciliation_observations (run_id text REFERENCES jobs(id), finding_id text REFERENCES reconciliation_findings(id), detail jsonb NOT NULL, PRIMARY KEY(run_id,finding_id));
CREATE TABLE audit_events (seq bigserial PRIMARY KEY, application_id text REFERENCES applications(id), actor_id text, action text NOT NULL, object_id text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_app ON audit_events(application_id,seq DESC);
CREATE TABLE mock_sources (application_id text PRIMARY KEY REFERENCES applications(id), cursor text, bundle jsonb NOT NULL);
CREATE TABLE mock_events (seq bigserial PRIMARY KEY, application_id text NOT NULL REFERENCES applications(id), event_id text NOT NULL, body jsonb NOT NULL, UNIQUE(application_id,event_id));
CREATE TABLE mock_commands (application_id text REFERENCES applications(id), command_id text NOT NULL, digest text NOT NULL, receipt jsonb NOT NULL, PRIMARY KEY(application_id,command_id));
