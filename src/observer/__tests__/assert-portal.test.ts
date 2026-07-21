import { describe, it, expect } from 'vitest';
import type { VerificationSnapshot } from '@almadar/core';
import { assertPortalSlots } from '../assert-portal.js';
import type { Frame, FrameCause } from '../../frame/types.js';
import type { PortalSlot } from '../../browser/portal-slots.js';

const emptySnapshot: VerificationSnapshot = {
  checks: [],
  transitions: [],
  bridge: null,
  summary: { totalChecks: 0, passed: 0, failed: 0, warnings: 0, pending: 0 },
  traits: [],
};

const cause = (trait: string): FrameCause => ({
  traitName: trait,
  from: 'closed',
  event: 'INIT',
  to: 'closed',
  guardCase: null,
  triggerKind: 'auto-init',
  isRepositioning: false,
});

function frame(
  index: number,
  traitName: string,
  portals: ReadonlyArray<{ slot: PortalSlot; mounted: boolean; childCount: number }>,
): Frame {
  return {
    index,
    timestamp: 1000 + index,
    cause: cause(traitName),
    stateBefore: 'closed',
    stateAfter: 'closed',
    payload: {},
    eventFired: 'INIT',
    runtimeSnapshot: emptySnapshot,
    domSnapshot: { url: '', rowsByEntity: {}, portals, visibleTextSample: '' },
    consoleDelta: { added: [], newErrors: 0, newWarnings: 0 },
    eventLogDelta: { added: [] },
    entityChanges: [],
    effectResults: [],
    serverResponse: null,
    screenshotPath: null,
    accepted: true,
    errors: [],
    warnings: [],
  };
}

describe('assertPortalSlots', () => {
  it('fails when main is mounted but empty and the trait is not exempt', () => {
    const frames = [frame(0, 'SomeBrowse', [{ slot: 'main', mounted: true, childCount: 0 }])];
    const verdict = assertPortalSlots(frames);
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain('main');
  });

  it('passes when main is mounted but empty on a schema-exempt (portal-only) trait', () => {
    // Mirrors std-modal: its INIT transition never authors a render-ui
    // into `main` (it only ever renders its own detail/portal slot from a
    // later OPEN) — the caller derives this exemption from the schema
    // (traitBootRenderSlots), not a name list.
    const frames = [frame(0, 'ModalRecordModal', [{ slot: 'main', mounted: true, childCount: 0 }])];
    const verdict = assertPortalSlots(frames, { mainExemptTraits: new Set(['ModalRecordModal']) });
    expect(verdict.passed).toBe(true);
  });

  it('still fails a non-main slot mounted empty on a main-exempt trait', () => {
    // The exemption is scoped to `main` only — a trait that DOES author a
    // render (e.g. into `modal`) and paints nothing must still fail.
    const frames = [frame(0, 'ModalRecordModal', [{ slot: 'modal', mounted: true, childCount: 0 }])];
    const verdict = assertPortalSlots(frames, { mainExemptTraits: new Set(['ModalRecordModal']) });
    expect(verdict.passed).toBe(false);
    expect(verdict.detail).toContain('modal');
  });

  it('still fails main mounted-empty on a trait that DOES author a main render at boot', () => {
    const frames = [frame(0, 'BrowseItemBrowse', [{ slot: 'main', mounted: true, childCount: 0 }])];
    // BrowseItemBrowse is not in mainExemptTraits — it authors main at boot.
    const verdict = assertPortalSlots(frames, { mainExemptTraits: new Set(['ModalRecordModal']) });
    expect(verdict.passed).toBe(false);
  });

  it('passes when an OPTIONAL_LAYOUT_SLOTS slot (sidebar) is mounted but empty', () => {
    const frames = [frame(0, 'AnyTrait', [{ slot: 'sidebar', mounted: true, childCount: 0 }])];
    const verdict = assertPortalSlots(frames);
    expect(verdict.passed).toBe(true);
  });

  it('passes for a lifecycle noRenderTraits trait regardless of which slot is empty', () => {
    const frames = [frame(0, 'AuditCapture', [{ slot: 'main', mounted: true, childCount: 0 }])];
    const verdict = assertPortalSlots(frames, { noRenderTraits: new Set(['AuditCapture']) });
    expect(verdict.passed).toBe(true);
  });

  it('passes when main is mounted with content', () => {
    const frames = [frame(0, 'BrowseItemBrowse', [{ slot: 'main', mounted: true, childCount: 3 }])];
    const verdict = assertPortalSlots(frames);
    expect(verdict.passed).toBe(true);
  });
});
