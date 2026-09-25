import { sql } from "drizzle-orm";
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
}, t => [
  // Server-side contact list/search (lib/crm-records.ts): name sort + duplicate lookup, stage/view filters, company joins, email lookups.
  index("contacts_name_nocase").on(sql`${t.lastName} COLLATE NOCASE`, sql`${t.firstName} COLLATE NOCASE`), index("contacts_stage").on(t.stage),
  index("contacts_company_key").on(sql`lower(trim(${t.company}))`), index("contacts_email_lower").on(sql`lower(${t.email})`),
  index("contacts_last_contact").on(t.lastContact), index("contacts_next_follow_up").on(t.nextFollowUp),
]);
export const activities = sqliteTable("activities", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), type: text("type").notNull(), note: text("note").notNull(), happenedAt: text("happened_at").notNull() }, t => [index("activities_contact_date").on(t.contactId, t.happenedAt), index("activities_date").on(t.happenedAt)]);
export const tasks = sqliteTable("tasks", { id: integer("id").primaryKey({ autoIncrement: true }), contactId: integer("contact_id").notNull().references(() => contacts.id), title: text("title").notNull(), dueDate: text("due_date").notNull(), owner: text("owner").notNull().default("Trevor"), status: text("status").notNull().default("Open"), completed: integer("completed", { mode: "boolean" }).notNull().default(false) }, t => [index("tasks_contact").on(t.contactId), index("tasks_open_due").on(t.completed, t.dueDate)]);
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
}, t => [index("campaign_events_recipient_lower").on(sql`lower(${t.recipient})`)]);
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
  website: text("website").notNull().default(""), domain: text("domain").notNull().default(""), industry: text("industry").notNull().default(""), tier: text("tier").notNull().default(""), territory: text("territory").notNull().default(""), owner: text("owner").notNull().default(""), tags: text("tags").notNull().default("[]"),
  summary: text("summary").notNull().default(""), headquarters: text("headquarters").notNull().default(""), linkedinUrl: text("linkedin_url").notNull().default(""), logoUrl: text("logo_url").notNull().default(""), employeeRange: text("employee_range").notNull().default(""), enrichmentSource: text("enrichment_source").notNull().default(""), enrichmentConfidence: integer("enrichment_confidence").notNull().default(0), enrichedAt: text("enriched_at"),
  fitScore: integer("fit_score").notNull().default(0), fitReason: text("fit_reason").notNull().default(""), intentScore: integer("intent_score").notNull().default(0), temperature: text("temperature").notNull().default("Cold"),
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(), stage: text("stage").notNull().default("Prospect"), notes: text("notes").notNull().default(""), primaryContactId: integer("primary_contact_id").references(() => contacts.id), updatedAt: text("updated_at").notNull(),
}, t => [index("companies_name_lower").on(sql`lower(${t.name})`), index("companies_temperature_name").on(t.temperature, t.name)]);

export const deals = sqliteTable("deals", {
  pipelineKey: text("pipeline_key").notNull().default("default"), stageKey: text("stage_key"), closedReason: text("closed_reason").notNull().default(""), stageEnteredAt: text("stage_entered_at").notNull().default(""),
  id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), company: text("company").notNull().default(""), companyId: integer("company_id").references(() => companies.id), contactId: integer("contact_id").references(() => contacts.id),
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
export const dealActivities = sqliteTable("deal_activities", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), companyId: integer("company_id").references(()=>companies.id), contactId: integer("contact_id").references(()=>contacts.id),
  type: text("type").notNull(), subject: text("subject").notNull().default(""), body: text("body").notNull(), owner: text("owner").notNull(), outcome: text("outcome").notNull().default(""), happenedAt: text("happened_at").notNull(), followUpAt: text("follow_up_at"),
  source: text("source").notNull().default("Manual"), threadKey: text("thread_key"), externalId: text("external_id"), responseExpected: integer("response_expected",{mode:"boolean"}).notNull().default(false), pinned: integer("pinned",{mode:"boolean"}).notNull().default(false), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[index("deal_activities_deal_date").on(t.dealId,t.happenedAt),index("deal_activities_contact_date").on(t.contactId,t.happenedAt),index("deal_activities_thread").on(t.threadKey)]);
