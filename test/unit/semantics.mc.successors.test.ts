/**
 * The successor relation `exploreMachine` computes, retained instead of
 * discarded (plan `docs/06-model-checking-implementation-plan.md` §3.P).
 *
 * WHAT THIS COMMIT ADDS IS DATA, AND NOTHING READS IT YET. Six fields on
 * `ExploreResult` — the relation, the two per-configuration arrays, the open
 * frontier flag and the two dwell sets — every one of them a value the walk
 * already had in hand and threw away. No diagnostic, no verdict, no report row.
 * So the gate for the commit is the last half of this file: what `reach`
 * publishes on the six shipped examples is deep-equal to what it published
 * before, and the relation retained is the one reachability was computed from.
 *
 * THE ONE LINE THE FEATURE'S HONESTY TURNS ON is where the edge is recorded.
 * An edge is written down at BOTH sites — at the revisit prune and at the
 * admission point — and the relation is their union. The prune is the half that
 * keeps the cycle-closing edges; recording ONLY at the admission point keeps the
 * BFS spanning tree, which has `nodes - 1` edges and is acyclic by construction
 * on every machine in this repository — so a later component pass over it would
 * name a bottom component on `examples/uav-isr.sysml` that does not exist. That regression has a named
 * test here rather than a comment in the source, and so does the second one:
 * `openFrontier` is `!exhaustive`, never `boundHit !== 'none'`, because the
 * unsupported-construct early return sets `exhaustive: false` with no bound.
 *
 * THE FIXTURES THIS FILE DRIVES, and why two of them are not files.
 * `latch.sysml`, `trapguard.sysml` and its three variants arrive with this
 * commit as corpus models. The two timed machines do NOT: `accept after(n)` is
 * a parse error, so a dwell transition arrives through the API or not at all,
 * and that parse fact is asserted here so it cannot rot back in as an
 * assumption.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Model, ModelFactory, type ElementId } from '@core/index';
import { loadModelText } from '@text/load';
import {
  exploreMachine,
  machineAlphabet,
  reachReport,
  stateMachinesIn,
  type ExploreResult,
} from '../../src/semantics/mc/explore';
import {
  afterDuration,
  hashConfig,
  initialConfig,
  isCompletion,
  leafOf,
  seedStore,
  stepCandidates,
  stepConfig,
  type MachineConfig,
  type StepInput,
} from '../../src/semantics/mc/config';
import { walkIsExact } from '../../src/semantics/mc/publishable';
import { atomHolds, readAtom } from '../../src/semantics/mc/atoms';
import { SEMANTIC_PROFILE } from '../../src/semantics/mc/profile';

const root = (p: string) => resolve(process.cwd(), p);
const read = (p: string) => readFileSync(root(p), 'utf8');

/** One machine of one file, walked. */
interface Walked {
  file: string;
  name: string;
  model: Model;
  machineId: ElementId;
  walk: ExploreResult;
}

/** The leaf name of a node number, for an edge a person can read. */
function edgeNames(model: Model, walk: ExploreResult): string[] {
  const at = (i: number) => {
    const leaf = walk.configLeaves[i];
    return leaf === null || leaf === undefined ? '<none>' : (model.get(leaf)?.declaredName ?? '?');
  };
  return walk.successors.flatMap((targets, from) => targets.map((to) => `${at(from)} -> ${at(to)}`));
}

/**
 * Every `.sysml` file in the tree, textually pre-filtered to the ones that could
 * carry a machine.
 *
 * A directory walk rather than a hand-kept list, because half the assertions
 * below are of the form *"and this is `0` on every machine in the tree"* — a
 * sentence a list quietly stops being true of. The pre-filter is a strict
 * superset: a state machine is an element owning a `TransitionUsage` or a
 * `Succession`, and neither is writable without one of these two words.
 */
function sysmlFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root(dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) sysmlFiles(p, out);
    else if (entry.name.endsWith('.sysml') && /\btransition\b|\bfirst\b/.test(read(p))) out.push(p);
  }
  return out;
}

/**
 * A SECOND DRIVER for the two per-configuration arrays.
 *
 * The point of checking `configStates` against anything is that two independent
 * walks agree about which configuration got which node number; a test that read
 * the arrays off the same call it is checking would be comparing a function with
 * itself. So this is the breadth-first walk written out again — same inputs,
 * same innermost-level rule, same hash — returning the configurations themselves
 * in discovery order. It runs without bounds, which is why it is only ever
 * pointed at fixtures of a handful of configurations.
 */
function bfsConfigs(model: Model, machineId: ElementId): MachineConfig[] {
  const inputs: StepInput[] = [
    { kind: 'completion' },
    ...machineAlphabet(model, machineId).map((trigger): StepInput => ({ kind: 'trigger', trigger })),
  ];
  const seeded = new Map<string, unknown>();
  const machineEl = model.get(machineId);
  if (machineEl) seedStore(model, machineEl, seeded);
  const opening = initialConfig(model, machineId, { store: seeded });
  const seen = new Set<string>([hashConfig(opening.config)]);
  const order: MachineConfig[] = [opening.config];
  const queue: MachineConfig[] = [opening.config];
  while (queue.length > 0) {
    const here = queue.shift()!;
    for (const input of inputs) {
      const { enabled } = stepCandidates(model, here, input, true);
      if (enabled.length === 0) continue;
      const innermost = enabled[0].level;
      for (const choice of enabled) {
        if (choice.level !== innermost) continue;
        const next = stepConfig(model, here, choice);
        const key = hashConfig(next.config);
        if (seen.has(key)) continue;
        seen.add(key);
        order.push(next.config);
        queue.push(next.config);
      }
    }
  }
  return order;
}

