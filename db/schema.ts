import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable("contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }), firstName: text("first_name").notNull(), lastName: text("last_name").notNull(),
  email: text("email").notNull().unique(), company: text("company").notNull().default(""), title: text("title").notNull().default(""),
  stage: text("stage").notNull().default("Lead"), tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  lastContact: text("last_contact"), nextFollowUp: text("next_follow_up"), subscribed: integer("subscribed", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});
export const activities = sqliteTable("activities", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), type: text("type").notNull(), note: text("note").notNull(), happenedAt: text("happened_at").notNull() });
export const tasks = sqliteTable("tasks", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), title: text("title").notNull(), dueDate: text("due_date").notNull(), completed: integer("completed", { mode: "boolean" }).notNull().default(false) });
export const campaigns = sqliteTable("campaigns", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), subject: text("subject").notNull(), status: text("status").notNull().default("Draft"), audience: text("audience").notNull(), recipientCount: integer("recipient_count").notNull().default(0), createdAt: text("created_at").notNull() });
