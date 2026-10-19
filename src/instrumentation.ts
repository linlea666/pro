export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startJobs } = await import("./lib/server/jobs");
    startJobs();
  }
}

export async function onRequestError(err: unknown, request: { path: string; method: string }, context: { routePath?: string; routeType?: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("./lib/server/log");
  logger.error("http", `页面渲染出错 ${request.method} ${request.path}`, { error: err, route: context.routePath, type: context.routeType });
}
