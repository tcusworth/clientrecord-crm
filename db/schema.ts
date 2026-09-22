import { index, uniqueIndex, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }), firstName: text("first_name").notNull(), lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(), company: text("company").notNull().default(""), title: text("title").notNull().default(""),
  phone: text("phone").notNull().default(""), location: text("location").notNull().default(""), notes: text("notes").notNull().default(""), leadSource: text("lead_source").notNull().default("Direct"),
  stage: text("stage").notNull().default("Lead"), tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  lastContact: text("last_contact"), nextFollowUp: text("next_follow_up"), subscribed: integer("subscribed", { mode: "boolean" }).notNull().default(true),
  suppressionReason: text("suppression_reason"), suppressedAt: text("suppressed_at"),
  resendId: text("resend_id"), resendSyncedAt: text("resend_synced_at"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull().default(""),
});
export const activities = sqliteTable("activities", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), type: text("type").notNull(), note: text("note").notNull(), happenedAt: text("happened_at").notNull() });
export const tasks = sqliteTable("tasks", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), title: text("title").notNull(), dueDate: text("due_date").notNull(), owner: text("owner").notNull().default("Trevor"), status: text("status").notNull().default("Open"), completed: integer("completed", { mode: "boolean" }).notNull().default(false) });
export const campaigns = sqliteTable("campaigns", {
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), subject: text("subject").notNull(),
  previewText: text("preview_text").notNull().default(""), html: text("html").notNull().default(""), textBody: text("text_body").notNull().default(""),
  status: text("status").notNull().default("Draft"), audience: text("audience").notNull(), recipientCount: integer("recipient_count").notNull().default(0),
  resendSegmentId: text("resend_segment_id"), resendBroadcastId: text("resend_broadcast_id"), scheduledAt: text("scheduled_at"), sentAt: text("sent_at"),
  deliveredCount: integer("delivered_count").notNull().default(0), openedCount: integer("opened_count").notNull().default(0), clickedCount: integer("clicked_count").notNull().default(0), bouncedCount: integer("bounced_count").notNull().default(0), complainedCount: integer("complained_count").notNull().default(0),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull().default(""),
});
export const campaignEvents = sqliteTable("campaign_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), campaignId: integer("campaign_id").notNull().references(() => campaigns.id),
  providerEventId: text("provider_event_id").notNull().unique(), type: text("type").notNull(), emailId: text("email_id"), recipient: text("recipient"), occurredAt: text("occurred_at").notNull(), payload: text("payload").notNull(),
});
export const segments = sqliteTable("segments", {
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(),
  stage: text("stage").notNull().default("Any"), tag: text("tag").notNull().default(""), company: text("company").notNull().default(""), location: text("location").notNull().default(""),
  subscription: text("subscription").notNull().default("Subscribed"), inactivityDays: integer("inactivity_days").notNull().default(0),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const suppressions = sqliteTable("suppressions", {
  id: integer("id").primaryKey({ autoIncrement: true }), email: text("email").notNull().unique(),
  reason: text("reason").notNull(), source: text("source").notNull().default("Manual"), createdAt: text("created_at").notNull(), removedAt: text("removed_at"),
});
export const consentEvents = sqliteTable("consent_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), email: text("email").notNull(), status: text("status").notNull(), reason: text("reason").notNull(), source: text("source").notNull(), occurredAt: text("occurred_at").notNull(),
});
export const companies = sqliteTable("companies", {
  website: text("website").notNull().default(""), industry: text("industry").notNull().default(""), tier: text("tier").notNull().default(""), territory: text("territory").notNull().default(""), owner: text("owner").notNull().default(""), tags: text("tags").notNull().default("[]"),
  fitScore: integer("fit_score").notNull().default(0), fitReason: text("fit_reason").notNull().default(""), intentScore: integer("intent_score").notNull().default(0), temperature: text("temperature").notNull().default("Cold"),
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(), stage: text("stage").notNull().default("Prospect"), notes: text("notes").notNull().default(""), primaryContactId: integer("primary_contact_id").references(() => contacts.id), updatedAt: text("updated_at").notNull(),
});

export const deals = sqliteTable("deals", {
  pipelineKey: text("pipeline_key").notNull().default("default"), stageKey: text("stage_key"), closedReason: text("closed_reason").notNull().default(""), stageEnteredAt: text("stage_entered_at").notNull().default(""),
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), company: text("company").notNull().default(""), contactId: integer("contact_id").references(() => contacts.id),
  stage: text("stage").notNull().default("Qualified"), owner: text("owner").notNull().default("Trevor"), value: integer("value").notNull().default(0), probability: integer("probability").notNull().default(25),
  nextStep: text("next_step").notNull().default(""), closeDate: text("close_date"), leadSource: text("lead_source").notNull().default("Direct"), status: text("status").notNull().default("Open"),
  campaign: text("campaign").notNull().default(""), partner: text("partner").notNull().default(""), forecastCategory: text("forecast_category").notNull().default("Pipeline"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const salesPipelines = sqliteTable("sales_pipelines", {
  id: text("id").primaryKey(), name: text("name").notNull(), stages: text("stages").notNull(), updatedAt: text("updated_at").notNull(),
});
export const accountStakeholders = sqliteTable("account_stakeholders", {
  id: integer("id").primaryKey({autoIncrement:true}), companyId: integer("company_id").notNull().references(()=>companies.id), contactId: integer("contact_id").notNull().references(()=>contacts.id),
  role: text("role").notNull(), notes: text("notes").notNull().default(""),
},t=>[uniqueIndex("stakeholder_account_contact").on(t.companyId,t.contactId)]);
export const accountSignals = sqliteTable("account_signals", {
  id: text("id").primaryKey(), companyId: integer("company_id").notNull().references(()=>companies.id), kind: text("kind").notNull(), summary: text("summary").notNull(), evidence: text("evidence").notNull(),
  points: integer("points").notNull(), active: integer("active").notNull().default(1), occurredAt: text("occurred_at").notNull(), createdAt: text("created_at").notNull(), actor: text("actor").notNull(),
},t=>[index("signals_company_active").on(t.companyId,t.active)]);
export const qualificationAlerts = sqliteTable("qualification_alerts", {
  id: integer("id").primaryKey({autoIncrement:true}), companyId: integer("company_id").notNull().references(()=>companies.id), owner: text("owner").notNull(), message: text("message").notNull(), createdAt: text("created_at").notNull(), readAt: text("read_at"),
},t=>[index("alerts_owner_read").on(t.owner,t.readAt)]);
export const dealStageHistory = sqliteTable("deal_stage_history", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), fromStage: text("from_stage").notNull(), toStage: text("to_stage").notNull(), fromPipeline: text("from_pipeline").notNull(), toPipeline: text("to_pipeline").notNull(), reason: text("reason").notNull().default(""), actor: text("actor").notNull(), happenedAt: text("happened_at").notNull(),
},t=>[index("history_deal_date").on(t.dealId,t.happenedAt)]);
export const dealTasks = sqliteTable("deal_tasks", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), title: text("title").notNull(), owner: text("owner").notNull(), dueDate: text("due_date").notNull(), completed: integer("completed").notNull().default(0), createdAt: text("created_at").notNull(),
},t=>[index("deal_tasks_deal_due").on(t.dealId,t.dueDate)]);
export const leadSources = sqliteTable("lead_sources", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(), spend: integer("spend").notNull().default(0), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const automationSequences = sqliteTable("automation_sequences", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), triggerType: text("trigger_type").notNull().default("Manual"), triggerValue: text("trigger_value").notNull().default(""), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const automationSteps = sqliteTable("automation_steps", { id: integer("id").primaryKey({ autoIncrement: true }), sequenceId: integer("sequence_id").notNull().references(() => automationSequences.id), stepOrder: integer("step_order").notNull(), delayDays: integer("delay_days").notNull().default(0), actionType: text("action_type").notNull(), subject: text("subject").notNull().default(""), body: text("body").notNull().default(""), taskTitle: text("task_title").notNull().default("") });
export const automationEnrollments = sqliteTable("automation_enrollments", { id: integer("id").primaryKey({ autoIncrement: true }), sequenceId: integer("sequence_id").notNull().references(() => automationSequences.id), contactId: integer("contact_id").notNull().references(() => contacts.id), currentStep: integer("current_step").notNull().default(0), status: text("status").notNull().default("Active"), nextRunAt: text("next_run_at").notNull(), enrolledAt: text("enrolled_at").notNull(), completedAt: text("completed_at"), stoppedReason: text("stopped_reason"), repliedAt: text("replied_at") });
export const customFieldDefinitions = sqliteTable("custom_field_definitions", { id: integer("id").primaryKey({ autoIncrement: true }), entityType: text("entity_type").notNull().default("contact"), name: text("name").notNull(), fieldKey: text("field_key").notNull().unique(), fieldType: text("field_type").notNull().default("text"), options: text("options", { mode: "json" }).$type<string[]>().notNull().default([]), createdAt: text("created_at").notNull() });
export const customFieldValues = sqliteTable("custom_field_values", { id: integer("id").primaryKey({ autoIncrement: true }), definitionId: integer("definition_id").notNull().references(() => customFieldDefinitions.id), entityType: text("entity_type").notNull().default("contact"), entityId: integer("entity_id").notNull(), value: text("value").notNull().default(""), updatedAt: text("updated_at").notNull() });
export const teamMembers = sqliteTable("team_members", { id: integer("id").primaryKey({ autoIncrement: true }), email: text("email").notNull().unique(), name: text("name").notNull().default(""), role: text("role").notNull().default("viewer"), permissions: text("permissions").notNull().default("{}"), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const auditLogs = sqliteTable("audit_logs", { id: integer("id").primaryKey({ autoIncrement: true }), actorEmail: text("actor_email").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id"), summary: text("summary").notNull(), changes: text("changes").notNull().default("{}"), createdAt: text("created_at").notNull() });
export const integrationAccounts = sqliteTable("integration_accounts", { id: integer("id").primaryKey({ autoIncrement: true }), provider: text("provider").notNull().unique(), accountEmail: text("account_email").notNull().default(""), accessToken: text("access_token").notNull(), refreshToken: text("refresh_token").notNull(), expiresAt: text("expires_at").notNull(), scopes: text("scopes").notNull().default(""), syncEmail: integer("sync_email", {mode:"boolean"}).notNull().default(true), syncCalendar: integer("sync_calendar", {mode:"boolean"}).notNull().default(true), autoTasks: integer("auto_tasks", {mode:"boolean"}).notNull().default(true), lastSyncedAt: text("last_synced_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const oauthStates = sqliteTable("oauth_states", { id: integer("id").primaryKey({ autoIncrement: true }), state: text("state").notNull().unique(), actorEmail: text("actor_email").notNull(), expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull() });
export const syncRecords = sqliteTable("sync_records", { id: integer("id").primaryKey({ autoIncrement: true }), provider: text("provider").notNull(), externalId: text("external_id").notNull().unique(), itemType: text("item_type").notNull(), contactId: integer("contact_id").references(() => contacts.id), occurredAt: text("occurred_at").notNull(), createdAt: text("created_at").notNull() });
export const brandSettings = sqliteTable("brand_settings", {
  id: integer("id").primaryKey(),
  businessName: text("business_name").notNull().default(""),
  logoUrl: text("logo_url").notNull().default(""),
  fromName: text("from_name").notNull().default(""),
  fromEmail: text("from_email").notNull().default(""),
  replyToEmail: text("reply_to_email").notNull().default(""),
  sendingDomain: text("sending_domain").notNull().default(""),
  physicalAddress: text("physical_address").notNull().default(""),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({autoIncrement:true}), ownerEmail: text("owner_email").notNull(), kind: text("kind").notNull(), title: text("title").notNull(), body: text("body").notNull().default(""), entityType: text("entity_type"), entityId: text("entity_id"), actionUrl: text("action_url"), readAt: text("read_at"), createdAt: text("created_at").notNull(),
}, t => [index("notifications_owner_read").on(t.ownerEmail,t.readAt)]);
export const systemEvents = sqliteTable("system_events", {
  id: integer("id").primaryKey({autoIncrement:true}), severity: text("severity").notNull(), category: text("category").notNull(), source: text("source").notNull(), message: text("message").notNull(), details: text("details").notNull().default("{}"), resolvedAt: text("resolved_at"), createdAt: text("created_at").notNull(),
}, t => [index("system_events_status").on(t.severity,t.resolvedAt)]);
export const jobRuns = sqliteTable("job_runs", {
  id: integer("id").primaryKey({autoIncrement:true}), jobType: text("job_type").notNull(), status: text("status").notNull(), processed: integer("processed").notNull().default(0), failed: integer("failed").notNull().default(0), message: text("message").notNull().default(""), startedAt: text("started_at").notNull(), completedAt: text("completed_at"),
}, t => [index("job_runs_type_started").on(t.jobType,t.startedAt)]);
export const deliveryLogs = sqliteTable("delivery_logs", {
  id: integer("id").primaryKey({autoIncrement:true}), provider: text("provider").notNull(), kind: text("kind").notNull(), status: text("status").notNull(), recipient: text("recipient").notNull().default(""), subject: text("subject").notNull().default(""), externalId: text("external_id"), error: text("error").notNull().default(""), context: text("context").notNull().default("{}"), createdAt: text("created_at").notNull(),
}, t => [index("delivery_logs_status_date").on(t.status,t.createdAt)]);
export const backupSnapshots = sqliteTable("backup_snapshots", {
  id: text("id").primaryKey(), objectKey: text("object_key").notNull(), status: text("status").notNull(), rowCount: integer("row_count").notNull().default(0), checksum: text("checksum").notNull().default(""), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), restoredAt: text("restored_at"),
});
export const operationSettings = sqliteTable("operation_settings", {
  id: integer("id").primaryKey(), dailyBackupHour: integer("daily_backup_hour").notNull().default(2), stagnationDays: integer("stagnation_days").notNull().default(14), postMeetingTaskDays: integer("post_meeting_task_days").notNull().default(1), auditRetentionDays: integer("audit_retention_days").notNull().default(730), eventRetentionDays: integer("event_retention_days").notNull().default(90), deliveryRetentionDays: integer("delivery_retention_days").notNull().default(180), syncRetentionDays: integer("sync_retention_days").notNull().default(365), updatedBy: text("updated_by").notNull().default(""), updatedAt: text("updated_at").notNull(),
});
export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(), entityType: text("entity_type").notNull(), filename: text("filename").notNull().default(""), createdCount: integer("created_count").notNull().default(0), updatedCount: integer("updated_count").notNull().default(0), status: text("status").notNull().default("Completed"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), rolledBackAt: text("rolled_back_at"),
});
export const importChanges = sqliteTable("import_changes", {
  id: integer("id").primaryKey({autoIncrement:true}), batchId: text("batch_id").notNull().references(()=>importBatches.id), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), changeType: text("change_type").notNull(), beforeJson: text("before_json"), afterJson: text("after_json"),
}, t => [index("import_changes_batch").on(t.batchId)]);
export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(), name: text("name").notNull(), keyHash: text("key_hash").notNull().unique(), keyPrefix: text("key_prefix").notNull(), scopes: text("scopes").notNull(), lastUsedAt: text("last_used_at"), expiresAt: text("expires_at"), revokedAt: text("revoked_at"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
});
export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(), name: text("name").notNull(), url: text("url").notNull(), events: text("events").notNull(), secretEncrypted: text("secret_encrypted").notNull(), active: integer("active",{mode:"boolean"}).notNull().default(true), lastStatus: integer("last_status"), lastTriggeredAt: text("last_triggered_at"), createdAt: text("created_at").notNull(),
});
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: integer("id").primaryKey({autoIncrement:true}), endpointId: text("endpoint_id").notNull().references(()=>webhookEndpoints.id), event: text("event").notNull(), status: text("status").notNull(), responseStatus: integer("response_status"), error: text("error").notNull().default(""), createdAt: text("created_at").notNull(),
}, t => [index("webhook_deliveries_date").on(t.createdAt)]);
