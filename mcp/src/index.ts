import OAuthProvider from "@cloudflare/workers-oauth-provider";
import authHandler, { type AuthEnv } from "./auth-handler";
import { handleMcp } from "./mcp-handler";

// The provider validates the bearer token and puts the grant's props (set at consent: { email, clientName }) on ctx.props.
const mcpApi = { async fetch(request: Request, env: AuthEnv, ctx: ExecutionContext) {
  const props = ctx.props as { email?: string; clientName?: string } | undefined;
  const email = props?.email; if (!email) return new Response("Unauthorized", { status: 401 });
  return handleMcp(request, env, { email, clientName: props?.clientName });
} };

const provider = new OAuthProvider<AuthEnv>({
  apiRoute: "/mcp",
  apiHandler: mcpApi,
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
});
export default provider;
