import type { AuthConfig } from "convex/server";

export default {
  providers: process.env.CLERK_FRONTEND_API_URL ? [
    {
      domain: process.env.CLERK_FRONTEND_API_URL!,
      applicationID: "convex",
    },
  ] : [],
} satisfies AuthConfig;
