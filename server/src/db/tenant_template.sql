-- ============================================================================
-- Meridian tenant schema template. Executed at org provisioning with
-- __SCHEMA__ replaced by the org's schema name. Everything an org owns —
-- metadata, security, automation, analytics definitions, collaboration,
-- content, queues — lives here. Object DATA tables (d_<apiname>) are created
-- dynamically by the metadata engine (see server/src/metadata/storage.ts).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS __SCHEMA__;
SET search_path TO __SCHEMA__;

-- ---------------------------------------------------------------- metadata --

CREATE TABLE object_def (
  id                 char(18) PRIMARY KEY,
  api_name           text NOT NULL UNIQUE,
  label              text NOT NULL,
  plural_label       text NOT NULL,
  key_prefix         char(3) NOT NULL UNIQUE,
  is_custom          boolean NOT NULL DEFAULT false,
  description        text,
  sharing_model      text NOT NULL DEFAULT 'ReadWrite',   -- Private | Read | ReadWrite | ControlledByParent
  feed_enabled       boolean NOT NULL DEFAULT true,
  history_enabled    boolean NOT NULL DEFAULT true,
  activities_enabled boolean NOT NULL DEFAULT true,
  search_enabled     boolean NOT NULL DEFAULT true,
  reports_enabled    boolean NOT NULL DEFAULT true,
  is_queryable       boolean NOT NULL DEFAULT true,
  name_field_label   text NOT NULL DEFAULT 'Name',
  name_field_type    text NOT NULL DEFAULT 'Text',        -- Text | AutoNumber
  auto_number_format text,                                -- e.g. INV-{0000}
  auto_number_seq    bigint NOT NULL DEFAULT 0,
  icon               text,                                -- SLDS-style icon key
  booking            jsonb,                               -- allocation wiring; see inventory/types.ts
  color              text,
  created_date       timestamptz NOT NULL DEFAULT now(),
  last_modified_date timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE picklist_set (
  id   char(18) PRIMARY KEY,
  name text NOT NULL
);

CREATE TABLE picklist_value (
  id         char(18) PRIMARY KEY,
  set_id     char(18) NOT NULL REFERENCES picklist_set(id) ON DELETE CASCADE,
  value      text NOT NULL,
  label      text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order int NOT NULL DEFAULT 0,
  color      text,
  meta       jsonb NOT NULL DEFAULT '{}',   -- e.g. Opportunity stage {probability, isClosed, isWon, forecast}
  UNIQUE (set_id, value)
);

CREATE TABLE field_def (
  id                  char(18) PRIMARY KEY,
  object_id           char(18) NOT NULL REFERENCES object_def(id) ON DELETE CASCADE,
  api_name            text NOT NULL,
  label               text NOT NULL,
  type                text NOT NULL,
  -- Text | TextArea | LongTextArea | RichText | Checkbox | Number | Currency | Percent
  -- Date | DateTime | Time | Email | Phone | Url | Picklist | MultiselectPicklist
  -- Lookup | MasterDetail | Formula | RollupSummary | AutoNumber | Geolocation
  length              int,
  precision           int,
  scale               int,
  is_required         boolean NOT NULL DEFAULT false,
  is_unique           boolean NOT NULL DEFAULT false,
  is_external_id      boolean NOT NULL DEFAULT false,
  default_value       text,                                -- literal or formula source
  formula             text,
  formula_return_type text,
  rollup              jsonb,   -- {childObject, relationshipField, operation, field, filters}
  reference_to        text,    -- object api name for Lookup/MasterDetail
  relationship_name   text,    -- e.g. "Contacts" child relationship on parent
  is_master_detail    boolean NOT NULL DEFAULT false,
  cascade_delete      boolean NOT NULL DEFAULT false,
  restrict_delete     boolean NOT NULL DEFAULT false,
  picklist_set_id     char(18) REFERENCES picklist_set(id),
  restricted_picklist boolean NOT NULL DEFAULT true,
  controlling_field   text,
  dependency_map      jsonb,   -- {controllingValue: [dependent values]}
  track_history       boolean NOT NULL DEFAULT false,
  is_custom           boolean NOT NULL DEFAULT false,
  is_name_field       boolean NOT NULL DEFAULT false,
  is_system           boolean NOT NULL DEFAULT false,      -- Id/CreatedDate/… (not in JSONB)
  help_text           text,
  sort_order          int NOT NULL DEFAULT 0,
  created_date        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (object_id, api_name)
);
CREATE INDEX field_def_object_idx ON field_def (object_id);

CREATE TABLE record_type_def (
  id                 char(18) PRIMARY KEY,
  object_id          char(18) NOT NULL REFERENCES object_def(id) ON DELETE CASCADE,
  api_name           text NOT NULL,
  label              text NOT NULL,
  description        text,
  is_active          boolean NOT NULL DEFAULT true,
  is_default         boolean NOT NULL DEFAULT false,
  picklist_overrides jsonb NOT NULL DEFAULT '{}',          -- {fieldApi: {values:[..], default}}
  UNIQUE (object_id, api_name)
);

CREATE TABLE layout_def (
  id            char(18) PRIMARY KEY,
  object_id     char(18) NOT NULL REFERENCES object_def(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'record',            -- record | compact
  sections      jsonb NOT NULL DEFAULT '[]',
  -- [{label, columns: 1|2, fields: [{apiName, required, readOnly} | {blank:true}]}]
  related_lists jsonb NOT NULL DEFAULT '[]',
  -- [{objectApi, relationshipField, label, columns:[api...], sort:{field,dir}}]
  highlights    jsonb NOT NULL DEFAULT '[]',               -- compact layout field apis
  actions       jsonb NOT NULL DEFAULT '[]',               -- [{name,label,kind:std|url|flow,target}]
  is_default    boolean NOT NULL DEFAULT false,
  UNIQUE (object_id, name)
);

CREATE TABLE layout_assignment (
  id             char(18) PRIMARY KEY,
  object_id      char(18) NOT NULL REFERENCES object_def(id) ON DELETE CASCADE,
  profile_id     char(18),
  record_type_id char(18),
  layout_id      char(18) NOT NULL REFERENCES layout_def(id) ON DELETE CASCADE
);

CREATE TABLE validation_rule (
  id            char(18) PRIMARY KEY,
  object_id     char(18) NOT NULL REFERENCES object_def(id) ON DELETE CASCADE,
  api_name      text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  formula       text NOT NULL,          -- error condition formula (true blocks save)
  error_message text NOT NULL,
  error_field   text,
  description   text,
  UNIQUE (object_id, api_name)
);

CREATE TABLE list_view_def (
  id           char(18) PRIMARY KEY,
  object_id    char(18) NOT NULL REFERENCES object_def(id) ON DELETE CASCADE,
  api_name     text NOT NULL,
  label        text NOT NULL,
  columns      jsonb NOT NULL DEFAULT '[]',
  filters      jsonb NOT NULL DEFAULT '[]',   -- [{field, op, value}]
  filter_logic text,
  scope        text NOT NULL DEFAULT 'everything',         -- everything | mine | queue:<id>
  sort         jsonb,
  visibility   text NOT NULL DEFAULT 'shared',             -- shared | private
  owner_id     char(18),
  kanban       jsonb,                                      -- {groupField, sumField}
  UNIQUE (object_id, api_name)
);

CREATE TABLE app_def (
  id          char(18) PRIMARY KEY,
  api_name    text NOT NULL UNIQUE,
  label       text NOT NULL,
  description text,
  logo_letter text,
  color       text,
  nav_items   jsonb NOT NULL DEFAULT '[]',   -- [{type:'object'|'page', target, label?}]
  is_default  boolean NOT NULL DEFAULT false,
  is_custom   boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------- security --

CREATE TABLE profile (
  id          char(18) PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  is_custom   boolean NOT NULL DEFAULT true,
  perms       jsonb NOT NULL DEFAULT '{}'
  -- {apiEnabled, modifyAllData, viewAllData, manageSetup, manageUsers, runReports,
  --  exportReports, manageDashboards, importData, bulkApi, sendEmail, approvalAdmin}
);

CREATE TABLE permission_set (
  id          char(18) PRIMARY KEY,
  api_name    text NOT NULL UNIQUE,
  label       text NOT NULL,
  description text,
  perms       jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE object_perm (
  id          char(18) PRIMARY KEY,
  parent_id   char(18) NOT NULL,              -- profile.id or permission_set.id
  object_api  text NOT NULL,
  can_create  boolean NOT NULL DEFAULT false,
  can_read    boolean NOT NULL DEFAULT false,
  can_edit    boolean NOT NULL DEFAULT false,
  can_delete  boolean NOT NULL DEFAULT false,
  view_all    boolean NOT NULL DEFAULT false,
  modify_all  boolean NOT NULL DEFAULT false,
  UNIQUE (parent_id, object_api)
);
CREATE INDEX object_perm_parent_idx ON object_perm (parent_id);

CREATE TABLE field_perm (
  id         char(18) PRIMARY KEY,
  parent_id  char(18) NOT NULL,
  object_api text NOT NULL,
  field_api  text NOT NULL,
  readable   boolean NOT NULL DEFAULT true,
  editable   boolean NOT NULL DEFAULT true,
  UNIQUE (parent_id, object_api, field_api)
);
CREATE INDEX field_perm_parent_idx ON field_perm (parent_id, object_api);

CREATE TABLE perm_set_assignment (
  id          char(18) PRIMARY KEY,
  user_id     char(18) NOT NULL,
  perm_set_id char(18) NOT NULL REFERENCES permission_set(id) ON DELETE CASCADE,
  UNIQUE (user_id, perm_set_id)
);

CREATE TABLE role (
  id        char(18) PRIMARY KEY,
  api_name  text NOT NULL UNIQUE,
  name      text NOT NULL,
  parent_id char(18) REFERENCES role(id) ON DELETE SET NULL
);

CREATE TABLE group_def (
  id            char(18) PRIMARY KEY,
  api_name      text NOT NULL UNIQUE,
  label         text NOT NULL,
  type          text NOT NULL DEFAULT 'Regular',           -- Regular | Queue
  member_ids    jsonb NOT NULL DEFAULT '[]',               -- user ids, role:<id>, group:<id>
  queue_objects jsonb NOT NULL DEFAULT '[]',
  email         text
);

CREATE TABLE sharing_setting (
  object_api                     text PRIMARY KEY,
  internal_access                text NOT NULL DEFAULT 'ReadWrite',
  grant_access_using_hierarchies boolean NOT NULL DEFAULT true
);

CREATE TABLE sharing_rule (
  id           char(18) PRIMARY KEY,
  object_api   text NOT NULL,
  api_name     text NOT NULL,
  label        text NOT NULL,
  rule_type    text NOT NULL,                              -- owner | criteria
  owned_by     jsonb,                                      -- {type: Role|Group|RoleAndSubordinates, id}
  criteria     jsonb,                                      -- [{field,op,value}]
  share_with   jsonb NOT NULL,                             -- {type, id}
  access_level text NOT NULL DEFAULT 'Read',               -- Read | Edit
  UNIQUE (object_api, api_name)
);

CREATE TABLE record_share (
  id           char(18) PRIMARY KEY,
  object_api   text NOT NULL,
  record_id    char(18) NOT NULL,
  subject_type text NOT NULL,       -- User | Group | Role | RoleAndSubordinates
  subject_id   char(18) NOT NULL,
  access_level text NOT NULL DEFAULT 'Read',               -- Read | Edit | All
  row_cause    text NOT NULL DEFAULT 'Manual',             -- Manual | Rule | Team
  UNIQUE (object_api, record_id, subject_type, subject_id, row_cause)
);
CREATE INDEX record_share_record_idx ON record_share (object_api, record_id);
CREATE INDEX record_share_subject_idx ON record_share (subject_id);

CREATE TABLE auth_credential (
  user_id       char(18) PRIMARY KEY,
  password_hash text NOT NULL,
  must_change   boolean NOT NULL DEFAULT false,
  failed_count  int NOT NULL DEFAULT 0,
  locked_until  timestamptz
);

CREATE TABLE oauth_client (
  id                 char(18) PRIMARY KEY,
  client_id          text NOT NULL UNIQUE,
  client_secret_hash text NOT NULL,
  name               text NOT NULL,
  redirect_uris      jsonb NOT NULL DEFAULT '[]',
  scopes             jsonb NOT NULL DEFAULT '["api","refresh_token"]',
  is_active          boolean NOT NULL DEFAULT true
);

CREATE TABLE login_history (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id    char(18),
  username   text,
  ts         timestamptz NOT NULL DEFAULT now(),
  ip         text,
  status     text NOT NULL,                                -- Success | Failed | Locked
  user_agent text,
  app        text
);

-- -------------------------------------------------------------- automation --

CREATE TABLE workflow_rule (
  id            char(18) PRIMARY KEY,
  object_api    text NOT NULL,
  api_name      text NOT NULL,
  label         text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  trigger_type  text NOT NULL DEFAULT 'onCreateOrUpdate',
  -- onCreate | onCreateOrUpdate | onCreateOrUpdateMeetingCriteriaChanged
  criteria      jsonb,                                     -- [{field,op,value}] AND-joined
  criteria_formula text,                                   -- alternative formula criteria
  actions       jsonb NOT NULL DEFAULT '[]',
  -- [{type: fieldUpdate|emailAlert|task|outboundMessage, ...}]
  time_triggers jsonb NOT NULL DEFAULT '[]',
  -- [{offsetHours, base: 'rule'|fieldApi, actions:[...]}]
  UNIQUE (object_api, api_name)
);

CREATE TABLE flow_def (
  id            char(18) PRIMARY KEY,
  api_name      text NOT NULL,
  label         text NOT NULL,
  description   text,
  version       int NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'Draft',             -- Draft | Active | Obsolete
  process_type  text NOT NULL DEFAULT 'AutoLaunchedFlow',
  -- AutoLaunchedFlow | RecordTriggered | Scheduled | Screen
  trigger       jsonb,
  -- {objectApi, on: create|update|createOrUpdate|delete, when: before|after,
  --  conditions:[{field,op,value}], schedule:{cron | frequency, startDate}}
  start_node    text,
  nodes         jsonb NOT NULL DEFAULT '{}',
  -- {nodeId: {type: assignment|decision|loop|getRecords|createRecords|updateRecords|
  --           deleteRecords|email|postToFeed|submitForApproval|subflow|screen, ...,
  --           next, canvas:{x,y}}}
  variables     jsonb NOT NULL DEFAULT '[]',
  created_date  timestamptz NOT NULL DEFAULT now(),
  last_modified_date timestamptz NOT NULL DEFAULT now(),
  UNIQUE (api_name, version)
);

CREATE TABLE approval_process (
  id                    char(18) PRIMARY KEY,
  object_api            text NOT NULL,
  api_name              text NOT NULL,
  label                 text NOT NULL,
  active                boolean NOT NULL DEFAULT true,
  description           text,
  entry_criteria        jsonb,
  entry_formula         text,
  lock_record           boolean NOT NULL DEFAULT true,
  allow_recall          boolean NOT NULL DEFAULT true,
  steps                 jsonb NOT NULL DEFAULT '[]',
  -- [{name, approverType: user|manager|queue, approverId?, criteria?, unanimity?}]
  initial_submit_actions jsonb NOT NULL DEFAULT '[]',
  final_approve_actions  jsonb NOT NULL DEFAULT '[]',
  final_reject_actions   jsonb NOT NULL DEFAULT '[]',
  recall_actions         jsonb NOT NULL DEFAULT '[]',
  UNIQUE (object_api, api_name)
);

CREATE TABLE approval_work_item (
  id             char(18) PRIMARY KEY,
  process_id     char(18) NOT NULL REFERENCES approval_process(id) ON DELETE CASCADE,
  object_api     text NOT NULL,
  record_id      char(18) NOT NULL,
  step_index     int NOT NULL DEFAULT 0,
  step_name      text,
  status         text NOT NULL DEFAULT 'Pending',          -- Pending | Approved | Rejected | Recalled
  assigned_to    char(18) NOT NULL,                        -- user or queue id
  submitted_by   char(18) NOT NULL,
  submitted_date timestamptz NOT NULL DEFAULT now(),
  completed_date timestamptz,
  actor_id       char(18),
  comments       jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX approval_wi_assignee_idx ON approval_work_item (assigned_to, status);
CREATE INDEX approval_wi_record_idx ON approval_work_item (record_id);

CREATE TABLE email_template (
  id             char(18) PRIMARY KEY,
  api_name       text NOT NULL UNIQUE,
  name           text NOT NULL,
  folder         text NOT NULL DEFAULT 'Unfiled Public',
  subject        text NOT NULL,
  body_text      text,
  body_html      text,
  related_object text
);

CREATE TABLE email_outbound (
  id          char(18) PRIMARY KEY,
  to_addrs    jsonb NOT NULL DEFAULT '[]',
  cc_addrs    jsonb NOT NULL DEFAULT '[]',
  subject     text,
  body_text   text,
  body_html   text,
  related_id  char(18),
  template_id char(18),
  status      text NOT NULL DEFAULT 'Queued',              -- Queued | Sent | Failed
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE TABLE cron_job (
  id        char(18) PRIMARY KEY,
  name      text NOT NULL,
  kind      text NOT NULL,       -- scheduledFlow | weeklyExport | purgeRecycleBin | reportSubscription
  cron_expr text NOT NULL,       -- m h dom mon dow
  payload   jsonb NOT NULL DEFAULT '{}',
  next_run  timestamptz,
  last_run  timestamptz,
  active    boolean NOT NULL DEFAULT true
);

CREATE TABLE time_trigger_queue (
  id         char(18) PRIMARY KEY,
  kind       text NOT NULL,                                -- workflow | flow
  source_id  char(18) NOT NULL,
  object_api text NOT NULL,
  record_id  char(18) NOT NULL,
  fire_at    timestamptz NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'Pending'               -- Pending | Done | Cancelled | Failed
);
CREATE INDEX ttq_due_idx ON time_trigger_queue (status, fire_at);

-- --------------------------------------------------------------- analytics --

CREATE TABLE report_def (
  id           char(18) PRIMARY KEY,
  api_name     text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  folder       text NOT NULL DEFAULT 'Public Reports',
  format       text NOT NULL DEFAULT 'summary',            -- tabular | summary | matrix
  object_api   text NOT NULL,
  columns      jsonb NOT NULL DEFAULT '[]',                -- [fieldPath]
  groupings    jsonb NOT NULL DEFAULT '[]',                -- [{field, dateGranularity?, dir}] rows then cols
  aggregates   jsonb NOT NULL DEFAULT '[]',                -- [{field, op}]
  filters      jsonb NOT NULL DEFAULT '[]',
  filter_logic text,
  scope        text NOT NULL DEFAULT 'everything',
  chart        jsonb,                                      -- {type, groupBy, measure, title}
  sort         jsonb,
  row_limit    int,
  created_by   char(18),
  created_date timestamptz NOT NULL DEFAULT now(),
  last_modified_date timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_def (
  id              char(18) PRIMARY KEY,
  api_name        text NOT NULL UNIQUE,
  name            text NOT NULL,
  description     text,
  folder          text NOT NULL DEFAULT 'Public Dashboards',
  running_user_id char(18),
  run_as_viewer   boolean NOT NULL DEFAULT true,
  components      jsonb NOT NULL DEFAULT '[]',
  -- [{reportApi, type: metric|bar|column|line|donut|table|gauge, title, x,y,w,h, options}]
  refresh_minutes int,
  created_by      char(18),
  created_date    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ collaboration --

CREATE TABLE feed_item (
  id           char(18) PRIMARY KEY,
  parent_id    char(18) NOT NULL,          -- record the post sits on
  type         text NOT NULL DEFAULT 'TextPost',           -- TextPost | TrackedChange | SystemPost
  body         text,
  payload      jsonb,                                      -- tracked-change details etc.
  created_by   char(18) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  like_ids     jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX feed_item_parent_idx ON feed_item (parent_id, created_date DESC);

CREATE TABLE feed_comment (
  id           char(18) PRIMARY KEY,
  feed_item_id char(18) NOT NULL REFERENCES feed_item(id) ON DELETE CASCADE,
  body         text NOT NULL,
  created_by   char(18) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE record_history (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  object_api text NOT NULL,
  record_id  char(18) NOT NULL,
  field_api  text NOT NULL,
  old_value  text,
  new_value  text,
  changed_by char(18),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX record_history_record_idx ON record_history (object_api, record_id, changed_at DESC);

-- ----------------------------------------------------------------- content --

CREATE TABLE content_document (
  id                char(18) PRIMARY KEY,
  title             text NOT NULL,
  latest_version_id char(18),
  file_type         text,
  is_archived       boolean NOT NULL DEFAULT false,
  is_deleted        boolean NOT NULL DEFAULT false,
  created_by        char(18),
  created_date      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_version (
  id             char(18) PRIMARY KEY,
  document_id    char(18) NOT NULL REFERENCES content_document(id) ON DELETE CASCADE,
  version_number int NOT NULL DEFAULT 1,
  title          text NOT NULL,
  path_on_disk   text NOT NULL,
  file_size      bigint NOT NULL DEFAULT 0,
  file_ext       text,
  checksum       text,
  created_by     char(18),
  created_date   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_document_link (
  id               char(18) PRIMARY KEY,
  document_id      char(18) NOT NULL REFERENCES content_document(id) ON DELETE CASCADE,
  linked_entity_id char(18) NOT NULL,
  share_type       text NOT NULL DEFAULT 'V',
  UNIQUE (document_id, linked_entity_id)
);
CREATE INDEX cdl_entity_idx ON content_document_link (linked_entity_id);

-- ------------------------------------------------------------------ search --

CREATE TABLE search_index (
  record_id  char(18) PRIMARY KEY,
  object_api text NOT NULL,
  title      text,
  body       text,
  tsv        tsvector
);
CREATE INDEX search_tsv_idx ON search_index USING gin (tsv);
CREATE INDEX search_object_idx ON search_index (object_api);

-- ------------------------------------------------------------- inventory --

-- A bookable thing, or a pool of interchangeable units.
--
--   exclusive — one allocation at a time: the Wellington Suite, the Boardroom, room 12
--   pool      — `capacity` units per grain step: restaurant covers, "any King room"
--
-- `ordinal` is the stride multiplier that folds the resource into the allocation range, so a
-- single range exclusion constraint can enforce "no double booking" without btree_gist (which
-- the embedded driver does not have). See server/src/inventory/span.ts.
CREATE TABLE inventory_resource (
  id          char(18) PRIMARY KEY,
  api_name    text NOT NULL UNIQUE,
  label       text NOT NULL,
  kind        text NOT NULL DEFAULT 'Resource',      -- Bedroom | Venue | Cover | anything
  mode        text NOT NULL DEFAULT 'exclusive',     -- exclusive | pool
  capacity    integer NOT NULL DEFAULT 1,
  -- Units a pool may exceed capacity by; 0 means never overbook.
  overbook    integer NOT NULL DEFAULT 0,
  grain       text NOT NULL DEFAULT 'minute',        -- minute | day
  ordinal     bigint NOT NULL UNIQUE,
  -- Opening windows as [{day:0-6, from:'18:00', to:'21:30'}]; null means always open.
  windows     jsonb,
  active      boolean NOT NULL DEFAULT true,
  attributes  jsonb NOT NULL DEFAULT '{}',
  CHECK (mode IN ('exclusive','pool')),
  CHECK (grain IN ('minute','day')),
  CHECK (capacity >= 1),
  CHECK (overbook >= 0)
);
CREATE SEQUENCE inventory_resource_ordinal_seq START 1;

-- One reservation of one resource for one span.
--
-- The exclusion constraint is the whole point: two staff booking the Wellington Suite for
-- overlapping nights cannot both win, whatever the application does. `exclusive` is stored rather
-- than joined so the constraint can be partial — pool resources are governed by inventory_usage
-- instead, and released allocations stop blocking.
CREATE TABLE inventory_allocation (
  id          char(18) PRIMARY KEY,
  resource_id char(18) NOT NULL REFERENCES inventory_resource(id) ON DELETE CASCADE,
  object_api  text NOT NULL,
  record_id   char(18) NOT NULL,
  quantity    integer NOT NULL DEFAULT 1,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  span        int8range NOT NULL,
  exclusive   boolean NOT NULL,
  status      text NOT NULL DEFAULT 'Reserved',      -- Reserved | Held | Released
  expires_at  timestamptz,                           -- holds only
  created_by  char(18),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('Reserved','Held','Released')),
  CHECK (quantity >= 1),
  CHECK (ends_at > starts_at),
  EXCLUDE USING gist (span WITH &&) WHERE (exclusive AND status <> 'Released')
);
CREATE INDEX alloc_record_idx ON inventory_allocation (record_id);
CREATE INDEX alloc_resource_idx ON inventory_allocation (resource_id, starts_at);
CREATE INDEX alloc_expiry_idx ON inventory_allocation (expires_at) WHERE status = 'Held';

-- Capacity counters for pool resources: one row per resource per grain step.
-- The CHECK is what actually prevents overselling; concurrent writers serialise on the row.
CREATE TABLE inventory_usage (
  resource_id char(18) NOT NULL REFERENCES inventory_resource(id) ON DELETE CASCADE,
  step        bigint NOT NULL,
  taken       integer NOT NULL DEFAULT 0,
  ceiling     integer NOT NULL,
  PRIMARY KEY (resource_id, step),
  CHECK (taken >= 0 AND taken <= ceiling)
);

-- ----------------------------------------------------------------- misc/ux --

CREATE TABLE recent_item (
  user_id    char(18) NOT NULL,
  record_id  char(18) NOT NULL,
  object_api text NOT NULL,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, record_id)
);

CREATE TABLE translation (
  id       char(18) PRIMARY KEY,
  language text NOT NULL,
  kind     text NOT NULL,        -- objectLabel | fieldLabel | picklist | app | custom
  key      text NOT NULL,
  value    text NOT NULL,
  UNIQUE (language, kind, key)
);

CREATE TABLE currency_type (
  iso_code        text PRIMARY KEY,
  conversion_rate numeric NOT NULL DEFAULT 1,
  decimal_places  int NOT NULL DEFAULT 2,
  is_active       boolean NOT NULL DEFAULT true,
  is_corporate    boolean NOT NULL DEFAULT false
);

CREATE TABLE org_pref (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE push_topic (
  id       char(18) PRIMARY KEY,
  name     text NOT NULL UNIQUE,
  query    text NOT NULL,
  active   boolean NOT NULL DEFAULT true,
  notify   jsonb NOT NULL DEFAULT '{"create":true,"update":true,"delete":true,"undelete":true}'
);

-- --------------------------------------------------------------- lifecycle --

CREATE TABLE package_def (
  id           char(18) PRIMARY KEY,
  namespace    text,
  name         text NOT NULL,
  version      text NOT NULL DEFAULT '1.0',
  description  text,
  package_type text NOT NULL DEFAULT 'unmanaged',          -- managed | unmanaged
  contents     jsonb NOT NULL DEFAULT '{}',                -- metadata bundle
  is_local     boolean NOT NULL DEFAULT true,              -- authored here vs installed
  installed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE change_set (
  id          char(18) PRIMARY KEY,
  name        text NOT NULL,
  description text,
  direction   text NOT NULL DEFAULT 'outbound',            -- outbound | inbound
  status      text NOT NULL DEFAULT 'Open',                -- Open | Uploaded | Deployed | Failed
  contents    jsonb NOT NULL DEFAULT '{}',
  target_org  char(18),
  source_org  char(18),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deployed_at timestamptz
);

RESET search_path;
