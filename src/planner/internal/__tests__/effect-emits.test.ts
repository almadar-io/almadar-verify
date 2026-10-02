import { describe, it, expect } from 'vitest';
import type { Effect } from '@almadar/core';
import { collectEffectEmittedEvents } from '../effect-emits.js';

const callTools = (emit: Record<string, string>): Effect => ['call-service', 'llm', 'call-tools', {}, { emit }];

describe('collectEffectEmittedEvents', () => {
  it('a call-service live message is not an outcome emit', () => {
    const events = collectEffectEmittedEvents([{ effects: [callTools({ onMessage: 'STEP', success: 'REPLIED', failure: 'FAILED' })] }]);
    expect([...events].sort()).toEqual(['FAILED', 'REPLIED']);
  });

  it('control: fetch success/failure outcomes are collected', () => {
    const events = collectEffectEmittedEvents([{ effects: [['fetch', 'Task', { emit: { success: 'Loaded', failure: 'LoadFailed' } }]] }]);
    expect([...events].sort()).toEqual(['LoadFailed', 'Loaded']);
  });
});
