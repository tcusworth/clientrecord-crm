import { env } from "cloudflare:workers";

export type ContactList={id:number;name:string;memberCount:number;subscribedCount:number;createdAt:string};
type Row=Record<string,unknown>;
export async function listContactLists():Promise<ContactList[]>{
  const rows=(await env.DB.prepare("SELECT l.id,l.name,l.created_at AS createdAt,count(m.contact_id) AS memberCount,COALESCE(sum(c.subscribed=1),0) AS subscribedCount FROM contact_lists l LEFT JOIN contact_list_members m ON m.list_id=l.id LEFT JOIN contacts c ON c.id=m.contact_id GROUP BY l.id ORDER BY l.name COLLATE NOCASE").all<Row>()).results||[];
  return rows.map(r=>({id:Number(r.id),name:String(r.name),memberCount:Number(r.memberCount),subscribedCount:Number(r.subscribedCount),createdAt:String(r.createdAt)}));
}
export async function listMembers(listId:number){
  const rows=(await env.DB.prepare("SELECT c.id AS contactId,c.first_name AS firstName,c.last_name AS lastName,c.email,c.subscribed,m.added_at AS addedAt,m.source FROM contact_list_members m JOIN contacts c ON c.id=m.contact_id WHERE m.list_id=? ORDER BY m.added_at DESC,c.id").bind(listId).all<Row>()).results||[];
  return rows.map(r=>({contactId:Number(r.contactId),name:`${r.firstName} ${r.lastName}`.trim(),email:String(r.email),subscribed:Boolean(r.subscribed),addedAt:String(r.addedAt),source:String(r.source)}));
}
export async function listMemberIds(listId:number){
  const rows=(await env.DB.prepare("SELECT contact_id AS id FROM contact_list_members WHERE list_id=?").bind(listId).all<Row>()).results||[];
  return new Set(rows.map(r=>Number(r.id)));
}
export async function removeListMember(listId:number,contactId:number){await env.DB.prepare("DELETE FROM contact_list_members WHERE list_id=? AND contact_id=?").bind(listId,contactId).run()}
export async function renameList(listId:number,name:string){
  const clean=name.trim();if(clean.length<1||clean.length>120)throw new Error("List name must be 1–120 characters.");
  try{await env.DB.prepare("UPDATE contact_lists SET name=? WHERE id=?").bind(clean,listId).run()}
  catch(error){if(error instanceof Error&&error.message.includes("UNIQUE constraint failed"))throw new Error("A list with that name already exists.");throw error}
}
export async function deleteList(listId:number){
  await env.DB.batch([env.DB.prepare("DELETE FROM contact_list_members WHERE list_id=?").bind(listId),env.DB.prepare("DELETE FROM contact_lists WHERE id=?").bind(listId)]);
}
