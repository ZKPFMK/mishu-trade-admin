CREATE INDEX cases_worklist ON cases(application_id,updated_at DESC,id DESC);
CREATE INDEX cases_owner_worklist ON cases(application_id,owner_id,state,updated_at DESC,id DESC);
CREATE INDEX findings_open_worklist ON reconciliation_findings(application_id,state,updated_at DESC,id DESC);
CREATE INDEX operation_worklist ON operation_requests(application_id,state,updated_at DESC,id DESC);
CREATE INDEX management_worklist ON management_requests(application_id,state,updated_at DESC,id DESC);
