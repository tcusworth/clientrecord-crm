import { env } from "cloudflare:workers";
function clean(value: unknown, fallback = "") { return typeof value === "string" ? value.trim() : fallback; }
async function readAll() {
  const [contacts, activities, tasks, campaigns] = await Promise.all([
    env.DB.prepare("SELECT id, first_name AS firstName, last_name AS lastName, email, company, title, stage, tags, last_contact AS lastContact, next_follow_up AS nextFollowUp, subscribed FROM contacts ORDER BY last_name, first_name").all(),
    env.DB.prepare("SELECT a.id, a.contact_id AS contactId, a.type, a.note, a.happened_at AS happenedAt, c.first_name || ' ' || c.last_name AS contactName FROM activities a JOIN contacts c ON c.id = a.contact_id ORDER BY a.happened_at DESC LIMIT 100").all(),
    env.DB.prepare("SELECT t.id, t.contact_id AS contactId, t.title, t.due_date AS dueDate, t.completed, c.first_name || ' ' || c.last_name AS contactName FROM tasks t JOIN contacts c ON c.id = t.contact_id ORDER BY t.completed, t.due_date").all(),
    env.DB.prepare("SELECT id, name, subject, status, audience, recipient_count AS recipientCount, created_at AS createdAt FROM campaigns ORDER BY created_at DESC").all(),
  ]);
  return { contacts: contacts.results.map((c: Record<string, unknown>) => ({ ...c, tags: JSON.parse(String(c.tags || "[]")), subscribed: Boolean(c.subscribed) })), activities: activities.results, tasks: tasks.results.map((t: Record<string, unknown>) => ({ ...t, completed: Boolean(t.completed) })), campaigns: campaigns.results };
}
export async function GET() { try { return Response.json(await readAll()); } catch { return Response.json({ error: "CRM data is temporarily unavailable." }, { status: 503 }); } }
export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "createContact") {
      const firstName=clean(body.firstName), lastName=clean(body.lastName), email=clean(body.email).toLowerCase(); if (!firstName || !lastName || !email) return Response.json({error:"Name and email are required."},{status:400});
      const result = await env.DB.prepare("INSERT INTO contacts (first_name,last_name,email,company,title,stage,tags,subscribed,created_at) VALUES (?,?,?,?,?,?,?,1,datetime('now'))").bind(firstName,lastName,email,clean(body.company),clean(body.title),clean(body.stage,"Lead"),"[]").run(); return Response.json({id:result.meta.last_row_id},{status:201});
    }
    if (body.action === "createActivity") {
      const contactId=Number(body.contactId), note=clean(body.note), type=clean(body.type,"Note"), today=new Date().toISOString(); if (!contactId || !note) return Response.json({error:"Contact and note are required."},{status:400});
      const statements=[env.DB.prepare("INSERT INTO activities (contact_id,type,note,happened_at) VALUES (?,?,?,?)").bind(contactId,type,note,today), env.DB.prepare("UPDATE contacts SET last_contact=? WHERE id=?").bind(today.slice(0,10),contactId)];
      const next=clean(body.nextFollowUp); if(next){statements.push(env.DB.prepare("INSERT INTO tasks (contact_id,title,due_date,completed) VALUES (?,?,?,0)").bind(contactId,"Follow up after "+type.toLowerCase(),next),env.DB.prepare("UPDATE contacts SET next_follow_up=? WHERE id=?").bind(next,contactId));} await env.DB.batch(statements); return Response.json({status:"created"},{status:201});
    }
    if (body.action === "bulkImportContacts") {
      const contacts=Array.isArray(body.contacts)?body.contacts as Array<Record<string,unknown>>:[];if(!contacts.length||contacts.length>2000)return Response.json({error:"Import between 1 and 2,000 contacts at a time."},{status:400});
      const prepared=contacts.map(contact=>{const firstName=clean(contact.firstName),lastName=clean(contact.lastName),email=clean(contact.email).toLowerCase();if(!firstName||!lastName||!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))throw new Error("INVALID_IMPORT_ROW");const tags=Array.isArray(contact.tags)?contact.tags.map(tag=>clean(tag)).filter(Boolean):[];return env.DB.prepare("INSERT INTO contacts (first_name,last_name,email,company,title,stage,tags,subscribed,created_at) VALUES (?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(email) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,company=excluded.company,title=excluded.title,stage=excluded.stage,tags=excluded.tags,subscribed=excluded.subscribed").bind(firstName,lastName,email,clean(contact.company),clean(contact.title),clean(contact.stage,"Lead"),JSON.stringify(tags),contact.subscribed===false?0:1)});
      for(let i=0;i<prepared.length;i+=100)await env.DB.batch(prepared.slice(i,i+100));return Response.json({imported:prepared.length},{status:201});
    }
    if (body.action === "completeTask") { await env.DB.prepare("UPDATE tasks SET completed=1 WHERE id=?").bind(Number(body.id)).run(); return Response.json({status:"completed"}); }
    if (body.action === "createCampaign") { const name=clean(body.name), subject=clean(body.subject), audience=clean(body.audience,"All subscribed contacts"); if(!name||!subject)return Response.json({error:"Campaign name and subject are required."},{status:400}); const result=await env.DB.prepare("INSERT INTO campaigns (name,subject,status,audience,recipient_count,created_at) VALUES (?,?,'Draft',?,?,date('now'))").bind(name,subject,audience,Number(body.recipientCount)||0).run(); return Response.json({id:result.meta.last_row_id},{status:201}); }
    return Response.json({error:"Unknown action."},{status:400});
  } catch (error) { const message=error instanceof Error&&error.message.includes("UNIQUE")?"A contact with that email already exists.":"The CRM could not save that change."; return Response.json({error:message},{status:500}); }
}