/* ═════════════════════ the relation, on the shipped machines ═════════════════ */

describe('the relation `exploreMachine` retained is the one it walked', () => {
  const files = [
    'examples/uav-isr.sysml',
    'examples/vehicle.sysml',
    'examples/views-tour.sysml',
  ];
  const walks = new Map<string, Walked>();

  beforeAll(async () => {
    for (const file of files) {
      const loaded = await loadModelText(read(file), { fileName: file });
      const model = loaded.model!;
      const [machine] = stateMachinesIn(model);
      walks.set(file, {
        file,
        name: machine.declaredName ?? '?',
        model,
        machineId: machine.id,
        walk: exploreMachine(model, machine.id),
      });
    }
  }, 120_000);

  it('is the 5-edge relation over 4 configurations on `FlightModes`', () => {
    const { model, walk } = walks.get('examples/uav-isr.sysml')!;
    expect(walk.configs).toBe(4);
    expect(walk.successors).toHaveLength(4);
    expect(edgeNames(model, walk).sort()).toEqual([
      'autonomous -> failsafe',
      'autonomous -> manual',
      'failsafe -> standby',
      'manual -> autonomous',
      'standby -> manual',
    ]);
  });

  it('records the edge at the REVISIT PRUNE as well as at the admission point, so the two cycle-closing edges survive — recording ONLY at the admission point would leave the 3-edge BFS spanning tree', () => {
    const { model, walk } = walks.get('examples/uav-isr.sysml')!;
    const edges = edgeNames(model, walk);
    // The named regression, in the shape it would take: a spanning tree over 4
    // nodes has 3 edges, one per node but the root, and every one of them points
    // at a configuration discovered by that very step. The two edges below are
    // precisely the ones a spanning tree drops, and Tarjan over what was left
    // would name `{failsafe}` a bottom component of a machine that leaves it.
    expect(edges).toContain('autonomous -> manual');
    expect(edges).toContain('failsafe -> standby');
    expect(edges.length, 'the relation collapsed to its BFS spanning tree').toBe(5);
    expect(edges.length).not.toBe(walk.configs - 1);
    // AND THE OTHER HALF, so neither push site can be dropped unnoticed: the
    // relation is the UNION of the two, the admission point supplying the three
    // tree edges below and the prune the two above. Recording at only ONE site
    // is the regression, whichever site it is.
    expect(edges).toContain('standby -> manual');
    expect(edges).toContain('manual -> autonomous');
    expect(edges).toContain('autonomous -> failsafe');
  });

  it('is 3 configurations / 4 edges on `examples/vehicle.sysml` and 2 / 2 on `views-tour`', () => {
    const vehicle = walks.get('examples/vehicle.sysml')!;
    expect(vehicle.walk.configs).toBe(3);
    expect(vehicle.walk.successors.flat()).toHaveLength(4);
    expect(edgeNames(vehicle.model, vehicle.walk).sort()).toEqual([
      'idling -> moving',
      'idling -> off',
      'moving -> idling',
      'off -> idling',
    ]);
    const tour = walks.get('examples/views-tour.sysml')!;
    expect(tour.walk.configs).toBe(2);
    expect(edgeNames(tour.model, tour.walk).sort()).toEqual([
      'flying -> standby',
      'standby -> flying',
    ]);
  });

  it('names no node a bound refused, and says so through `openFrontier`', () => {
    const { model, machineId } = walks.get('examples/uav-isr.sysml')!;
    const bounded = exploreMachine(model, machineId, { maxConfigs: 2 });
    expect(bounded.boundHit).toBe('configs');
    expect(bounded.configs).toBe(2);
    expect(bounded.successors).toHaveLength(bounded.configs);
    // THE INVARIANT A BOUND COULD BREAK: a target dropped at a bound is not a
    // node, so nothing in the relation may name it.
    expect(bounded.successors.flat().every((i) => i < bounded.configs)).toBe(true);
    expect(bounded.openFrontier).toBe(true);
    expect(bounded.openFrontier).toBe(!bounded.exhaustive);
  });
});

/* ═══════════════════ the open frontier, and the wrong spelling ═══════════════ */

describe('`openFrontier` is the negation of `exhaustive`, not a test on `boundHit`', () => {
  const DANGLE = 'test/fixtures/agent-authoring/L3-unresolved-transition-end/input.sysml';
  let walk: ExploreResult;

  beforeAll(async () => {
    const loaded = await loadModelText(read(DANGLE), { fileName: DANGLE });
    const model = loaded.model!;
    const [machine] = stateMachinesIn(model);
    walk = exploreMachine(model, machine.id);
  }, 120_000);

  it('reads `true` on the unsupported-construct walk, which explored nothing and named no bound', () => {
    expect(walk.configs).toBe(0);
    expect(walk.exhaustive).toBe(false);
    expect(walk.boundHit).toBe('none');
    expect(walk.successors).toEqual([]);
    // THE ASSERTION. The wrong spelling is `openFrontier === (boundHit !==
    // 'none')`, which reads `false` here and would let a later pass publish an
    // absence over an EMPTY relation on the one machine class this engine
    // refuses to walk.
    expect(walk.openFrontier).toBe(!walk.exhaustive);
    expect(walk.openFrontier).toBe(true);
    expect(walk.openFrontier).not.toBe(walk.boundHit !== 'none');
  });
});

/* ════════════════════ the published surface, before this commit ══════════════ */

