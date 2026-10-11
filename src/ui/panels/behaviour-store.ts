/**
 * The transient canvas state of the behaviour lanes' diagram view.
 *
 * Module-scoped, like the palette's armed tool and the checks results: the
 * marks hidden flag, the details toggle and the open witness are UI state about
 * a run, not part of the model, and must never reach a saved project. The
 * witness field is written only by the step-6 stepper; until then it stays
 * null and nothing paints.
 */

import { create } from 'zustand';
import type { WitnessAt } from '../behaviour-checks';

interface BehaviourState {
  /** The user hid the reachability marks (the status panel still shows). */
  marksHidden: boolean;
  /** The status panel's details are expanded. */
  detailsOpen: boolean;
  /** The witness the canvas is stepping through, or null. */
  witness: WitnessAt | null;
  setMarksHidden(hidden: boolean): void;
  setDetailsOpen(open: boolean): void;
  openWitness(at: WitnessAt): void;
  seek(step: number): void;
  closeWitness(): void;
}

export const useBehaviourStore = create<BehaviourState>((set) => ({
  marksHidden: false,
  detailsOpen: false,
  witness: null,
  setMarksHidden: (hidden) => set({ marksHidden: hidden }),
  setDetailsOpen: (open) => set({ detailsOpen: open }),
  openWitness: (at) => set({ witness: at }),
  seek: (step) => set((s) => (s.witness === null ? {} : { witness: { ...s.witness, step } })),
  closeWitness: () => set({ witness: null }),
}));
