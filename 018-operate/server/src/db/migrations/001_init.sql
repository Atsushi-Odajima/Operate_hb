-- Operate schema v1
-- All business tables carry org_id and are protected by ROW LEVEL SECURITY.
-- The application connects as a non-owner role (operate_app, NOBYPASSRLS) and sets app.org_id per transaction.
-- The owner role (migrations / backup / SECURITY DEFINER lookups) is not subject to RLS and filters by org_id explicitly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION app_org() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------- organization
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, code)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  is_external boolean NOT NULL DEFAULT false,
  external_expires_at timestamptz,
  external_allow_download boolean NOT NULL DEFAULT false,
  external_allow_ai boolean NOT NULL DEFAULT false,
  hire_date date,
  anonymized_at timestamptz,
  failed_logins int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_org_email ON users (org_id, lower(email));

CREATE TABLE user_roles (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','knowledge_admin','approver','editor','trainer','member','auditor','external')),
  PRIMARY KEY (user_id, role)
);
CREATE INDEX user_roles_org ON user_roles (org_id, role);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  UNIQUE (user_id, department_id, team_id)
);
CREATE INDEX memberships_org_user ON memberships (org_id, user_id);
CREATE INDEX memberships_dept ON memberships (department_id);

-- Approver scope: which departments an approver may approve for (NULL department = whole org)
CREATE TABLE approver_scopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX approver_scopes_uq ON approver_scopes (user_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE sessions (
  id text PRIMARY KEY,               -- sha256(token)
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions (user_id);

-- ---------------------------------------------------------------- documents
CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  doc_type text NOT NULL,
  content jsonb NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  doc_number text,
  type text NOT NULL CHECK (type IN ('sop','policy','guide','faq','checklist','template','reference')),
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT '',
  scope text NOT NULL DEFAULT '',
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  classification text NOT NULL DEFAULT 'internal' CHECK (classification IN ('public_internal','internal','confidential','restricted')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','changes_requested','approved','scheduled','published','superseded','archived','retired')),
  current_version_id uuid,
  audience_all boolean NOT NULL DEFAULT false,
  requires_attestation boolean NOT NULL DEFAULT false,
  review_cycle_days int CHECK (review_cycle_days IS NULL OR review_cycle_days BETWEEN 1 AND 3650),
  next_review_date date,
  last_reviewed_at timestamptz,
  effective_date date,
  retire_date date,
  retired_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX documents_number ON documents (org_id, doc_number) WHERE doc_number IS NOT NULL;
CREATE INDEX documents_org_status ON documents (org_id, status);
CREATE INDEX documents_org_dept ON documents (org_id, department_id);
CREATE INDEX documents_review ON documents (org_id, next_review_date) WHERE status = 'published';

CREATE TABLE document_audiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('department','team','role','user')),
  target text NOT NULL,
  UNIQUE (document_id, kind, target)
);
CREATE INDEX document_audiences_target ON document_audiences (org_id, kind, target);

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  major int NOT NULL,
  minor int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','in_review','changes_requested','pending_approval','approved','scheduled','published','superseded','rejected','withdrawn')),
  change_type text NOT NULL DEFAULT 'normal' CHECK (change_type IN ('minor','normal','major')),
  change_summary text NOT NULL DEFAULT '',
  title text NOT NULL,
  content jsonb NOT NULL,
  body_text text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  ai_generated boolean NOT NULL DEFAULT false,
  require_reattestation boolean NOT NULL DEFAULT false,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  based_on_version_id uuid REFERENCES document_versions(id) ON DELETE SET NULL,
  review_round int NOT NULL DEFAULT 0,
  edit_seq int NOT NULL DEFAULT 1,
  publish_mode text NOT NULL DEFAULT 'immediate' CHECK (publish_mode IN ('immediate','scheduled','manual')),
  scheduled_publish_at timestamptz,
  effective_date date,
  submitted_at timestamptz,
  approved_at timestamptz,
  published_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, major, minor)
);
CREATE INDEX document_versions_doc ON document_versions (document_id, created_at DESC);
CREATE INDEX document_versions_org_status ON document_versions (org_id, status);
ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk FOREIGN KEY (current_version_id) REFERENCES document_versions(id) DEFERRABLE INITIALLY DEFERRED;
-- only one working (non-final) version per document
CREATE UNIQUE INDEX document_versions_one_working ON document_versions (document_id)
  WHERE status IN ('draft','in_review','changes_requested','pending_approval','approved','scheduled');