/**
 * What `reach` published on each shipped example at the commit before this one.
 *
 * MEASURED, NOT REMEMBERED: captured off `sysprose reach --json` on the parent
 * commit and pasted here with the ids dropped. It is the whole of what this
 * commit promises — the relation is new data and not one published row moves —
 * and it is deliberately in this file rather than in a golden, so the commit
 * that DOES move a qualification string moves it here, in sight of the reason.
 */
const REACH_BEFORE: Record<string, unknown> = {
  "examples/contract-authoring-prompts.sysml": {
    "machines": [],
    "totals": {
      "machines": 0,
      "exhaustive": 0,
      "configs": 0,
      "unreachable": 0,
      "dead": 0,
      "nondeterministic": 0,
      "deadlocks": 0
    },
    "diagnostics": []
  },
  "examples/uav-isr-verification.sysml": {
    "machines": [],
    "totals": {
      "machines": 0,
      "exhaustive": 0,
      "configs": 0,
      "unreachable": 0,
      "dead": 0,
      "nondeterministic": 0,
      "deadlocks": 0
    },
    "diagnostics": []
  },
  "examples/uav-isr.sysml": {
    "machines": [
      {
        "machine": {
          "name": "FlightModes",
          "qualifiedName": "UAVSurveillanceSystem::FlightModes",
          "eClass": "StateDefinition"
        },
        "bounds": {
          "maxConfigs": 10000,
          "maxDepth": 200,
          "maxCompletion": 64,
          "alphabet": []
        },
        "configs": 4,
        "depth": 3,
        "exhaustive": true,
        "boundHit": "none",
        "qualification": "exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger}",
        "states": {
          "total": 4,
          "reachable": [
            {
              "name": "standby",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::standby"
            },
            {
              "name": "manual",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::manual"
            },
            {
              "name": "autonomous",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::autonomous"
            },
            {
              "name": "failsafe",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::failsafe"
            }
          ],
          "unreachable": []
        },
        "transitions": {
          "total": 5,
          "fired": 5,
          "dead": []
        },
        "census": {
          "total": 5,
          "rows": [
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `UAVSurveillanceSystem::FlightModes::standby`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `UAVSurveillanceSystem::FlightModes::manual`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `UAVSurveillanceSystem::FlightModes::autonomous`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `UAVSurveillanceSystem::FlightModes::autonomous`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `UAVSurveillanceSystem::FlightModes::failsafe`, which a configuration's stack can hold, so every configuration standing there offers it"
            }
          ],
          "counts": {
            "walked": 5,
            "opening": 0,
            "refused": 0,
            "off-stack": 0,
            "not-a-step": 0,
            "unaccounted": 0
          },
          "unaccounted": []
        },
        "nondeterminism": [
          {
            "state": {
              "name": "autonomous",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::autonomous"
            },
            "event": "",
            "enabled": [
              {
                "name": "",
                "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
                "from": {
                  "name": "autonomous",
                  "qualifiedName": "UAVSurveillanceSystem::FlightModes::autonomous"
                },
                "to": {
                  "name": "manual",
                  "qualifiedName": "UAVSurveillanceSystem::FlightModes::manual"
                },
                "label": ""
              },
              {
                "name": "",
                "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
                "from": {
                  "name": "autonomous",
                  "qualifiedName": "UAVSurveillanceSystem::FlightModes::autonomous"
                },
                "to": {
                  "name": "failsafe",
                  "qualifiedName": "UAVSurveillanceSystem::FlightModes::failsafe"
                },
                "label": ""
              }
            ],
            "taken": {
              "name": "",
              "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
              "from": {
                "name": "autonomous",
                "qualifiedName": "UAVSurveillanceSystem::FlightModes::autonomous"
              },
              "to": {
                "name": "manual",
                "qualifiedName": "UAVSurveillanceSystem::FlightModes::manual"
              },
              "label": ""
            },
            "notTaken": [
              {
                "name": "",
                "qualifiedName": "UAVSurveillanceSystem::FlightModes::«TransitionUsage»",
                "from": {
                  "name": "autonomous",
                  "qualifiedName": "UAVSurveillanceSystem::FlightModes::autonomous"
                },
                "to": {
                  "name": "failsafe",
                  "qualifiedName": "UAVSurveillanceSystem::FlightModes::failsafe"
                },
                "label": ""
              }
            ]
          }
        ],
        "deadlocks": [],
        "unsupported": [],
        "undeterminedGuards": [],
        "suppressed": false
      }
    ],
    "totals": {
      "machines": 1,
      "exhaustive": 1,
      "configs": 4,
      "unreachable": 0,
      "dead": 0,
      "nondeterministic": 1,
      "deadlocks": 0
    },
    "diagnostics": [
      {
        "ruleId": "verification",
        "source": "verification",
        "severity": "warning",
        "message": "`UAVSurveillanceSystem::FlightModes::autonomous`: 2 transitions are enabled at once as completion transitions (no trigger) — the simulator takes `autonomous -> manual` (declaration order) and never `autonomous -> failsafe`.",
        "elementName": "UAVSurveillanceSystem::FlightModes::autonomous",
        "code": "verification/nondeterministic-choice",
        "hint": "Declaration order is not a semantics: give the transitions guards that cannot both hold, or different triggers. Until then one of them is unreachable in simulation while the model admits both."
      }
    ]
  },
  "examples/uav-power-budget.sysml": {
    "machines": [],
    "totals": {
      "machines": 0,
      "exhaustive": 0,
      "configs": 0,
      "unreachable": 0,
      "dead": 0,
      "nondeterministic": 0,
      "deadlocks": 0
    },
    "diagnostics": []
  },
  "examples/vehicle.sysml": {
    "machines": [
      {
        "machine": {
          "name": "VehicleStates",
          "qualifiedName": "VehicleModel::VehicleStates",
          "eClass": "StateDefinition"
        },
        "bounds": {
          "maxConfigs": 10000,
          "maxDepth": 200,
          "maxCompletion": 64,
          "alphabet": []
        },
        "configs": 3,
        "depth": 2,
        "exhaustive": true,
        "boundHit": "none",
        "qualification": "exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger}",
        "states": {
          "total": 3,
          "reachable": [
            {
              "name": "off",
              "qualifiedName": "VehicleModel::VehicleStates::off"
            },
            {
              "name": "idling",
              "qualifiedName": "VehicleModel::VehicleStates::idling"
            },
            {
              "name": "moving",
              "qualifiedName": "VehicleModel::VehicleStates::moving"
            }
          ],
          "unreachable": []
        },
        "transitions": {
          "total": 4,
          "fired": 4,
          "dead": []
        },
        "census": {
          "total": 4,
          "rows": [
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `VehicleModel::VehicleStates::off`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `VehicleModel::VehicleStates::idling`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `VehicleModel::VehicleStates::moving`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `VehicleModel::VehicleStates::idling`, which a configuration's stack can hold, so every configuration standing there offers it"
            }
          ],
          "counts": {
            "walked": 4,
            "opening": 0,
            "refused": 0,
            "off-stack": 0,
            "not-a-step": 0,
            "unaccounted": 0
          },
          "unaccounted": []
        },
        "nondeterminism": [
          {
            "state": {
              "name": "idling",
              "qualifiedName": "VehicleModel::VehicleStates::idling"
            },
            "event": "",
            "enabled": [
              {
                "name": "",
                "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
                "from": {
                  "name": "idling",
                  "qualifiedName": "VehicleModel::VehicleStates::idling"
                },
                "to": {
                  "name": "moving",
                  "qualifiedName": "VehicleModel::VehicleStates::moving"
                },
                "label": ""
              },
              {
                "name": "",
                "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
                "from": {
                  "name": "idling",
                  "qualifiedName": "VehicleModel::VehicleStates::idling"
                },
                "to": {
                  "name": "off",
                  "qualifiedName": "VehicleModel::VehicleStates::off"
                },
                "label": ""
              }
            ],
            "taken": {
              "name": "",
              "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
              "from": {
                "name": "idling",
                "qualifiedName": "VehicleModel::VehicleStates::idling"
              },
              "to": {
                "name": "moving",
                "qualifiedName": "VehicleModel::VehicleStates::moving"
              },
              "label": ""
            },
            "notTaken": [
              {
                "name": "",
                "qualifiedName": "VehicleModel::VehicleStates::«TransitionUsage»",
                "from": {
                  "name": "idling",
                  "qualifiedName": "VehicleModel::VehicleStates::idling"
                },
                "to": {
                  "name": "off",
                  "qualifiedName": "VehicleModel::VehicleStates::off"
                },
                "label": ""
              }
            ]
          }
        ],
        "deadlocks": [],
        "unsupported": [],
        "undeterminedGuards": [],
        "suppressed": false
      }
    ],
    "totals": {
      "machines": 1,
      "exhaustive": 1,
      "configs": 3,
      "unreachable": 0,
      "dead": 0,
      "nondeterministic": 1,
      "deadlocks": 0
    },
    "diagnostics": [
      {
        "ruleId": "verification",
        "source": "verification",
        "severity": "warning",
        "message": "`VehicleModel::VehicleStates::idling`: 2 transitions are enabled at once as completion transitions (no trigger) — the simulator takes `idling -> moving` (declaration order) and never `idling -> off`.",
        "elementName": "VehicleModel::VehicleStates::idling",
        "code": "verification/nondeterministic-choice",
        "hint": "Declaration order is not a semantics: give the transitions guards that cannot both hold, or different triggers. Until then one of them is unreachable in simulation while the model admits both."
      }
    ]
  },
  "examples/views-tour.sysml": {
    "machines": [
      {
        "machine": {
          "name": "FlightModes",
          "qualifiedName": "DroneDemo::FlightModes",
          "eClass": "StateDefinition"
        },
        "bounds": {
          "maxConfigs": 10000,
          "maxDepth": 200,
          "maxCompletion": 64,
          "alphabet": []
        },
        "configs": 2,
        "depth": 1,
        "exhaustive": true,
        "boundHit": "none",
        "qualification": "exhaustive under {maxConfigs 10000, maxDepth 200, maxCompletion 64, alphabet no named trigger}",
        "states": {
          "total": 2,
          "reachable": [
            {
              "name": "standby",
              "qualifiedName": "DroneDemo::FlightModes::standby"
            },
            {
              "name": "flying",
              "qualifiedName": "DroneDemo::FlightModes::flying"
            }
          ],
          "unreachable": []
        },
        "transitions": {
          "total": 2,
          "fired": 2,
          "dead": []
        },
        "census": {
          "total": 2,
          "rows": [
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "DroneDemo::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `DroneDemo::FlightModes::standby`, which a configuration's stack can hold, so every configuration standing there offers it"
            },
            {
              "eClass": "TransitionUsage",
              "qualifiedName": "DroneDemo::FlightModes::«TransitionUsage»",
              "account": "walked",
              "reason": "it is in the step relation and leaves `DroneDemo::FlightModes::flying`, which a configuration's stack can hold, so every configuration standing there offers it"
            }
          ],
          "counts": {
            "walked": 2,
            "opening": 0,
            "refused": 0,
            "off-stack": 0,
            "not-a-step": 0,
            "unaccounted": 0
          },
          "unaccounted": []
        },
        "nondeterminism": [],
        "deadlocks": [],
        "unsupported": [],
        "undeterminedGuards": [],
        "suppressed": false
      }
    ],
    "totals": {
      "machines": 1,
      "exhaustive": 1,
      "configs": 2,
      "unreachable": 0,
      "dead": 0,
      "nondeterministic": 0,
      "deadlocks": 0
    },
    "diagnostics": []
  }
};


