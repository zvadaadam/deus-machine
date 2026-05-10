import { stageRuntime } from "./stage";

try {
  console.log("Staging shared runtime...\n");
  const manifest = stageRuntime();
  console.log(`\n✓ Runtime manifest written (${manifest.version})`);
} catch (error) {
  console.error("Runtime staging failed:", error);
  process.exit(1);
}
