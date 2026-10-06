// Business-rule failure with the HTTP status a route should return.
export class ServiceError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.name = "ServiceError"; this.status = status; } }
