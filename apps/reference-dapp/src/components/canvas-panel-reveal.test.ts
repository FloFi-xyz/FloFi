// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PANEL_SAFE_BOTTOM, PANEL_SAFE_SIDE, revealLimit, revealOffset, revealOffsetX } from './canvas-panel-reveal';

// The CI failure geometry (1440×900): pane 256–694, card + open Arbitrum picker 346–634, navigator 632–670 at x 431–655.
const pane = { top: 256, bottom: 694 };
const box = { top: 346, bottom: 634, left: 106, right: 806 };
const navigator = { top: 632, bottom: 670, left: 431, right: 655 };

describe('revealing an open composer panel above the canvas controls', () => {
  it('lifts a panel that reaches the navigator just above it, with the bottom margin as the floor', () => {
    const limit = revealLimit(box, pane, [navigator]);
    expect(limit).toBe(pane.bottom - PANEL_SAFE_BOTTOM);
    expect(revealOffset(box, pane, limit)).toBe(30);
  });
  it('uses a raised control (compact navigator above the call to action) when it is higher than the margin', () => {
    const raised = { top: 560, bottom: 598, left: 431, right: 631 };
    const limit = revealLimit(box, pane, [raised]);
    expect(limit).toBe(552);
    expect(revealOffset(box, pane, limit)).toBe(58); // capped: the card's top stops at the canvas's top margin (256 + 32)
  });
  it('ignores controls that do not overlap the panel horizontally', () => {
    expect(revealLimit(box, pane, [{ top: 560, bottom: 598, left: 900, right: 1050 }])).toBe(pane.bottom - PANEL_SAFE_BOTTOM);
  });
  it('never pans when everything already fits, and never pushes the card above the top margin', () => {
    expect(revealOffset({ top: 300, bottom: 590 }, pane, 604)).toBe(0);
    expect(revealOffset({ top: 288, bottom: 700 }, pane, 604)).toBe(0);
    expect(revealOffset({ top: 280, bottom: 700 }, pane, 604)).toBe(0);
    expect(revealOffset({ top: Number.NaN, bottom: Number.NaN }, pane, 604)).toBe(0);
  });
  // BUILD-FLOFI-BETA-REGRESSION-FIX-001 (FIX-06): a picker opened near the canvas's right edge pans left instead of being clipped.
  it('pans a clipped panel back inside the right margin, bounded by the left margin', () => {
    const wide = { top: 256, bottom: 694, left: 0, right: 1440 };
    expect(revealOffsetX({ top: 346, bottom: 634, left: 1200, right: 1500 }, wide)).toBe(76);
    // Already inside: nothing moves.
    expect(revealOffsetX({ top: 346, bottom: 634, left: 106, right: 806 }, wide)).toBe(0);
    // Capped: the box's left edge never crosses the pane's left margin.
    expect(revealOffsetX({ top: 346, bottom: 634, left: PANEL_SAFE_SIDE + 10, right: 1500 }, wide)).toBe(10);
    // Measurements without horizontal data move nothing.
    expect(revealOffsetX({ top: 346, bottom: 634 }, wide)).toBe(0);
    expect(revealOffsetX({ top: 346, bottom: 634, left: 1200, right: 1500 }, { top: 256, bottom: 694 })).toBe(0);
  });
});