/* ═════════════════════ dwells: the transition set, not the labels ════════════ */

/** `failsafe` and `failsafeHold` on dwells, plus an escape nothing takes. */
function twoDwellMachine(): { model: Model; machineId: ElementId } {
  const model = new Model();
  const f = new ModelFactory(model);
  const sm = f.stateDef('Dwells');
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  const standby = f.state('standby', sm.id);
  const orphan = f.state('orphan', sm.id);
  f.transition(failsafe.id, failsafeHold.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(failsafe.id, standby.id, { ownerId: sm.id, trigger: 'after(10)' });
  f.transition(failsafeHold.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  // Nothing enters `orphan`, so the absence lists are non-empty and the
  // differential below has something to be about.
  f.transition(orphan.id, failsafe.id, { ownerId: sm.id, trigger: 'after(5)' });
  return { model, machineId: sm.id };
}

/**
 * The same shape with the dwell in `attrs.after` and NO trigger at all.
 *
 * Written with `model.create` rather than the factory, which takes only
 * `{ownerId, trigger, guard, effect}` and drops anything else. Every edge here
 * is a completion transition that contributes no label, which is exactly the
 * machine an alphabet-scoped dwell field reads empty on.
 */
function numericAfterMachine(): { model: Model; machineId: ElementId; edges: ElementId[] } {
  const model = new Model();
  const f = new ModelFactory(model);
  const sm = f.stateDef('NumericDwells');
  const failsafe = f.state('failsafe', sm.id);
  const failsafeHold = f.state('failsafeHold', sm.id);
  const out = model.create('TransitionUsage', {
    ownerId: sm.id,
    attrs: { after: 5 },
    source: [failsafe.id],
    target: [failsafeHold.id],
  });
  const back = model.create('TransitionUsage', {
    ownerId: sm.id,
    attrs: { after: 5 },
    source: [failsafeHold.id],
    target: [failsafe.id],
  });
  return { model, machineId: sm.id, edges: [out.id, back.id] };
}

/**
 * Every trigger a dwell, and ONE of the dwells leaving the machine ROOT.
 *
 * The root edge is in `regionTransitions` — so `machineAlphabet` takes its label
 * — and out of `walkableTransitions`, because `initialConfig` never pushes the
 * root onto a stack. The census accounts for it as `off-stack`, which is NOT
 * `unaccounted`, so the machine is walked rather than refused. That is the whole
 * fixture: it is the one shape on which the two domains differ.
 */
function offStackDwellMachine(): { model: Model; machineId: ElementId } {
  const model = new Model();
  const f = new ModelFactory(model);
  const sm = f.stateDef('OffStackDwell');
  const a = f.state('a', sm.id);
  const b = f.state('b', sm.id);
  f.transition(a.id, b.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(b.id, a.id, { ownerId: sm.id, trigger: 'after(5)' });
  f.transition(sm.id, a.id, { ownerId: sm.id, trigger: 'after(99)' });
  return { model, machineId: sm.id };
}

describe('`timedTransitions` is the transition set and `timedLabels` only what reached the alphabet', () => {
  it('holds both dwell labels on the two-dwell machine, built through the factory because no `.sysml` file can carry it', () => {
    const { model, machineId } = twoDwellMachine();
    const walk = exploreMachine(model, machineId);
    expect(walk.timedTransitions.size).toBe(4);
    expect([...walk.timedLabels].sort()).toEqual(['after(10)', 'after(5)']);
    expect([...walk.bounds.alphabet].sort()).toEqual(['after(10)', 'after(5)']);
    expect(walk.census.counts.unaccounted).toBe(0);
  });

  it('holds the transitions and NO labels on the numeric-`attrs.after` machine — the fixture an alphabet-scoped clause reads empty on', () => {
    const { model, machineId, edges } = numericAfterMachine();
    for (const id of edges) {
      const tr = model.get(id)!;
      expect(afterDuration(tr)).toBe(5);
      // A dwell with no trigger is a COMPLETION transition, which is why it
      // contributes nothing to the alphabet.
      expect(isCompletion(tr)).toBe(true);
    }
    const walk = exploreMachine(model, machineId);
    expect(walk.bounds.alphabet).toEqual([]);
    expect(walk.timedLabels.size).toBe(0);
    // THE ASSERTION THE DRAFT'S ALPHABET-SCOPED VERSION OF THIS FIELD FAILS.
    expect(walk.timedTransitions.size).toBe(2);
    expect([...walk.timedTransitions].sort()).toEqual([...edges].sort());
    expect(walk.census.counts.unaccounted).toBe(0);

    // And the consequence, read through the gate that already ships: a machine
    // made entirely of dwells is one no increasing claim may be published over,
    // and the clause named is the time one. The wrong answer is
    // `walkIsExact === true`, which is what an alphabet-scoped dwell set yields
    // here and what would let a later pass call `{failsafe, failsafeHold}`
    // inescapable on a walk whose every edge is a wait nothing grants.
    const gate = walkIsExact(walk, walk.bounds);
    expect(gate.seenWhole).toBe(true);
    expect(gate.walkIsExact).toBe(false);
    expect(gate.failedClause).toBe('time');
  });

  it('`timedLabels` ranges over the SAME relation as `bounds.alphabet`, so an off-stack dwell is not read as an environment trigger', () => {
    const { model, machineId } = offStackDwellMachine();
    const walk = exploreMachine(model, machineId);
    expect(walk.census.counts['off-stack']).toBe(1);
    expect(walk.census.counts.unaccounted).toBe(0);
    expect(walk.unsupported).toEqual([]);
    expect(walk.exhaustive).toBe(true);

    // THE TWO DOMAINS, measured apart. The gate's producer is scoped to the
    // edges a configuration can stand on and holds TWO; the subtrahend is scoped
    // to the relation `machineAlphabet` reads and holds THREE labels' worth of
    // coverage — here all three edges carry a label, so it holds both spellings.
    expect(walk.timedTransitions.size).toBe(2);
    expect([...walk.bounds.alphabet].sort()).toEqual(['after(5)', 'after(99)']);
    expect([...walk.timedLabels].sort()).toEqual(['after(5)', 'after(99)']);
    expect(walk.bounds.alphabet.every((t) => walk.timedLabels.has(t))).toBe(true);

    // THE ASSERTION. `after(99)` is a dwell, not a trigger an environment
    // supplies, so the clause named here is the time one. A `timedLabels`
    // scoped to `walkableTransitions` leaves `after(99)` in
    // `alphabet ∖ timedLabels` and names `'environment'` — measured, and it is
    // the wrong answer: it would send an author to `FairnessAssumption` over a
    // machine that names no environment trigger at all.
    const gate = walkIsExact(walk, walk.bounds);
    expect(gate.seenWhole).toBe(true);
    expect(gate.walkIsExact).toBe(false);
    expect(gate.failedClause).toBe('time');
    expect(gate.failedClause).not.toBe('environment');
  });

  it('`accept after(n)` does not parse, so a dwell reaches a model through the API or not at all', async () => {
    const timed = [
      'package Timed {',
      '    state def M {',
      '        state idle;',
      '        state done;',
      '        transition idle accept after(5) then done;',
      '    }',
      '}',
      '',
    ].join('\n');
    const refused = await loadModelText(timed, { fileName: 'timed.sysml' });
    const noViable = refused.report.diagnostics.find((d) => d.code === 'parse/no-viable-alt');
    expect(noViable, '`accept after(5)` now parses — re-price the time clause').toBeDefined();
    expect(noViable!.message).toContain("but found: '('");

    // The escaped spelling parses, and is a DIFFERENT trigger string: the quotes
    // are part of it, so the dwell reader does not recognise it.
    const escaped = await loadModelText(timed.replace('after(5)', "'after(5)'"), {
      fileName: 'timed.sysml',
    });
    expect(escaped.report.summary.errors).toBe(0);
    const tr = escaped
      .model!.ofKind('TransitionUsage')
      .find((t) => typeof t.attrs.trigger === 'string');
    expect(tr!.attrs.trigger).toBe("'after(5)'");
    expect(afterDuration(tr!)).toBeUndefined();
  });
});

/* ══════════════ the stack and the leaf, and the two atom readings ════════════ */

const COMPOSITE = [
  'package Composite {',
  '    part def Ctrl {',
  '        state def Modes {',
  '            state nominal;',
  '            state degraded {',
  '                state sub1;',
  '                state sub2;',
  '                transition sub1 -> sub2;',
  '            }',
  '            transition nominal -> degraded;',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

describe('`configStates` is the stack and `configLeaves` is the leaf, and a composite tells them apart', () => {
  let model: Model;
  let machineId: ElementId;
  let walk: ExploreResult;

  beforeAll(async () => {
    const loaded = await loadModelText(COMPOSITE, { fileName: 'composite.sysml' });
    model = loaded.model!;
    machineId = stateMachinesIn(model)[0].id;
    walk = exploreMachine(model, machineId);
  }, 120_000);

  it('agrees with a second walk of the same relation, configuration by configuration', () => {
    const order = bfsConfigs(model, machineId);
    expect(order).toHaveLength(walk.configs);
    expect(walk.configStates).toHaveLength(walk.configs);
    expect(walk.configLeaves).toHaveLength(walk.configs);
    for (let i = 0; i < order.length; i++) {
      expect([...walk.configStates[i]]).toEqual([...order[i].stack]);
      expect(walk.configLeaves[i]).toBe(leafOf(order[i]));
    }
    const names = walk.configStates.map((s) => s.map((id) => model.get(id)?.declaredName));
    expect(names).toEqual([['nominal'], ['degraded', 'sub1'], ['degraded', 'sub2']]);
    expect(walk.configLeaves.map((id) => (id === null ? null : model.get(id)?.declaredName))).toEqual(
      ['nominal', 'sub1', 'sub2'],
    );
  });

  it('reads `state degraded` off the stack and `node degraded` off the leaf, and the two DIVERGE', () => {
    const order = bfsConfigs(model, machineId);
    const stateAtom = readAtom(model, machineId, 'state degraded');
    const nodeAtom = readAtom(model, machineId, 'node degraded');
    expect(stateAtom.ok && nodeAtom.ok).toBe(true);
    if (!stateAtom.ok || !nodeAtom.ok) return;

    const byStack: boolean[] = [];
    const byLeaf: boolean[] = [];
    for (let i = 0; i < order.length; i++) {
      const obs = { config: order[i], input: null, transition: null };
      // The two arrays, read as the two atom kinds read them …
      expect(walk.configStates[i].includes(stateAtom.atom.elementId!)).toBe(
        atomHolds(model, stateAtom.atom, obs),
      );
      expect(walk.configLeaves[i] === nodeAtom.atom.elementId).toBe(
        atomHolds(model, nodeAtom.atom, obs),
      );
      byStack.push(atomHolds(model, stateAtom.atom, obs) === true);
      byLeaf.push(atomHolds(model, nodeAtom.atom, obs) === true);
    }
    // … and the measurement that makes retaining both arrays worth anything:
    // one atom, two spellings, two different answers on the same walk.
    expect(byStack).toEqual([false, true, true]);
    expect(byLeaf).toEqual([false, false, false]);
  });
});

/* ═══════════════ the whole tree: the three clauses' baselines ════════════════ */

/**
 * The machines this commit ADDS, by the file that carries them.
 *
 * Everything else in the list below is the tree as it stood before this commit —
 * eleven machines, and the assertions about them are what say the new fields
 * cost nothing on any model a command can already load.
 */
const ADDED_FILES = [
  'test/fixtures/verification/models/latch.sysml',
  'test/fixtures/verification/models/trapguard.sysml',
  'test/fixtures/verification/models/trapguard-true.sysml',
  'test/fixtures/verification/models/trapguard-false.sysml',
  'test/fixtures/verification/models/trapguard-typed.sysml',
];

describe('every machine in the tree, walked', () => {
  const walked: Walked[] = [];

  beforeAll(async () => {
    for (const file of sysmlFiles('.').sort()) {
      const loaded = await loadModelText(read(file), { fileName: file });
      if (!loaded.model) continue;
      for (const machine of stateMachinesIn(loaded.model)) {
        walked.push({
          file,
          name: machine.declaredName ?? '?',
          model: loaded.model,
          machineId: machine.id,
          walk: exploreMachine(loaded.model, machine.id),
        });
      }
    }
  }, 300_000);

  it('finds the eleven machines that were here, plus the eight this commit adds', () => {
    const added = walked.filter((w) => ADDED_FILES.includes(w.file));
    expect(added).toHaveLength(8);
    expect(walked.length - added.length, 'the tree gained or lost a machine').toBe(11);
  });

  it('accounts for every edge: `census.counts.unaccounted` is 0 on all of them', () => {
    // §2.3 leans on this: an edge under the machine that the relation does not
    // follow and nothing refused lands in `unaccounted`, which refuses the
    // machine. A fixture that quietly refused would make every other assertion
    // in this file vacuous.
    for (const { file, name, walk } of walked) {
      expect(walk.census.counts.unaccounted, `${file} :: ${name}`).toBe(0);
      expect(walk.census.unaccounted, `${file} :: ${name}`).toEqual([]);
    }
    // And on the two machines no file can carry.
    const dwells = twoDwellMachine();
    expect(exploreMachine(dwells.model, dwells.machineId).census.counts.unaccounted).toBe(0);
    const numeric = numericAfterMachine();
    expect(exploreMachine(numeric.model, numeric.machineId).census.counts.unaccounted).toBe(0);
  });

  it('names a trigger on `latch.sysml` alone: `bounds.alphabet` is `[]` everywhere else', () => {
    const named = walked.filter((w) => w.walk.bounds.alphabet.length > 0);
    expect(named.map((w) => `${w.file} :: ${w.name}`)).toEqual([
      'test/fixtures/verification/models/latch.sysml :: Modes',
    ]);
    expect(named[0].walk.bounds.alphabet).toEqual(['unlatch']);
  });

  it('carries no dwell at all: `timedTransitions` and `timedLabels` are empty on every one of them', () => {
    // Clause (b) costs nothing on any model a CLI command can load, because
    // correction 22 makes a dwell unwritable in the notation.
    for (const { file, name, walk } of walked) {
      expect(walk.timedTransitions.size, `${file} :: ${name}`).toBe(0);
      expect(walk.timedLabels.size, `${file} :: ${name}`).toBe(0);
    }
  });

  it('leaves a guard undecided on exactly four of them, and `undeterminedGuards` is the shipped field that says so', () => {
    const undecided = walked
      .filter((w) => w.walk.undeterminedGuards.length > 0)
      .map((w) => `${w.file} :: ${w.name}`);
    expect(undecided.sort()).toEqual([
      'test/fixtures/verification/models/guard-undetermined.sysml :: Modes',
      'test/fixtures/verification/models/trapguard-typed.sysml :: Modes',
      'test/fixtures/verification/models/trapguard.sysml :: Modes',
      'test/fixtures/verification/models/trapguard.sysml :: Modes',
    ]);
    expect(walked.length - undecided.length, 'a guard that used to decide stopped deciding').toBe(
      walked.length - 4,
    );
  });
});

/* ══════════════ the guard trio, and the reading that separates them ══════════ */

describe('`undeterminedGuards` tracks DECIDEDNESS, not the presence of a guard', () => {
  const FILES = [
    'test/fixtures/verification/models/trapguard.sysml',
    'test/fixtures/verification/models/trapguard-true.sysml',
    'test/fixtures/verification/models/trapguard-false.sysml',
    'test/fixtures/verification/models/trapguard-typed.sysml',
    'test/fixtures/verification/models/guard-undetermined.sysml',
  ];
  const byFile = new Map<string, Walked[]>();

  beforeAll(async () => {
    for (const file of FILES) {
      const loaded = await loadModelText(read(file), { fileName: file });
      const model = loaded.model!;
      byFile.set(
        file,
        stateMachinesIn(model).map((machine) => ({
          file,
          name:
            model.get(model.get(machine.id)?.ownerId ?? '')?.declaredName ??
            machine.declaredName ??
            '?',
          model,
          machineId: machine.id,
          walk: exploreMachine(model, machine.id),
        })),
      );
    }
  }, 300_000);

  it('holds exactly the `if resetOk` transition on `trapguard.sysml`, on each of its machines', () => {
    const machines = byFile.get('test/fixtures/verification/models/trapguard.sysml')!;
    expect(machines).toHaveLength(2);
    for (const { walk } of machines) {
      expect(walk.undeterminedGuards).toHaveLength(1);
      expect(walk.undeterminedGuards[0].guard).toBe('resetOk');
      expect(walk.undeterminedGuards[0].unresolved).toEqual(['resetOk']);
      expect(walk.undeterminedGuards[0].transition.to!.name).toBe('nominal');
    }
  });

  it('is EMPTY on both literal variants — one with the escape edge present, one with it absent-but-decided', () => {
    const yes = byFile.get('test/fixtures/verification/models/trapguard-true.sysml')!;
    const no = byFile.get('test/fixtures/verification/models/trapguard-false.sysml')!;
    for (const { walk } of [...yes, ...no]) {
      expect(walk.undeterminedGuards).toEqual([]);
      expect(walk.exhaustive).toBe(true);
    }
    // `= true` keeps the escape edge; `= false` drops it, and the walk knows
    // which of the two it is looking at.
    const trap = yes.find((w) => w.walk.configs === 3)!;
    expect(edgeNames(trap.model, trap.walk)).toContain('degradedA -> nominal');
    const shut = no.find((w) => w.walk.configs === 3)!;
    expect(edgeNames(shut.model, shut.walk)).not.toContain('degradedA -> nominal');
  });

  it('is NON-EMPTY on `trapguard-typed.sysml`, where the feature is fully valued and `unresolved` is empty', () => {
    const [{ walk }] = byFile.get('test/fixtures/verification/models/trapguard-typed.sysml')!;
    expect(walk.undeterminedGuards).toHaveLength(1);
    // THE ROW THAT SEPARATES THE SHIPPED PREDICATE FROM THE NARROWER READING.
    // `mode` has a declared value, so *"no declared value for a feature the
    // guard reads"* is satisfied here and would read the walk as exact; the
    // shipped predicate does not, because `not mode` applies a boolean operator
    // to a number and decides nothing.
    expect(walk.undeterminedGuards[0].guard).toBe('not mode');
    expect(walk.undeterminedGuards[0].unresolved).toEqual([]);
    expect(walk.exhaustive).toBe(true);
    const gate = walkIsExact(walk, walk.bounds);
    expect(gate.seenWhole).toBe(true);
    expect(gate.walkIsExact).toBe(false);
    expect(gate.failedClause).toBe('store');
  });

  it('is NON-EMPTY on `GuardProbe::Ctrl`, the corpus witness the clause gained earlier', () => {
    const machines = byFile.get('test/fixtures/verification/models/guard-undetermined.sysml')!;
    const undecided = machines.filter((w) => w.walk.undeterminedGuards.length > 0);
    expect(undecided).toHaveLength(1);
    expect(undecided[0].name).toBe('Ctrl');
    expect(undecided[0].walk.undeterminedGuards[0].guard).toBe('mode == 3');
  });

  it('names a trigger nowhere in the trio, so the store clause is the only one these fixtures exercise', () => {
    for (const machines of byFile.values()) {
      for (const { walk } of machines) {
        expect(walk.bounds.alphabet).toEqual([]);
        expect(walk.timedTransitions.size).toBe(0);
      }
    }
  });
});

/* ═══════════════════════════ the differential ════════════════════════════════ */

/**
 * Strip the ids out of a published report.
 *
 * Element ids are fresh UUIDs on every load, so a structural comparison against
 * a value measured in another process has to drop them — and dropping them costs
 * nothing, because every ref that carries an id carries its qualified name
 * beside it.
 */
function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== 'id' && k !== 'elementId')
        .map(([k, v]) => [k, withoutIds(v)]),
    );
  }
  return value;
}

