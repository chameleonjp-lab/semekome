import { validatePlayerName } from '../input/session-clock.ts';
import { validateSupplyAllocation } from '../logistics/supply-schedule.ts';
import { validateMatchOptions, type MatchPreset, type Difficulty } from '../content/match-presets.ts';
import { validateSupportTypes, type SupportType } from '../content/support-types.ts';
import { SUPPLY_BAG, type CaseType } from '../content/cases.ts';
export interface GamePreferences {
  version: 1;
  name: string;
  preset: MatchPreset;
  difficulty: Difficulty;
  allocation: CaseType[];
  supports: [SupportType, SupportType];
  sound: boolean;
  practiceCompleted: string[];
}
export const defaultPreferences = (): GamePreferences => ({ version: 1, name: '', preset: 'standard', difficulty: 'standard',
  allocation: [...SUPPLY_BAG], supports: ['carrier', 'carrier'], sound: false, practiceCompleted: [] });
export function parsePreferences(raw: string | null): GamePreferences {
  if (!raw || raw.length > 20_000) return defaultPreferences();
  try {
    const value = JSON.parse(raw);
    if (value.version !== 1 || typeof value.name !== 'string' || !Array.isArray(value.practiceCompleted) ||
        value.practiceCompleted.some((item: unknown) => !['transport', 'interception', 'core'].includes(String(item))) || typeof value.sound !== 'boolean') throw new Error('Unsupported preferences');
    const validated = validateMatchOptions(value.preset, value.difficulty);
    const name = validatePlayerName(value.name);
    return { version: 1, name: name.error ? '' : name.name, ...validated,
      allocation: validateSupplyAllocation(value.allocation), supports: validateSupportTypes(value.supports),
      sound: value.sound, practiceCompleted: [...new Set<string>(value.practiceCompleted)] };
  } catch { return defaultPreferences(); }
}
export function loadPreferences(): GamePreferences { try { return parsePreferences(localStorage.getItem('semekome-preferences')); } catch { return defaultPreferences(); } }
export function savePreferences(value: GamePreferences): boolean {
  try { localStorage.setItem('semekome-preferences', JSON.stringify(value)); return true; } catch { return false; }
}
