// Shared CRM record shapes used by the client workspaces.

/** Loosely typed API row (snake_case columns straight from D1). */
export type Row=Record<string,unknown>;

/** Contact as returned by GET /api/crm (camelCase). */
export type Contact={id:number;firstName:string;lastName:string;email:string;company:string;title:string;phone?:string;location?:string;notes?:string;leadSource?:string;stage:string;tags:string[];lastContact:string|null;nextFollowUp:string|null;subscribed:boolean;suppressionReason?:string|null;suppressedAt?:string|null;createdAt?:string};
/** Minimal contact reference used by pickers. */
export type ContactRef=Pick<Contact,"id"|"firstName"|"lastName"|"email"|"company">;
/** Contact as returned by /api/sales and related workspaces (single display name). */
export type ContactSummary={id:number;name:string;email:string;company:string;title:string};

export type Activity={id:number;contactId:number;type:string;note:string;happenedAt:string;contactName?:string};
export type CampaignEvent={id:number;campaignId:number;type:string;recipient:string|null;occurredAt:string;campaignName:string;subject:string};
export type Duplicate={a:number;b:number;reason:string};

/** Deal as returned by /api/sales (snake_case). */
export type SalesDeal={id:number;name:string;company:string;company_id:number|null;contact_id:number|null;stage:string;stage_key:string|null;pipeline_key:string;owner:string;value:number;probability:number;next_step:string;close_date:string;lead_source:string;campaign:string;partner:string;forecast_category:string;closed_reason:string;stage_entered_at:string;status:string;resolved_company_id?:number|null};
/** Minimal deal reference used by pickers. */
export type DealRef=Pick<SalesDeal,"id"|"name"|"company">;

/** Sender identity from GET /api/crm `brand` (empty strings when unset). */
export type Brand={businessName:string;fromName:string;physicalAddress:string;sendingDomain:string;logoUrl:string};
