/**
 * The platform seam of the native drivers: read the accessibility tree, tap,
 * type, take a screenshot, relaunch. iOS speaks to the XCUITest verify driver
 * over HTTP; Android shells out to `adb`. Both are injected as interfaces.
 *
 * @packageDocumentation
 */

import type { NativeElement } from './tree.js';

export interface NativeDevice {
  readTree(): Promise<NativeElement[]>;
  /** `within` is a container id (`row-<id>`) the id is searched under. False when no such element is on screen or it cannot be tapped. */
  tap(element: NativeElement, within?: string): Promise<boolean>;
  /** Replaces the field's content with `text`. False when the field cannot be focused. */
  typeText(element: NativeElement, text: string, within?: string): Promise<boolean>;
  screenshot(path: string): Promise<void>;
  /** `env` is merged over the launch environment (iOS) or passed as launch extras (Android) for this launch only. */
  relaunch(env?: Readonly<Record<string, string>>): Promise<void>;
}