-- Immutability: content may change only while draft / changes_requested; published history is never rewritten.
CREATE OR REPLACE FUNCTION protect_version_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('draft','changes_requested') AND
     (NEW.content IS DISTINCT FROM OLD.content OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.body_text IS DISTINCT FROM OLD.body_text
      OR NEW.major IS DISTINCT FROM OLD.major OR NEW.minor IS DISTINCT FROM OLD.minor) THEN
    RAISE EXCEPTION 'version % is locked (status=%)', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('published','superseded','rejected','withdrawn') AND NEW.status NOT IN ('published','superseded','rejected','withdrawn') THEN
    RAISE EXCEPTION 'version % cannot go back from %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_versions_protect BEFORE UPDATE ON document_versions FOR EACH ROW EXECUTE FUNCTION protect_version_content();

CREATE OR REPLACE FUNCTION forbid_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.allow_purge', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER document_versions_nodelete BEFORE DELETE ON document_versions FOR EACH ROW
  WHEN (OLD.status IN ('published','superseded')) EXECUTE FUNCTION forbid_delete();

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'attachment' CHECK (kind IN ('image','attachment','import_source')),
  filename text NOT NULL,
  mime text NOT NULL,
  size int NOT NULL,
  sha256 text NOT NULL,
  data bytea NOT NULL,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_doc ON attachments (document_id);

-- ---------------------------------------------------------------- review / approval
CREATE TABLE review_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  round int NOT NULL,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','changes_requested','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (version_id, round)
);

CREATE TABLE review_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  review_id uuid NOT NULL REFERENCES review_requests(id) ON DELETE CASCADE,
  reviewer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes_requested')),
  comment text NOT NULL DEFAULT '',
  decided_at timestamptz,
  UNIQUE (review_id, reviewer_id)
);
CREATE INDEX review_assignments_reviewer ON review_assignments (org_id, reviewer_id, status);

CREATE TABLE review_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  content_hash text NOT NULL,
  round int NOT NULL,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  section text NOT NULL DEFAULT '',
  body text NOT NULL,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_comments_version ON review_comments (version_id);

CREATE TABLE approval_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  round int NOT NULL,
  step_no int NOT NULL CHECK (step_no BETWEEN 1 AND 3),
  mode text NOT NULL DEFAULT 'any' CHECK (mode IN ('any','all')),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','active','approved','rejected','changes_requested','cancelled')),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE (version_id, round, step_no)
);

CREATE TABLE approval_step_approvers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES approval_steps(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  reassigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  reassigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reassigned_at timestamptz,
  reassign_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approval_step_approvers_active ON approval_step_approvers (step_id, approver_id) WHERE active;
CREATE INDEX approval_step_approvers_user ON approval_step_approvers (org_id, approver_id) WHERE active;

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  step_id uuid NOT NULL REFERENCES approval_steps(id) ON DELETE CASCADE,
  approver_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected','changes_requested')),
  comment text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_id, approver_id)
);
CREATE INDEX approvals_version ON approvals (version_id);

-- ---------------------------------------------------------------- relations / feedback / improvement
CREATE TABLE document_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  to_document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('related','dependsOn','replaces','derivedFrom')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_document_id <> to_document_id),
  UNIQUE (from_document_id, to_document_id, kind)
);
CREATE INDEX document_relations_to ON document_relations (to_document_id);

CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('helpful','outdated','unclear','suggestion')),
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolution text NOT NULL DEFAULT '',
  handled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_doc ON feedback (org_id, document_id, status);

CREATE TABLE improvement_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','dismissed')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- checklist runs
CREATE TABLE checklist_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  client_key text,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','abandoned')),
  items jsonb NOT NULL,
  notes text NOT NULL DEFAULT '',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (org_id, client_key)
);
CREATE INDEX checklist_runs_doc ON checklist_runs (org_id, document_id, started_at DESC);

