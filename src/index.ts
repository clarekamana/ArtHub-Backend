import { app } from "./app";
import { env } from "./config/env";

app.listen(env.port, () => {
  console.log(`ArtHub API listening on port ${env.port} [${env.nodeEnv}]`);
});

// Render's free tier has no long-running Background Worker instance type, so on
// that plan the single free web service also runs the BullMQ workers in-thread.
// Set ENABLE_WORKERS=false (and run `npm run worker` / `npm run worker:lifecycle`
// as separate paid services) once budget allows dedicated workers.
if (env.enableInProcessWorkers) {
  console.log("ENABLE_WORKERS=true: starting conversion + lifecycle workers in-process");
  import("./workers/conversion.worker");
  import("./workers/lifecycle.worker");
}
