import { installLegacyEventBridge } from './legacy-events.js';
import { migratePreferences } from './browser-state-migration.js';
export let preferenceMigrationError: unknown;
if (typeof window !== 'undefined') {
  installLegacyEventBridge();
  try { migratePreferences(localStorage); migratePreferences(sessionStorage); }
  catch (error) { preferenceMigrationError = error; }
}