export const dealRelationshipHealthScores = sqliteTable("deal_relationship_health_scores", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), score: integer("score").notNull(), band: text("band").notNull(),
  provisional: integer("provisional",{mode:"boolean"}).notNull().default(true), confidence: text("confidence").notNull(), confidenceScore: integer("confidence_score").notNull(),
  componentsJson: text("components_json").notNull(), evidenceJson: text("evidence_json").notNull(), dataGapsJson: text("data_gaps_json").notNull(), inputHash: text("input_hash").notNull(), calculatedAt: text("calculated_at").notNull(),
},t=>[uniqueIndex("deal_relationship_health_input").on(t.dealId,t.inputHash),index("deal_relationship_health_deal_date").on(t.dealId,t.calculatedAt)]);
export const dealRecommendations = sqliteTable("deal_recommendations", {
  id: text("id").primaryKey(), dealId: integer("deal_id").notNull().references(()=>deals.id), ruleKey: text("rule_key").notNull(), fingerprint: text("fingerprint").notNull(), action: text("action").notNull(), reason: text("reason").notNull(), evidenceJson: text("evidence_json").notNull(), priority: text("priority").notNull(), suggestedOwner: text("suggested_owner").notNull(), suggestedDueDate: text("suggested_due_date").notNull(), status: text("status").notNull().default("Active"), currentKey: text("current_key"), taskId: integer("task_id").references(()=>dealTasks.id), generatedAt: text("generated_at").notNull(), acceptedAt: text("accepted_at"), dismissedAt: text("dismissed_at"), completedAt: text("completed_at"), decidedBy: text("decided_by"), decisionNote: text("decision_note").notNull().default(""), updatedAt: text("updated_at").notNull(),
},t=>[uniqueIndex("deal_recommendation_fingerprint").on(t.dealId,t.fingerprint),uniqueIndex("deal_recommendation_current").on(t.dealId,t.currentKey),index("deal_recommendations_deal_date").on(t.dealId,t.generatedAt)]);
export const dealNotes = sqliteTable("deal_notes", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), kind: text("kind").notNull().default("Note"), body: text("body").notNull(), owner: text("owner").notNull(), pinned: integer("pinned",{mode:"boolean"}).notNull().default(false), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[index("deal_notes_deal_pinned").on(t.dealId,t.pinned,t.createdAt)]);
export const dealStakeholders = sqliteTable("deal_stakeholders", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), contactId: integer("contact_id").notNull().references(()=>contacts.id), role: text("role").notNull(), notes: text("notes").notNull().default(""), isPrimary: integer("is_primary",{mode:"boolean"}).notNull().default(false), active: integer("active",{mode:"boolean"}).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[uniqueIndex("deal_stakeholder_unique").on(t.dealId,t.contactId),index("deal_stakeholders_contact").on(t.contactId)]);
export const dealLineItems = sqliteTable("deal_line_items", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), name: text("name").notNull(), sku: text("sku").notNull().default(""), quantity: integer("quantity").notNull().default(1), unitPrice: integer("unit_price").notNull().default(0), discountPercent: integer("discount_percent").notNull().default(0), notes: text("notes").notNull().default(""), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[index("deal_line_items_deal").on(t.dealId)]);
export const dealInsights = sqliteTable("deal_insights", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), kind: text("kind").notNull(), title: text("title").notNull(), detail: text("detail").notNull().default(""), severity: text("severity").notNull().default("Medium"), status: text("status").notNull().default("Open"), owner: text("owner").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[index("deal_insights_deal_kind").on(t.dealId,t.kind)]);
export const dealReviews = sqliteTable("deal_reviews", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), reviewType: text("review_type").notNull().default("Deal review"), status: text("status").notNull().default("Requested"), approver: text("approver").notNull(), requestedBy: text("requested_by").notNull(), comments: text("comments").notNull().default(""), requestedAt: text("requested_at").notNull(), decidedAt: text("decided_at"),
},t=>[index("deal_reviews_deal_status").on(t.dealId,t.status)]);
export const dealProposals = sqliteTable("deal_proposals", {
  id: integer("id").primaryKey({autoIncrement:true}), dealId: integer("deal_id").notNull().references(()=>deals.id), title: text("title").notNull(), amount: integer("amount").notNull().default(0), status: text("status").notNull().default("Draft"), validUntil: text("valid_until"), documentId: text("document_id"), bodyMarkdown: text("body_markdown").notNull().default(""), aiArtifactId: text("ai_artifact_id").references(()=>aiArtifacts.id,{onDelete:"set null"}), sourceSummary: text("source_summary").notNull().default(""), sentAt: text("sent_at"), openedAt: text("opened_at"), acceptedAt: text("accepted_at"), acceptedBy: text("accepted_by"), shareToken: text("share_token"), shareExpiresAt: text("share_expires_at"), sentTo: text("sent_to"), contractStartDate: text("contract_start_date"), contractEndDate: text("contract_end_date"), renewalTermMonths: integer("renewal_term_months"), renewalNoticeDays: integer("renewal_notice_days"), autoRenew: integer("auto_renew",{mode:"boolean"}).notNull().default(false), contractTerms: text("contract_terms").notNull().default(""), contractStatus: text("contract_status").notNull().default("Draft"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[index("deal_proposals_deal").on(t.dealId),uniqueIndex("deal_proposals_share_token").on(t.shareToken),index("deal_proposals_contract_dates").on(t.contractEndDate)]);
export const proposalAcceptances = sqliteTable("proposal_acceptances", {
  id: text("id").primaryKey(), proposalId: integer("proposal_id").notNull().references(()=>dealProposals.id), signerName: text("signer_name").notNull(), signerEmail: text("signer_email").notNull(), signerTitle: text("signer_title").notNull().default(""), signatureText: text("signature_text").notNull(), termsSnapshot: text("terms_snapshot").notNull(), ipHash: text("ip_hash").notNull().default(""), userAgent: text("user_agent").notNull().default(""), acceptedAt: text("accepted_at").notNull(),
},t=>[uniqueIndex("proposal_acceptances_proposal").on(t.proposalId),index("proposal_acceptances_email").on(t.signerEmail)]);
export const proposalShareEvents = sqliteTable("proposal_share_events", {
  id: integer("id").primaryKey({autoIncrement:true}), proposalId: integer("proposal_id").notNull().references(()=>dealProposals.id), type: text("type").notNull(), recipient: text("recipient").notNull().default(""), metadataJson: text("metadata_json").notNull().default("{}"), occurredAt: text("occurred_at").notNull(),
},t=>[index("proposal_share_events_proposal_date").on(t.proposalId,t.occurredAt),index("proposal_share_events_type").on(t.type)]);
export const quickbooksInvoices = sqliteTable("quickbooks_invoices", {
  id: text("id").primaryKey(), proposalId: integer("proposal_id").notNull().references(()=>dealProposals.id), dealId: integer("deal_id").notNull().references(()=>deals.id), companyId: integer("company_id").references(()=>companies.id), quickbooksCustomerId: text("quickbooks_customer_id").notNull().default(""), quickbooksInvoiceId: text("quickbooks_invoice_id").notNull().default(""), documentNumber: text("document_number").notNull().default(""), status: text("status").notNull().default("Draft"), amount: integer("amount").notNull().default(0), balance: integer("balance").notNull().default(0), dueDate: text("due_date"), syncedAt: text("synced_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[uniqueIndex("quickbooks_invoices_proposal").on(t.proposalId),uniqueIndex("quickbooks_invoices_external").on(t.quickbooksInvoiceId),index("quickbooks_invoices_status_due").on(t.status,t.dueDate),index("quickbooks_invoices_deal").on(t.dealId)]);
export const clientDocuments = sqliteTable("client_documents", {
  id: text("id").primaryKey(), companyId: integer("company_id").references(()=>companies.id), contactId: integer("contact_id").references(()=>contacts.id), dealId: integer("deal_id").references(()=>deals.id), title: text("title").notNull(), category: text("category").notNull().default("Correspondence"), status: text("status").notNull().default("Active"), sensitive: integer("sensitive",{mode:"boolean"}).notNull().default(false), latestVersion: integer("latest_version").notNull().default(1), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), archivedAt: text("archived_at"),
},t=>[index("client_documents_deal_status").on(t.dealId,t.status),index("client_documents_company_status").on(t.companyId,t.status),index("client_documents_contact_status").on(t.contactId,t.status)]);
export const documentVersions = sqliteTable("document_versions", {
  id: text("id").primaryKey(), documentId: text("document_id").notNull().references(()=>clientDocuments.id), version: integer("version").notNull(), objectKey: text("object_key").notNull().unique(), filename: text("filename").notNull(), contentType: text("content_type").notNull(), size: integer("size").notNull(), checksum: text("checksum").notNull(), uploadedBy: text("uploaded_by").notNull(), uploadedAt: text("uploaded_at").notNull(),
},t=>[uniqueIndex("document_versions_document_version").on(t.documentId,t.version),index("document_versions_document").on(t.documentId)]);
export const dealMeetings = sqliteTable("deal_meetings", {
  id: text("id").primaryKey(), dealId: integer("deal_id").notNull().references(()=>deals.id), companyId: integer("company_id").references(()=>companies.id), activityId: integer("activity_id").references(()=>dealActivities.id),
  subject: text("subject").notNull(), status: text("status").notNull().default("Scheduled"), startsAt: text("starts_at").notNull(), endsAt: text("ends_at"), owner: text("owner").notNull(),
  summary: text("summary").notNull().default(""), decisionsJson: text("decisions_json").notNull().default("[]"), customerCommitmentsJson: text("customer_commitments_json").notNull().default("[]"), internalCommitmentsJson: text("internal_commitments_json").notNull().default("[]"), risksObjectionsJson: text("risks_objections_json").notNull().default("[]"), nextStepsJson: text("next_steps_json").notNull().default("[]"),
  transcriptDocumentId: text("transcript_document_id").references(()=>clientDocuments.id), sourceProvider: text("source_provider").notNull().default("Manual"), externalId: text("external_id"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
},t=>[index("deal_meetings_deal_start").on(t.dealId,t.startsAt),uniqueIndex("deal_meetings_provider_external").on(t.sourceProvider,t.externalId),index("deal_meetings_activity").on(t.activityId)]);
export const dealMeetingAttendees = sqliteTable("deal_meeting_attendees", {
  id: integer("id").primaryKey({autoIncrement:true}), meetingId: text("meeting_id").notNull().references(()=>dealMeetings.id), contactId: integer("contact_id").references(()=>contacts.id), name: text("name").notNull().default(""), email: text("email").notNull().default(""), role: text("role").notNull().default("Attendee"), createdAt: text("created_at").notNull(),
},t=>[index("deal_meeting_attendees_meeting").on(t.meetingId),index("deal_meeting_attendees_contact").on(t.contactId)]);
export const leadSources = sqliteTable("lead_sources", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull().unique(), spend: integer("spend").notNull().default(0), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const automationSequences = sqliteTable("automation_sequences", { id: integer("id").primaryKey({ autoIncrement: true }), name: text("name").notNull(), triggerType: text("trigger_type").notNull().default("Manual"), triggerValue: text("trigger_value").notNull().default(""), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const automationSteps = sqliteTable("automation_steps", { id: integer("id").primaryKey({ autoIncrement: true }), sequenceId: integer("sequence_id").notNull().references(() => automationSequences.id), stepOrder: integer("step_order").notNull(), delayDays: integer("delay_days").notNull().default(0), actionType: text("action_type").notNull(), subject: text("subject").notNull().default(""), body: text("body").notNull().default(""), taskTitle: text("task_title").notNull().default("") });
export const automationEnrollments = sqliteTable("automation_enrollments", { id: integer("id").primaryKey({ autoIncrement: true }), sequenceId: integer("sequence_id").notNull().references(() => automationSequences.id), contactId: integer("contact_id").notNull().references(() => contacts.id), currentStep: integer("current_step").notNull().default(0), status: text("status").notNull().default("Active"), nextRunAt: text("next_run_at").notNull(), enrolledAt: text("enrolled_at").notNull(), completedAt: text("completed_at"), stoppedReason: text("stopped_reason"), repliedAt: text("replied_at") });
export const customFieldDefinitions = sqliteTable("custom_field_definitions", { id: integer("id").primaryKey({ autoIncrement: true }), entityType: text("entity_type").notNull().default("contact"), name: text("name").notNull(), fieldKey: text("field_key").notNull(), fieldType: text("field_type").notNull().default("text"), options: text("options", { mode: "json" }).$type<string[]>().notNull().default([]), createdAt: text("created_at").notNull() }, table => [uniqueIndex("custom_field_definitions_entity_key_unique").on(table.entityType, table.fieldKey)]);
export const customFieldValues = sqliteTable("custom_field_values", { id: integer("id").primaryKey({ autoIncrement: true }), definitionId: integer("definition_id").notNull().references(() => customFieldDefinitions.id), entityType: text("entity_type").notNull().default("contact"), entityId: integer("entity_id").notNull(), value: text("value").notNull().default(""), updatedAt: text("updated_at").notNull() }, table => [uniqueIndex("custom_field_values_record_unique").on(table.definitionId, table.entityType, table.entityId), index("custom_field_values_entity_idx").on(table.entityType, table.entityId)]);

export const customObjectTypes = sqliteTable("custom_object_types", {
  id: text("id").primaryKey(), key: text("key").notNull().unique(), singularName: text("singular_name").notNull(), pluralName: text("plural_name").notNull(),
  description: text("description").notNull().default(""), icon: text("icon").notNull().default("boxes"), titleFieldKey: text("title_field_key").notNull().default("name"),
  status: text("status").notNull().default("Active"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("custom_object_types_status_idx").on(table.status)]);
export const customObjectFields = sqliteTable("custom_object_fields", {
  id: text("id").primaryKey(), objectTypeId: text("object_type_id").notNull().references(() => customObjectTypes.id), key: text("key").notNull(), label: text("label").notNull(),
  fieldType: text("field_type").notNull().default("text"), optionsJson: text("options_json").notNull().default("[]"), required: integer("required", { mode:"boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0), showInList: integer("show_in_list", { mode:"boolean" }).notNull().default(true), archivedAt: text("archived_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [uniqueIndex("custom_object_fields_object_key_unique").on(table.objectTypeId, table.key), index("custom_object_fields_object_sort_idx").on(table.objectTypeId, table.sortOrder)]);
export const customObjectRecords = sqliteTable("custom_object_records", {
  id: text("id").primaryKey(), objectTypeId: text("object_type_id").notNull().references(() => customObjectTypes.id), displayName: text("display_name").notNull(), valuesJson: text("values_json").notNull().default("{}"),
  owner: text("owner").notNull().default(""), status: text("status").notNull().default("Active"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("custom_object_records_object_status_idx").on(table.objectTypeId, table.status), index("custom_object_records_object_updated_idx").on(table.objectTypeId, table.updatedAt)]);
export const customRelationshipTypes = sqliteTable("custom_relationship_types", {
  id: text("id").primaryKey(), name: text("name").notNull(), fromType: text("from_type").notNull(), toType: text("to_type").notNull(), fromLabel: text("from_label").notNull(), toLabel: text("to_label").notNull(),
  cardinality: text("cardinality").notNull().default("many_to_many"), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("custom_relationship_types_endpoints_idx").on(table.fromType, table.toType)]);
export const customRelationships = sqliteTable("custom_relationships", {
  id: text("id").primaryKey(), relationshipTypeId: text("relationship_type_id").notNull().references(() => customRelationshipTypes.id), fromEntityType: text("from_entity_type").notNull(), fromEntityId: text("from_entity_id").notNull(),
  toEntityType: text("to_entity_type").notNull(), toEntityId: text("to_entity_id").notNull(), note: text("note").notNull().default(""), createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(),
}, table => [uniqueIndex("custom_relationships_link_unique").on(table.relationshipTypeId, table.fromEntityId, table.toEntityId), index("custom_relationships_from_idx").on(table.fromEntityType, table.fromEntityId), index("custom_relationships_to_idx").on(table.toEntityType, table.toEntityId)]);
export const customObjectLayouts = sqliteTable("custom_object_layouts", {
  id: text("id").primaryKey(), objectTypeId: text("object_type_id").notNull().references(() => customObjectTypes.id), name: text("name").notNull().default("Default"), sectionsJson: text("sections_json").notNull().default("[]"),
  isDefault: integer("is_default", { mode:"boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [index("custom_object_layouts_object_idx").on(table.objectTypeId, table.isDefault)]);
export const customRollupDefinitions = sqliteTable("custom_rollup_definitions", {
  id: text("id").primaryKey(), objectTypeId: text("object_type_id").notNull().references(() => customObjectTypes.id), key: text("key").notNull(), label: text("label").notNull(), relationshipTypeId: text("relationship_type_id").notNull().references(() => customRelationshipTypes.id),
  aggregate: text("aggregate").notNull().default("count"), sourceFieldKey: text("source_field_key"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, table => [uniqueIndex("custom_rollups_object_key_unique").on(table.objectTypeId, table.key), index("custom_rollups_relationship_idx").on(table.relationshipTypeId)]);
export const teamMembers = sqliteTable("team_members", { id: integer("id").primaryKey({ autoIncrement: true }), email: text("email").notNull().unique(), name: text("name").notNull().default(""), role: text("role").notNull().default("viewer"), permissions: text("permissions").notNull().default("{}"), active: integer("active", { mode: "boolean" }).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const auditLogs = sqliteTable("audit_logs", { id: integer("id").primaryKey({ autoIncrement: true }), actorEmail: text("actor_email").notNull(), action: text("action").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id"), summary: text("summary").notNull(), changes: text("changes").notNull().default("{}"), createdAt: text("created_at").notNull() });
export const integrationAccounts = sqliteTable("integration_accounts", { id: integer("id").primaryKey({ autoIncrement: true }), provider: text("provider").notNull().unique(), accountEmail: text("account_email").notNull().default(""), accessToken: text("access_token").notNull(), refreshToken: text("refresh_token").notNull(), expiresAt: text("expires_at").notNull(), scopes: text("scopes").notNull().default(""), metadataJson: text("metadata_json").notNull().default("{}"), syncEmail: integer("sync_email", {mode:"boolean"}).notNull().default(true), syncCalendar: integer("sync_calendar", {mode:"boolean"}).notNull().default(true), autoTasks: integer("auto_tasks", {mode:"boolean"}).notNull().default(true), lastSyncedAt: text("last_synced_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull() });
export const oauthStates = sqliteTable("oauth_states", { id: integer("id").primaryKey({ autoIncrement: true }), state: text("state").notNull().unique(), actorEmail: text("actor_email").notNull(), expiresAt: text("expires_at").notNull(), createdAt: text("created_at").notNull() });
export const syncRecords = sqliteTable("sync_records", { id: integer("id").primaryKey({ autoIncrement: true }), provider: text("provider").notNull(), externalId: text("external_id").notNull().unique(), itemType: text("item_type").notNull(), contactId: integer("contact_id").references(() => contacts.id), dealId: integer("deal_id").references(()=>deals.id), threadKey: text("thread_key"), occurredAt: text("occurred_at").notNull(), createdAt: text("created_at").notNull() });
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

export const aiSettings = sqliteTable("ai_settings", {
  id: integer("id").primaryKey(),
  provider: text("provider").notNull().default("openai"),
  model: text("model").notNull().default("gpt-5-mini"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  dailyRunLimit: integer("daily_run_limit").notNull().default(100),
  perUserDailyLimit: integer("per_user_daily_limit").notNull().default(25),
  maxContextChars: integer("max_context_chars").notNull().default(60000),
  resultRetentionDays: integer("result_retention_days").notNull().default(730),
  requireReview: integer("require_review", { mode: "boolean" }).notNull().default(true),
  allowSensitiveSources: integer("allow_sensitive_sources", { mode: "boolean" }).notNull().default(false),
  updatedBy: text("updated_by").notNull().default(""),
  updatedAt: text("updated_at").notNull(),
});
export const aiPromptVersions = sqliteTable("ai_prompt_versions", {
  id: text("id").primaryKey(), feature: text("feature").notNull(), version: integer("version").notNull(), name: text("name").notNull(),
  systemPrompt: text("system_prompt").notNull(), responseSchema: text("response_schema").notNull().default("{}"), status: text("status").notNull().default("Draft"),
  createdBy: text("created_by").notNull(), createdAt: text("created_at").notNull(), activatedBy: text("activated_by"), activatedAt: text("activated_at"),
}, t => [uniqueIndex("ai_prompt_feature_version").on(t.feature,t.version),index("ai_prompt_feature_status").on(t.feature,t.status)]);
export const aiRuns = sqliteTable("ai_runs", {
  id: text("id").primaryKey(), feature: text("feature").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id"), status: text("status").notNull(),
  provider: text("provider").notNull(), model: text("model").notNull(), promptVersion: integer("prompt_version"), inputHash: text("input_hash").notNull(), requestedBy: text("requested_by").notNull(),
  sourceCount: integer("source_count").notNull().default(0), inputChars: integer("input_chars").notNull().default(0), outputChars: integer("output_chars").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0), estimatedTokens: integer("estimated_tokens").notNull().default(0), error: text("error").notNull().default(""),
  startedAt: text("started_at").notNull(), completedAt: text("completed_at"),
}, t => [index("ai_runs_user_date").on(t.requestedBy,t.startedAt),index("ai_runs_feature_date").on(t.feature,t.startedAt),index("ai_runs_status_date").on(t.status,t.startedAt)]);
export const aiArtifacts = sqliteTable("ai_artifacts", {
  id: text("id").primaryKey(), runId: text("run_id").references(()=>aiRuns.id), feature: text("feature").notNull(), entityType: text("entity_type").notNull(), entityId: text("entity_id"),
  reviewStatus: text("review_status").notNull().default("Draft"), contentJson: text("content_json").notNull(), originalContentJson: text("original_content_json").notNull(),
  explanation: text("explanation").notNull().default(""), confidence: integer("confidence").notNull().default(0), provider: text("provider").notNull(), model: text("model").notNull(),
  promptVersion: integer("prompt_version"), rulesVersion: text("rules_version").notNull().default(""), inputHash: text("input_hash").notNull(), generatedBy: text("generated_by").notNull(),
  generatedAt: text("generated_at").notNull(), reviewedBy: text("reviewed_by"), reviewedAt: text("reviewed_at"), supersededBy: text("superseded_by"),
  sensitive: integer("sensitive",{mode:"boolean"}).notNull().default(false),
}, t => [index("ai_artifacts_entity_date").on(t.entityType,t.entityId,t.generatedAt),index("ai_artifacts_status_date").on(t.reviewStatus,t.generatedAt)]);
export const aiArtifactSources = sqliteTable("ai_artifact_sources", {
  id: integer("id").primaryKey({autoIncrement:true}), artifactId: text("artifact_id").notNull().references(()=>aiArtifacts.id), sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(),
  sourceUpdatedAt: text("source_updated_at"), contentHash: text("content_hash").notNull(), excerpt: text("excerpt").notNull().default(""),
}, t => [uniqueIndex("ai_artifact_source_unique").on(t.artifactId,t.sourceType,t.sourceId),index("ai_artifact_sources_artifact").on(t.artifactId)]);
export const aiFeedbackEvents = sqliteTable("ai_feedback_events", {
  id: integer("id").primaryKey({autoIncrement:true}), artifactId: text("artifact_id").notNull().references(()=>aiArtifacts.id), action: text("action").notNull(),
  beforeJson: text("before_json").notNull().default("{}"), afterJson: text("after_json").notNull().default("{}"), comment: text("comment").notNull().default(""), actor: text("actor").notNull(), createdAt: text("created_at").notNull(),
}, t => [index("ai_feedback_artifact_date").on(t.artifactId,t.createdAt)]);
export const aiRecordFields = sqliteTable("ai_record_fields", {
  id: text("id").primaryKey(), entityType: text("entity_type").notNull(), entityId: text("entity_id").notNull(), fieldKey: text("field_key").notNull(),
  valueJson: text("value_json").notNull(), explanation: text("explanation").notNull().default(""), confidence: integer("confidence").notNull().default(0), citationsJson: text("citations_json").notNull().default("[]"),
  sourceArtifactId: text("source_artifact_id").references(()=>aiArtifacts.id,{onDelete:"set null"}), manualOverride: integer("manual_override",{mode:"boolean"}).notNull().default(false), locked: integer("locked",{mode:"boolean"}).notNull().default(false),
  updatedBy: text("updated_by").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("ai_record_field_unique").on(t.entityType,t.entityId,t.fieldKey),index("ai_record_fields_entity").on(t.entityType,t.entityId),index("ai_record_fields_artifact").on(t.sourceArtifactId)]);
export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(), name: text("name").notNull(), url: text("url").notNull(), events: text("events").notNull(), secretEncrypted: text("secret_encrypted").notNull(), active: integer("active",{mode:"boolean"}).notNull().default(true), lastStatus: integer("last_status"), lastTriggeredAt: text("last_triggered_at"), createdAt: text("created_at").notNull(),
});
export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: integer("id").primaryKey({autoIncrement:true}), endpointId: text("endpoint_id").notNull().references(()=>webhookEndpoints.id), event: text("event").notNull(), status: text("status").notNull(), responseStatus: integer("response_status"), error: text("error").notNull().default(""), createdAt: text("created_at").notNull(),
}, t => [index("webhook_deliveries_date").on(t.createdAt)]);
export const meetilyWebhookEvents = sqliteTable("meetily_webhook_events", {
  id: text("id").primaryKey(), externalId: text("external_id").notNull().unique(), eventType: text("event_type").notNull().default("meeting.completed"), payloadJson: text("payload_json").notNull(), payloadHash: text("payload_hash").notNull(), subject: text("subject").notNull().default("Meetily meeting"), occurredAt: text("occurred_at").notNull(), status: text("status").notNull().default("Needs association"), dealId: integer("deal_id").references(()=>deals.id), meetingId: text("meeting_id").references(()=>dealMeetings.id), error: text("error").notNull().default(""), duplicateCount: integer("duplicate_count").notNull().default(0), receivedAt: text("received_at").notNull(), lastSeenAt: text("last_seen_at").notNull(), processedAt: text("processed_at"),
}, t => [index("meetily_events_status_date").on(t.status,t.receivedAt),index("meetily_events_deal").on(t.dealId)]);
export const leadIntakes = sqliteTable("lead_intakes", {
  id: text("id").primaryKey(), source: text("source").notNull().default("Website"), formName: text("form_name").notNull().default(""), firstName: text("first_name").notNull().default(""), lastName: text("last_name").notNull().default(""), email: text("email").notNull(), companyName: text("company_name").notNull().default(""), website: text("website").notNull().default(""), message: text("message").notNull().default(""), attributionJson: text("attribution_json").notNull().default("{}"), payloadJson: text("payload_json").notNull().default("{}"), status: text("status").notNull().default("New"), owner: text("owner").notNull().default(""), contactId: integer("contact_id").references(()=>contacts.id), companyId: integer("company_id").references(()=>companies.id), duplicateContactId: integer("duplicate_contact_id").references(()=>contacts.id), taskId: integer("task_id").references(()=>tasks.id), receivedAt: text("received_at").notNull(), routedAt: text("routed_at"), resolvedAt: text("resolved_at"),
}, t => [index("lead_intakes_status_received").on(t.status,t.receivedAt),index("lead_intakes_email").on(t.email)]);
export const inboxMessages = sqliteTable("inbox_messages", {
  id: text("id").primaryKey(), provider: text("provider").notNull().default("Manual"), externalId: text("external_id"), direction: text("direction").notNull().default("Inbound"), fromEmail: text("from_email").notNull(), fromName: text("from_name").notNull().default(""), toEmails: text("to_emails").notNull().default("[]"), subject: text("subject").notNull().default(""), body: text("body").notNull().default(""), attachmentsJson: text("attachments_json").notNull().default("[]"), threadKey: text("thread_key"), inReplyTo: text("in_reply_to"), responseDueAt: text("response_due_at"), firstResponseAt: text("first_response_at"), status: text("status").notNull().default("Unassigned"), owner: text("owner").notNull().default(""), contactId: integer("contact_id").references(()=>contacts.id), companyId: integer("company_id").references(()=>companies.id), dealId: integer("deal_id").references(()=>deals.id), taskId: integer("task_id").references(()=>tasks.id), occurredAt: text("occurred_at").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("inbox_messages_provider_external").on(t.provider,t.externalId),index("inbox_messages_status_date").on(t.status,t.occurredAt),index("inbox_messages_contact").on(t.contactId),index("inbox_messages_thread").on(t.threadKey),index("inbox_messages_sla").on(t.direction,t.responseDueAt)]);
export const customerSuccessPlans = sqliteTable("customer_success_plans", {
  id: text("id").primaryKey(), companyId: integer("company_id").notNull().references(()=>companies.id).unique(), owner: text("owner").notNull(), status: text("status").notNull().default("Onboarding"),
  onboardingStart: text("onboarding_start"), onboardingTarget: text("onboarding_target"), healthScore: integer("health_score").notNull().default(60), adoptionScore: integer("adoption_score").notNull().default(0), renewalDate: text("renewal_date"), annualValue: integer("annual_value").notNull().default(0), expansionPotential: text("expansion_potential").notNull().default("Unknown"), churnRisk: text("churn_risk").notNull().default("Low"),
  objectivesJson: text("objectives_json").notNull().default("[]"), stakeholderNotes: text("stakeholder_notes").notNull().default(""), risks: text("risks").notNull().default(""), nextExecutiveTouchpoint: text("next_executive_touchpoint"), notes: text("notes").notNull().default(""), renewalDealId: integer("renewal_deal_id").references(()=>deals.id), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [index("customer_success_status").on(t.status),index("customer_success_renewal").on(t.renewalDate),index("customer_success_company").on(t.companyId)]);

export const partnerCompanies = sqliteTable("partner_companies", {
  id: text("id").primaryKey(), companyId: integer("company_id").references(()=>companies.id), name: text("name").notNull(), domain: text("domain").notNull().default(""), type: text("type").notNull().default("Referral"), tier: text("tier").notNull().default("Registered"), status: text("status").notNull().default("Active"), owner: text("owner").notNull(), territory: text("territory").notNull().default(""), commissionPercent: integer("commission_percent").notNull().default(10), permissionsJson: text("permissions_json").notNull().default("[]"), notes: text("notes").notNull().default(""), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("partner_companies_name").on(t.name),index("partner_companies_status").on(t.status)]);
export const partnerContacts = sqliteTable("partner_contacts", {
  id: text("id").primaryKey(), partnerCompanyId: text("partner_company_id").notNull().references(()=>partnerCompanies.id), contactId: integer("contact_id").references(()=>contacts.id), firstName: text("first_name").notNull(), lastName: text("last_name").notNull(), email: text("email").notNull(), title: text("title").notNull().default(""), phone: text("phone").notNull().default(""), role: text("role").notNull().default("Partner rep"), portalAccess: integer("portal_access",{mode:"boolean"}).notNull().default(false), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("partner_contacts_email").on(t.email),index("partner_contacts_company").on(t.partnerCompanyId)]);
export const partnerReferrals = sqliteTable("partner_referrals", {
  id: text("id").primaryKey(), partnerCompanyId: text("partner_company_id").notNull().references(()=>partnerCompanies.id), partnerContactId: text("partner_contact_id").references(()=>partnerContacts.id), dealId: integer("deal_id").references(()=>deals.id), prospectCompany: text("prospect_company").notNull(), prospectContact: text("prospect_contact").notNull().default(""), prospectEmail: text("prospect_email").notNull().default(""), status: text("status").notNull().default("Submitted"), protectionStatus: text("protection_status").notNull().default("Pending"), protectionExpiresAt: text("protection_expires_at"), attributionPercent: integer("attribution_percent").notNull().default(100), estimatedValue: integer("estimated_value").notNull().default(0), owner: text("owner").notNull(), notes: text("notes").notNull().default(""), submittedAt: text("submitted_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [index("partner_referrals_status").on(t.status,t.submittedAt),index("partner_referrals_deal").on(t.dealId)]);
export const partnerPayouts = sqliteTable("partner_payouts", {
  id: text("id").primaryKey(), partnerCompanyId: text("partner_company_id").notNull().references(()=>partnerCompanies.id), referralId: text("referral_id").references(()=>partnerReferrals.id), dealId: integer("deal_id").references(()=>deals.id), amount: integer("amount").notNull(), status: text("status").notNull().default("Accrued"), dueDate: text("due_date"), paidAt: text("paid_at"), reference: text("reference").notNull().default(""), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [index("partner_payouts_status_due").on(t.status,t.dueDate)]);

export const competitors = sqliteTable("competitors", {
  id: text("id").primaryKey(), name: text("name").notNull(), website: text("website").notNull().default(""), category: text("category").notNull().default("Direct"), positioning: text("positioning").notNull().default(""), strengths: text("strengths").notNull().default(""), weaknesses: text("weaknesses").notNull().default(""), differentiation: text("differentiation").notNull().default(""), objectionGuidance: text("objection_guidance").notNull().default(""), battlecard: text("battlecard").notNull().default(""), active: integer("active",{mode:"boolean"}).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("competitors_name").on(t.name)]);
export const dealCompetitors = sqliteTable("deal_competitors", {
  id: text("id").primaryKey(), dealId: integer("deal_id").notNull().references(()=>deals.id), competitorId: text("competitor_id").notNull().references(()=>competitors.id), outcome: text("outcome").notNull().default("Open"), reason: text("reason").notNull().default(""), mentionedAt: text("mentioned_at").notNull(), source: text("source").notNull().default("Manual"), createdBy: text("created_by").notNull(),
}, t => [uniqueIndex("deal_competitors_pair").on(t.dealId,t.competitorId),index("deal_competitors_outcome").on(t.competitorId,t.outcome)]);

export const serviceCases = sqliteTable("service_cases", {
  id: text("id").primaryKey(), caseNumber: text("case_number").notNull(), parentCaseId: text("parent_case_id"), source: text("source").notNull().default("Manual"), subject: text("subject").notNull(), description: text("description").notNull().default(""), priority: text("priority").notNull().default("Normal"), queue: text("queue").notNull().default("General"), status: text("status").notNull().default("New"), owner: text("owner").notNull().default(""), skillsJson: text("skills_json").notNull().default("[]"), contactId: integer("contact_id").references(()=>contacts.id), companyId: integer("company_id").references(()=>companies.id), dealId: integer("deal_id").references(()=>deals.id), product: text("product").notNull().default(""), inboxMessageId: text("inbox_message_id").references(()=>inboxMessages.id), responseDueAt: text("response_due_at"), resolutionDueAt: text("resolution_due_at"), firstRespondedAt: text("first_responded_at"), resolvedAt: text("resolved_at"), escalatedAt: text("escalated_at"), escalationReason: text("escalation_reason").notNull().default(""), portalVisible: integer("portal_visible",{mode:"boolean"}).notNull().default(true), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("service_cases_number").on(t.caseNumber),index("service_cases_queue_status").on(t.queue,t.status),index("service_cases_sla").on(t.responseDueAt,t.resolutionDueAt)]);
export const caseNotes = sqliteTable("case_notes", {
  id: text("id").primaryKey(), caseId: text("case_id").notNull().references(()=>serviceCases.id), body: text("body").notNull(), internal: integer("internal",{mode:"boolean"}).notNull().default(true), author: text("author").notNull(), createdAt: text("created_at").notNull(),
}, t => [index("case_notes_case_date").on(t.caseId,t.createdAt)]);
export const knowledgeArticles = sqliteTable("knowledge_articles", {
  id: text("id").primaryKey(), title: text("title").notNull(), slug: text("slug").notNull(), summary: text("summary").notNull().default(""), body: text("body").notNull(), category: text("category").notNull().default("General"), status: text("status").notNull().default("Draft"), audience: text("audience").notNull().default("Customers"), owner: text("owner").notNull(), publishedAt: text("published_at"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, t => [uniqueIndex("knowledge_articles_slug").on(t.slug),index("knowledge_articles_status").on(t.status,t.category)]);
export const customerPortalAccess = sqliteTable("customer_portal_access", {
  id: text("id").primaryKey(), companyId: integer("company_id").notNull().references(()=>companies.id), contactId: integer("contact_id").notNull().references(()=>contacts.id), tokenHash: text("token_hash").notNull(), status: text("status").notNull().default("Active"), permissionsJson: text("permissions_json").notNull().default("[\"cases\",\"documents\",\"onboarding\",\"knowledge\"]"), expiresAt: text("expires_at"), lastUsedAt: text("last_used_at"), createdAt: text("created_at").notNull(),
}, t => [uniqueIndex("customer_portal_token").on(t.tokenHash),index("customer_portal_company").on(t.companyId)]);
export const fieldCaptures = sqliteTable("field_captures", {
  id: text("id").primaryKey(), type: text("type").notNull(), status: text("status").notNull().default("Captured"), contactId: integer("contact_id").references(()=>contacts.id), companyId: integer("company_id").references(()=>companies.id), note: text("note").notNull().default(""), audioObjectKey: text("audio_object_key"), attachmentObjectKey: text("attachment_object_key"), latitude: text("latitude"), longitude: text("longitude"), accuracy: integer("accuracy"), capturedBy: text("captured_by").notNull(), capturedAt: text("captured_at").notNull(), syncedAt: text("synced_at"),
}, t => [index("field_captures_user_date").on(t.capturedBy,t.capturedAt)]);

export const communicationReviewItems = sqliteTable("communication_review_items", {
  id:text("id").primaryKey(), source:text("source").notNull(), sourceId:text("source_id"), kind:text("kind").notNull().default("Unknown contact"), status:text("status").notNull().default("Pending"), senderEmail:text("sender_email").notNull().default(""), senderName:text("sender_name").notNull().default(""), subject:text("subject").notNull().default(""), evidenceJson:text("evidence_json").notNull().default("{}"), suggestedContactJson:text("suggested_contact_json").notNull().default("{}"), companyCandidatesJson:text("company_candidates_json").notNull().default("[]"), dealCandidatesJson:text("deal_candidates_json").notNull().default("[]"), contactId:integer("contact_id").references(()=>contacts.id), companyId:integer("company_id").references(()=>companies.id), dealId:integer("deal_id").references(()=>deals.id), confidence:integer("confidence").notNull().default(0), createdAt:text("created_at").notNull(), reviewedAt:text("reviewed_at"), reviewedBy:text("reviewed_by"),
}, t=>[uniqueIndex("communication_review_source").on(t.source,t.sourceId,t.kind),index("communication_review_status_date").on(t.status,t.createdAt)]);

export const actionUndoLog = sqliteTable("action_undo_log", {
  id:text("id").primaryKey(), action:text("action").notNull(), entityType:text("entity_type").notNull(), entityId:text("entity_id").notNull(), beforeJson:text("before_json").notNull().default("{}"), afterJson:text("after_json").notNull().default("{}"), actor:text("actor").notNull(), expiresAt:text("expires_at").notNull(), undoneAt:text("undone_at"), createdAt:text("created_at").notNull(),
}, t=>[index("action_undo_actor_date").on(t.actor,t.createdAt),index("action_undo_expiry").on(t.expiresAt,t.undoneAt)]);

export const rateLimits = sqliteTable("rate_limits", {
  key:text("key").primaryKey(), windowStart:integer("window_start").notNull(), count:integer("count").notNull().default(0),
}, t=>[index("rate_limits_window").on(t.windowStart)]);
