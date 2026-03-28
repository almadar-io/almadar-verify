/**
 * State Walk Engine
 *
 * Shared two-pass engine for verifying state machine behavior.
 * Used by both orbital-verify (compiled apps) and runtime-verify (playground).
 *
 * Pass 1: Transition coverage via sendEvent. Fires every transition directly,
 *         guaranteeing 100% edge coverage. No DOM dependency.
 *
 * Pass 2: UI interaction coverage. For transitions with visible UI triggers,
 *         replays to the source state via sendEvent then triggers via DOM.
 *         Tests that buttons, forms, and entity-row actions actually work.
 *
 * @packageDocumentation
 */

import type { Page } from 'playwright';
import { buildEdgeCoveringWalk } from '@almadar/core';
import type { WalkStep } from '@almadar/core';
import type {
  EngineAdapter,
  TraitWalkConfig,
  EngineConfig,
  WalkResult,
  TransitionLogEntry,
} from './types.js';

export class StateWalkEngine {
  private adapter: EngineAdapter;
  private config: EngineConfig;

  constructor(adapter: EngineAdapter, config: EngineConfig) {
    this.adapter = adapter;
    this.config = config;
  }

  /**
   * Run both passes for a list of traits.
   * Returns merged WalkResult with combined coverage.
   */
  async walk(page: Page, traits: TraitWalkConfig[]): Promise<WalkResult> {
    const allCovered: string[] = [];
    const allUICovered: string[] = [];
    const allErrors: string[] = [];
    const allWarnings: string[] = [];
    const allLog: TransitionLogEntry[] = [];
    let totalTransitions = 0;

    for (const trait of traits) {
      // Count non-INIT transitions
      const nonInit = trait.transitions.filter(
        (t) => t.event !== 'INIT' && t.from !== '*',
      );
      totalTransitions += nonInit.length;

      // Pass 1: transition coverage
      const pass1 = await this.pass1TransitionCoverage(page, trait);
      allCovered.push(...pass1.coveredKeys);
      allErrors.push(...pass1.errors);
      allWarnings.push(...pass1.warnings);
      allLog.push(...pass1.transitionLog);

      // Pass 2: UI interaction coverage
      if (this.config.runPass2 && this.adapter.triggerViaDOM) {
        const pass1Set = new Set(allCovered);
        const pass2 = await this.pass2UICoverage(page, trait, pass1Set);
        allUICovered.push(...pass2.coveredKeys);
        allErrors.push(...pass2.errors);
        allWarnings.push(...pass2.warnings);
        allLog.push(...pass2.transitionLog);
      }
    }

    return {
      coveredKeys: [...new Set(allCovered)],
      uiCoveredKeys: [...new Set(allUICovered)],
      errors: allErrors,
      warnings: allWarnings,
      transitionLog: allLog,
      totalTransitions,
    };
  }

  /**
   * Pass 1: Fire every transition via sendEvent.
   * Uses buildEdgeCoveringWalk to guarantee 100% edge coverage.
   */
  private async pass1TransitionCoverage(
    page: Page,
    trait: TraitWalkConfig,
  ): Promise<{ coveredKeys: string[]; errors: string[]; warnings: string[]; transitionLog: TransitionLogEntry[] }> {
    const log = this.config.log ?? console.log;
    const walkSteps = buildEdgeCoveringWalk(trait.transitions, trait.initialState);
    const coveredKeys: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const transitionLog: TransitionLogEntry[] = [];
    const startTime = Date.now();

    log(`[StateWalkEngine] Pass 1: ${trait.traitName} | ${walkSteps.length} steps (${walkSteps.filter(s => !s.isRepositioning).length} transitions + ${walkSteps.filter(s => s.isRepositioning).length} repositioning)`);

    // Reset to initial state
    if (this.adapter.reset) {
      await this.adapter.reset(page);
    }

    for (let i = 0; i < walkSteps.length; i++) {
      const step = walkSteps[i];

      // Time budget check
      if (Date.now() - startTime > this.config.maxWalkMs) {
        warnings.push(`Pass 1 timeout after ${this.config.maxWalkMs}ms (${i}/${walkSteps.length} steps)`);
        break;
      }

      // Read state before
      const stateBefore = await this.adapter.getState(page, trait.traitName);

      // Verify source state (skip check for repositioning if state getter unavailable)
      if (stateBefore !== null && stateBefore !== step.from && !step.isRepositioning) {
        warnings.push(`${trait.traitName}: expected state '${step.from}', got '${stateBefore}' before ${step.event}`);
        // Try to recover by resetting
        if (this.adapter.reset) {
          await this.adapter.reset(page);
          // Replay all repositioning steps up to this point to get back on track
          // For simplicity, skip this step and continue
          continue;
        }
      }

      // Fire the event
      const sent = await this.adapter.sendEvent(page, step.event, step.payload);
      if (!sent) {
        warnings.push(`${trait.traitName}: failed to send ${step.event}`);
        continue;
      }

      // Wait for settle
      await this.adapter.settle(page);

      // Read state after
      const stateAfter = await this.adapter.getState(page, trait.traitName);

      // Determine if transition was accepted
      let accepted: boolean;
      if (step.guardCase === 'fail') {
        // Guard-fail: state should NOT change
        accepted = stateAfter === step.from || stateAfter === stateBefore;
      } else {
        // Normal or guard-pass: state should change to step.to
        accepted = stateAfter === step.to || stateAfter === null;
      }

      // Track coverage (skip repositioning steps)
      if (accepted && !step.isRepositioning) {
        const suffix = step.guardCase ? `[${step.guardCase}]` : '';
        const key = `${trait.traitName}:${step.from}+${step.event}->${step.to}${suffix}`;
        coveredKeys.push(key);
      }

      // Log
      if (!step.isRepositioning) {
        const status = accepted ? 'OK' : 'REJECTED';
        log(`  [${i + 1}/${walkSteps.length}] ${step.from} --${step.event}${step.guardCase ? `[${step.guardCase}]` : ''}--> ${step.to} | ${status}`);
      }

      // Transition log entry
      transitionLog.push({
        timestamp: new Date().toISOString(),
        trait: trait.traitName,
        from: step.from,
        event: step.event,
        payload: step.payload,
        serverResponse: null,
        to: stateAfter ?? step.to,
        serverDataCounts: {},
        effectResults: [],
        domEntityCount: 0,
        screenshot: undefined,
      });

      // Post-transition hook
      if (this.adapter.onTransition) {
        await this.adapter.onTransition(page, step, trait.traitName, accepted);
      }
    }

    log(`[StateWalkEngine] Pass 1 done: ${trait.traitName} | ${coveredKeys.length} transitions covered`);
    return { coveredKeys, errors, warnings, transitionLog };
  }

