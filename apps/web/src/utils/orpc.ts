import type { AppRouterClient } from "@ishigama-search/api/routers/index";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { getRequestEvent } from "@solidjs/web";

import { ENV } from "../env.public";

const link = new RPCLink({
  url: `${ENV.VITE_SERVER_URL.replace(/\/$/, "")}/rpc`,
  headers: () => getRequestEvent()?.request.headers ?? {},
});

export const client: AppRouterClient = createORPCClient(link);
