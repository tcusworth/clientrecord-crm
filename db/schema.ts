import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(), stage: text("stage").notNull().default("Prospect"), notes: text("notes").notNull().default(""), primaryContactId: integer("primary_contact_id").references(() => contacts.id), updatedAt: text("updated_at").notNull(),
});

export const deals = sqliteTable("deals", {
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), company: text("company").notNull().default(""), contactId: integer("contact_id").references(() => contacts.id),
  stage: text("stage").notNull().default("Qualified"), owner: text("owner").notNull().default("Trevor"), value: integer("value").notNull().default(0), probability: integer("probability").notNull().default(25),
  nextStep: text("next_step").notNull().default(""), closeDate: text("close_date"), leadSource: text("lead_source").notNull().default("Direct"), status: text("status").notNull().default("Open"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const leadSources = sqliteTable("lead_sources", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(), spend: integer("spend").notNull().default(0), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const automationSequences = sqliteTable("automation_sequences", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), triggerType: text("trigger_type").notNull().default("Manual"), triggerValue: text("trigger_value").notNull().default(""), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const automationSteps = sqliteTable("automation_steps", { id: integer("id").primaryKey({ autoIncrement: true }), sequenceId: integer("sequence_id").notNull().references(() => automationSequences.id), stepOrder: integer("step_order").notNull(), delayDays: integer("delay_days").notNull().default(0), actionType: text("action_type").notNull(), subject: text("subject").notNull().default(""), body: text("body").notNull().default(""), taskTitle: text("task_title").notNull().default("") });
export const automationEnrollments = sqliteTable("automation_enrollments", { id: integer("id").primaryKey({ autoIncrement: true }), sequenceId: integer("sequence_id").notNull().references(() => automationSequences.id), contactId: integer("contact_id").notNull().references(() => contacts.id), currentStep: integer("current_step").notNull().default(0), status: text("status").notNull().default("Active"), nextRunAt: text("next_run_at").notNull(), enrolledAt: text("enrolled_at").notNull(), completedAt: text("completed_at") });
export const customFieldDefinitions = sqliteTable("custom_field_definitions", { id: integer("id").primaryKey({ autoIncrement: true }), entityType: text("entity_type").notNull().default("contact"), name: text("name").notNull(), fieldKey: text("field_key").notNull().unique(), fieldType: text("field_type").notNull().default("text"), options: text("options", { mode: "json" }).$type<string[]>().notNull().default([]), createdAt: text("created_at").notNull() });
export const customFieldValues = sqliteTable("custom_field_values", { id: integer("id").primaryKey({ autoIncrement: true }), definitionId: integer("definition_id").notNull().references(() => customFieldDefinitions.id), entityType: text("entity_type").notNull().default("contact"), entityId: integer("entity_id").notNull(), value: text("value").notNull().default(""), updatedAt: text("updated_at").notNull() });
export const teamMembers = sqliteTable("team_members", { id: integer("id").primaryKey({ autoIncrement: true }), email: text("email").notNull().unique(), name: text("name").notNull().default(""), role: text("role").notNull().default("viewer"), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const auditLogs = sqliteTable("audit_logs", { id: integer("id").primaryKey({ autoIncrement: true }), actorEmail: text("actor_email").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id"), summary: text("summary").notNull(), changes: text("changes").notNull().default("{}"), createdAt: text("created_at").notNull() });
export const integrationAccounts = sqliteTable("integration_accounts", { id: integer("id").primaryKey({ autoIncrement: true }), provider: text("provider").notNull().unique(), accountEmail: text("account_email").notNull().default(""), accessToken: text("access_token").notNull(), refreshToken: text("refresh_token").notNull(), expiresAt: text("expires_at").notNull(), scopes: text("scopes").notNull().default(""), lastSyncedAt: text("last_synced_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const oauthStates = sqliteTable("oauth_states", { id: integer("id").primaryKey({ autoIncrement: true }), state: text("state").notNull().unique(), actorEmail: text("actor_email").notNull(), expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull() });
export const syncRecords = sqliteTable("sync_records", { id: integer("id").primaryKey({ autoIncrement: true }), provider: text("provider").notNull(), externalId: text("external_id").notNull().unique(), itemType: text("item_type").notNull(), contactId: integer("contact_id").references(() => contacts.id), occurredAt: text("occurred_at").notNull(), createdAt: text("created_at").notNull() });
