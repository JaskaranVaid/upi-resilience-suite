import { configureMdrEffectiveFrom } from '../src/config/rules.js';

// Scenario tests model the MDR regime as originally announced (15 Oct 2026). Production starts
// with no MDR until MDR_EFFECTIVE_FROM is set; test/rules/windows.test.ts covers that default.
configureMdrEffectiveFrom('2026-10-15');