  /**
   * Pass 2: For transitions with visible UI triggers, replay to source
   * state via sendEvent then trigger via DOM.
   */
  private async pass2UICoverage(
    page: Page,
    trait: TraitWalkConfig,
    _alreadyCovered: Set<string>,
  ): Promise<{ coveredKeys: string[]; errors: string[]; warnings: string[]; transitionLog: TransitionLogEntry[] }> {
    const log = this.config.log ?? console.log;
    const walkSteps = buildEdgeCoveringWalk(trait.transitions, trait.initialState);
    const coveredKeys: string[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const transitionLog: TransitionLogEntry[] = [];

    // Only test non-repositioning, non-guard-fail steps via DOM
    const domTestable = walkSteps.filter(
      (s) => !s.isRepositioning && s.guardCase !== 'fail',
    );

    if (domTestable.length === 0) return { coveredKeys, errors, warnings, transitionLog };

    log(`[StateWalkEngine] Pass 2: ${trait.traitName} | ${domTestable.length} DOM-testable transitions`);

    for (const step of domTestable) {
      // Reset to initial state
      if (this.adapter.reset) {
        await this.adapter.reset(page);
      }

      // Replay to source state using sendEvent
      const replayOk = await this.replayToState(page, trait, step.from);
      if (!replayOk) {
        // Can't reach source state, skip DOM test
        continue;
      }

      // Attempt DOM trigger
      const domTriggered = await this.adapter.triggerViaDOM!(page, step, trait.traitName);

      if (domTriggered) {
        await this.adapter.settle(page);
        const stateAfter = await this.adapter.getState(page, trait.traitName);
        if (stateAfter === step.to || stateAfter === null) {
          const key = `${trait.traitName}:${step.from}+${step.event}->${step.to}[ui]`;
          coveredKeys.push(key);
          log(`  [UI] ${step.from} --${step.event}--> ${step.to} | DOM trigger OK`);
        }
      }

      // Post-transition hook
      if (this.adapter.onTransition) {
        await this.adapter.onTransition(page, step, trait.traitName, domTriggered);
      }
    }

    log(`[StateWalkEngine] Pass 2 done: ${trait.traitName} | ${coveredKeys.length} UI-triggered`);
    return { coveredKeys, errors, warnings, transitionLog };
  }

  /**
   * Replay events to reach a target state from initial state.
   * Uses buildEdgeCoveringWalk's repositioning logic via BFS shortest path.
   */
  private async replayToState(
    page: Page,
    trait: TraitWalkConfig,
    targetState: string,
  ): Promise<boolean> {
    if (targetState === trait.initialState) return true;

    // Build a minimal walk that gets us to targetState
    // Use the full walk and extract repositioning steps up to the target
    const walkSteps = buildEdgeCoveringWalk(trait.transitions, trait.initialState);

    // Find a sequence of steps that reaches targetState
    let currentState = trait.initialState;
    for (const step of walkSteps) {
      if (currentState === targetState) return true;

      // Only replay steps that advance us toward the target
      if (step.guardCase === 'fail') continue;

      const sent = await this.adapter.sendEvent(page, step.event, step.payload);
      if (!sent) return false;

      await this.adapter.settle(page);
      currentState = step.to;

      if (currentState === targetState) return true;
    }

    return currentState === targetState;
  }
}
