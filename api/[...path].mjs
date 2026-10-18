// Vercel Functions entry point. Every /api/* request is routed here and handed
// to the same request handler used by the local Node server.
import { handler } from "../web/server/index.mjs";

export default handler;
