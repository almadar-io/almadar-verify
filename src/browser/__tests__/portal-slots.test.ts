import { describe, it, expect } from 'vitest';
import { RENDERED_SLOTS } from '@almadar/core';
import { PORTAL_SLOTS, isPortalSlot } from '../portal-slots.js';

describe('PORTAL_SLOTS', () => {
  it('probes exactly the slots the renderer mounts, the dock included', () => {
    expect([...PORTAL_SLOTS]).toEqual([...RENDERED_SLOTS]);
    expect(isPortalSlot('dock')).toBe(true);
  });

  it('control: a slot no renderer mounts is not probed', () => {
    expect(isPortalSlot('hud-left')).toBe(false);
    expect(isPortalSlot('hud.health')).toBe(false);
  });
});
