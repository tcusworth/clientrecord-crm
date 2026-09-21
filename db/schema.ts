import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }), firstName: text("first_name").notNull(), lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(), company: text("company").notNull().default(""), title: text("title").notNull().default(""),
  phone: text("phone").notNull().default(""),
  stage: text("stage").notNull().default("Lead"), tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  lastContact: text("last_contact"), nextFollowUp: text("next_follow_up"), subscribed: integer("subscribed", { mode: "boolean" }).notNull().default(true),
  suppressionReason: text("suppression_reason"), suppressedAt: text("suppressed_at"),
  resendId: text("resend_id"), resendSyncedAt: text("resend_synced_at"),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull().default(""),
});
export const activities = sqliteTable("activities", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), type: text("type").notNull(), note: text("note").notNull(), happenedAt: text("happened_at").notNull() });
export const tasks = sqliteTable("tasks", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), title: text("title").notNull(), dueDate: text("due_date").notNull(), completed: integer("completed", { mode: "boolean" }).notNull().default(false) });
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
  stage: text("stage").notNull().default("Any"), tag: text("tag").notNull().default(""), company: text("company").notNull().default(""),
  subscription: text("subscription").notNull().default("Subscribed"), inactivityDays: integer("inactivity_days").notNull().default(0),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});
export const suppressions = sqliteTable("suppressions", {
  id: integer("id").primaryKey({ autoIncrement: true }), email: text("email").notNull().unique(),
  reason: text("reason").notNull(), source: text("source").notNull().default("Manual"), createdAt: text("created_at").notNull(), removedAt: text("removed_at"),
});
