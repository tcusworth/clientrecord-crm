declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    BUCKET: R2Bucket;
    RESEND_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
    RESEND_WEBHOOK_SECRET?: string;
    CRM_ALLOWED_EMAILS?: string;
    CRM_TOKEN_ENCRYPTION_KEY?: string;
    MS_CLIENT_ID?: string;
    MS_CLIENT_SECRET?: string;
    MS_TENANT_ID?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    OPENAI_API_KEY?: string;
  }
}
