export type NavItem = { id: string; label: string };
export type NavGroup = { id: "main" | "more" | "admin"; label: string; items: NavItem[] };

export const navGroups: NavGroup[] = [
  { id: "main", label: "", items: [{ id: "today", label: "Today" }, { id: "deals", label: "Deals" }, { id: "companies", label: "Companies" }, { id: "contacts", label: "Contacts" }, { id: "leads", label: "Lead capture" }, { id: "proposals", label: "Proposals" }, { id: "customers", label: "Customer success" }, { id: "documents", label: "Documents" }, { id: "activities", label: "Activity" }, { id: "service", label: "Service cases" }, { id: "reports", label: "Sales analytics" }] },
  { id: "more", label: "More", items: [{ id: "connections", label: "Email & calendar" }, { id: "dashboard", label: "Dashboard" }, { id: "inbox", label: "Inbox" }, { id: "communication-review", label: "Communication review" }, { id: "campaigns", label: "Campaigns" }, { id: "audiences", label: "Audiences" }, { id: "automations", label: "Automations" }, { id: "partners", label: "Partners" }, { id: "competitive", label: "Competitive intel" }, { id: "field", label: "Field capture" }] },
  { id: "admin", label: "Admin", items: [{ id: "integrations", label: "Integrations" }, { id: "operations", label: "Operations" }, { id: "settings", label: "Settings" }, { id: "cleanup", label: "Cleanup" }, { id: "custom-objects", label: "Custom objects" }, { id: "ai-governance", label: "AI Governance" }] },
];

const ALIASES: Record<string, string> = { pipelines: "deals" };
const ALL = new Set(navGroups.flatMap(g => g.items.map(i => i.id)));
export function resolveSection(id: string | null): string | null {
  if (!id) return null;
  const target = ALIASES[id] ?? id;
  return ALL.has(target) ? target : null;
}