-- ---------------------------------------------------------------- attestation
CREATE TABLE attestation_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  due_date date,
  reason text NOT NULL DEFAULT '',
  require_scroll boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id)
);

CREATE TABLE user_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES attestation_campaigns(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acknowledged','waived','cancelled')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  due_date date,
  viewed_at timestamptz,
  reached_end_at timestamptz,
  acknowledged_at timestamptz,
  waived_by uuid REFERENCES users(id) ON DELETE SET NULL,
  waived_reason text,
  UNIQUE (campaign_id, user_id)
);
CREATE INDEX user_attestations_user ON user_attestations (org_id, user_id, status);
CREATE INDEX user_attestations_version ON user_attestations (version_id, status);

-- ---------------------------------------------------------------- training
CREATE TABLE quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  current_version_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quiz_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (quiz_id, version_no)
);
ALTER TABLE quizzes ADD CONSTRAINT quizzes_current_fk FOREIGN KEY (current_version_id) REFERENCES quiz_versions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX quiz_versions_one_draft ON quiz_versions (quiz_id) WHERE status = 'draft';

CREATE OR REPLACE FUNCTION protect_quiz_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.questions IS DISTINCT FROM OLD.questions OR NEW.settings IS DISTINCT FROM OLD.settings) THEN
    RAISE EXCEPTION 'quiz version % is locked', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quiz_versions_protect BEFORE UPDATE ON quiz_versions FOR EACH ROW EXECUTE FUNCTION protect_quiz_version();

CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  current_version_id uuid,
  due_days int CHECK (due_days IS NULL OR due_days BETWEEN 1 AND 730),
  validity_days int CHECK (validity_days IS NULL OR validity_days BETWEEN 1 AND 3650),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE course_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version_no int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
  modules jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_policy text NOT NULL DEFAULT 'keep' CHECK (completion_policy IN ('keep','reassign')),
  sequential boolean NOT NULL DEFAULT true,
  change_note text NOT NULL DEFAULT '',
  published_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, version_no)
);
ALTER TABLE courses ADD CONSTRAINT courses_current_fk FOREIGN KEY (current_version_id) REFERENCES course_versions(id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX course_versions_one_draft ON course_versions (course_id) WHERE status = 'draft';

CREATE OR REPLACE FUNCTION protect_course_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.modules IS DISTINCT FROM OLD.modules OR NEW.sequential IS DISTINCT FROM OLD.sequential) THEN
    RAISE EXCEPTION 'course version % is locked', OLD.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER course_versions_protect BEFORE UPDATE ON course_versions FOR EACH ROW EXECUTE FUNCTION protect_course_version();

CREATE TABLE training_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','department','team','role','onboarding','reassign')),
  source_ref text,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  due_date date,
  started_at timestamptz,
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','completed','waived','cancelled')),
  waived_by uuid REFERENCES users(id) ON DELETE SET NULL,
  waived_reason text,
  waived_at timestamptz,
  UNIQUE (course_version_id, user_id)
);
CREATE INDEX training_assignments_user ON training_assignments (org_id, user_id, status);
CREATE INDEX training_assignments_course ON training_assignments (org_id, course_id, status);
CREATE INDEX training_assignments_due ON training_assignments (org_id, due_date) WHERE status IN ('not_started','in_progress');

CREATE TABLE module_progress (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES training_assignments(id) ON DELETE CASCADE,
  module_id text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (assignment_id, module_id)
);

CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  quiz_version_id uuid NOT NULL REFERENCES quiz_versions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES training_assignments(id) ON DELETE SET NULL,
  module_id text,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','pending_review')),
  question_order jsonb NOT NULL,
  answers jsonb,
  score numeric,
  max_score numeric,
  result text CHECK (result IN ('pass','fail','pending')),
  graded_detail jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz
);
CREATE INDEX quiz_attempts_user ON quiz_attempts (org_id, user_id, quiz_id, started_at DESC);

CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  course_version_id uuid NOT NULL REFERENCES course_versions(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES training_assignments(id) ON DELETE CASCADE UNIQUE,
  completed_at timestamptz NOT NULL,
  score_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  verification_code text NOT NULL,
  signature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text,
  department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES onboarding_templates(id) ON DELETE CASCADE,
  template_snapshot jsonb NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date date NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, user_id)
);