describe("the differential: `reach`'s published output did not move", () => {
  const files = Object.keys(REACH_BEFORE);

  for (const file of files) {
    it(`${file} — every published row is deep-equal to what it was before the relation was retained`, async () => {
      const loaded = await loadModelText(read(file), { fileName: file });
      const report = JSON.parse(JSON.stringify(reachReport(loaded.model!))) as {
        machines: unknown;
        totals: unknown;
        diagnostics: unknown;
        profile: unknown;
      };
      // The profile is a module constant and is compared to the constant itself
      // rather than to 2 kB of it repeated six times.
      expect(report.profile).toEqual(JSON.parse(JSON.stringify(SEMANTIC_PROFILE)));
      expect(
        withoutIds({
          machines: report.machines,
          totals: report.totals,
          diagnostics: report.diagnostics,
        }),
      ).toEqual(REACH_BEFORE[file]);
    }, 120_000);
  }

  it('and on the timed machine no file can carry, which keeps both of its absence lists', () => {
    const { model } = twoDwellMachine();
    const row = reachReport(model).machines[0];
    // Measured before this commit and unmoved by it: an over-approximating walk
    // can only SHRINK an absence list, so a dwell costs the decreasing side
    // nothing.
    expect(row.exhaustive).toBe(true);
    expect(row.suppressed).toBe(false);
    expect(row.states.unreachable.map((s) => s.name)).toEqual(['orphan']);
    expect(row.transitions.dead).toHaveLength(1);
    expect(row.transitions.dead[0].from!.name).toBe('orphan');
    expect(row.qualification).toContain('exhaustive under {maxConfigs 10000');
  });
});
