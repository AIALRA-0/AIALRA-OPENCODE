import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const services = await createApp(config);

const shutdown = async () => {
  await services.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await services.app.listen({ host: config.host, port: config.port });
} catch (error) {
  services.app.log.error(error);
  await services.close();
  process.exit(1);
}
