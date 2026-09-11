export { cloneDirectory, reflinkFile } from "./clone";
export { cloneFile, isDarwin, type CloneFile, type PlatformCheck } from "./platform";
export { cloneFileOnDarwin, type CloneOutcome, type DarwinCloneSyscall } from "./platform-darwin";
export { probeCowCapability, type CowCapability } from "./capability";
export { cowStrategy } from "./strategy";
export { spawnWorkspace } from "./tool";
export { fallbackPolicy } from "./config";
export type {
  FallbackPolicy,
  SpawnWorkspaceDeps,
  SpawnWorkspaceInput,
  SpawnWorkspaceResult,
} from "./tool";
export type { Mechanism } from "./mechanism";
export { default } from "./plugin";