-- ---------------------------------------------------------------- search & AI
CREATE TABLE search_index (
  document_id uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text NOT NULL,
  body_text text NOT NULL,
  tags text NOT NULL,
  category text NOT NULL,
  doc_number text NOT NULL DEFAULT '',
  owner_name text NOT NULL DEFAULT '',
  related_titles text NOT NULL DEFAULT '',
  search_text text NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_index_org ON search_index (org_id);
CREATE INDEX search_index_trgm ON search_index USING gin (search_text gin_trgm_ops);
CREATE INDEX search_index_title_trgm ON search_index USING gin (title gin_trgm_ops);

CREATE TABLE knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  is_current boolean NOT NULL DEFAULT true,
  ordinal int NOT NULL,
  section text NOT NULL,
  text text NOT NULL,
  text_hash text NOT NULL,
  embedding vector(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, ordinal)
);
CREATE INDEX knowledge_chunks_org_current ON knowledge_chunks (org_id, is_current);
CREATE INDEX knowledge_chunks_doc ON knowledge_chunks (document_id);
CREATE INDEX knowledge_chunks_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX knowledge_chunks_text_trgm ON knowledge_chunks USING gin (text gin_trgm_ops);

CREATE TABLE embedding_cache (
  text_hash text NOT NULL,
  model text NOT NULL,
  embedding vector(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_hash, model)
);

CREATE TABLE search_queries (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  query text NOT NULL,
  mode text NOT NULL DEFAULT 'keyword' CHECK (mode IN ('keyword','ai')),
  result_count int NOT NULL,
  clicked_document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  clicked_at timestamptz,
  dwell_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_queries_org ON search_queries (org_id, created_at DESC);

CREATE TABLE ai_usage (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('answer','draft','quiz_draft')),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  sources_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_org_time ON ai_usage (org_id, created_at DESC);

-- ---------------------------------------------------------------- notifications / jobs / audit
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  link text NOT NULL DEFAULT '',
  dedupe_key text NOT NULL,
  email_status text NOT NULL DEFAULT 'none' CHECK (email_status IN ('none','pending','sent','failed')),
  email_attempts int NOT NULL DEFAULT 0,
  email_last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (org_id, dedupe_key)
);
CREATE INDEX notifications_user ON notifications (org_id, user_id, created_at DESC);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_due ON jobs (status, run_at);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_label text NOT NULL DEFAULT '',
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_org_time ON audit_events (org_id, created_at DESC);
CREATE INDEX audit_events_target ON audit_events (org_id, target_type, target_id);
CREATE TRIGGER audit_events_noupdate BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER audit_events_nodelete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'preview' CHECK (status IN ('preview','committed','cancelled')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz
);

CREATE TABLE download_tokens (
  id text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  params jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['departments','teams','users','user_roles','memberships','approver_scopes','sessions','templates',
    'documents','document_audiences','document_versions','attachments','review_requests','review_assignments','review_comments',
    'approval_steps','approval_step_approvers','approvals','document_relations','feedback','improvement_tickets','checklist_runs',
    'attestation_campaigns','user_attestations','quizzes','quiz_versions','courses','course_versions','training_assignments',
    'module_progress','quiz_attempts','certificates','onboarding_templates','onboarding_runs','search_index','knowledge_chunks',
    'search_queries','ai_usage','notifications','audit_events','import_batches','download_tokens']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (org_id = app_org()) WITH CHECK (org_id = app_org())', t);
  END LOOP;
END $$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations USING (id = app_org()) WITH CHECK (id = app_org());

-- Pre-tenant lookups (login by org slug, session cookie). SECURITY DEFINER, return minimal columns only.
CREATE OR REPLACE FUNCTION auth_org_by_slug(p_slug text) RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.name FROM organizations o WHERE o.slug = p_slug
$$;
CREATE OR REPLACE FUNCTION auth_session(p_id text) RETURNS TABLE (org_id uuid, user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.org_id, s.user_id FROM sessions s
   WHERE s.id = p_id AND s.revoked_at IS NULL AND s.expires_at > now()
$$;

CREATE OR REPLACE FUNCTION worker_org_ids() RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id FROM organizations o
$$;
