/**
 * Components of the retained successor relation — Tarjan, iteratively, plus the
 * three questions this lane asks of the shape of a walk
 * (plan `docs/06-model-checking-implementation-plan.md` §3.P, §3.2a, §3.2b).
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT. It is graph arithmetic over integers.
 * It takes `ExploreResult.successors` — node numbers in breadth-first discovery
 * order — and answers *which configurations are mutually reachable*, *which of
 * those sets has no edge leaving it*, *does the relation have a cycle at all*
 * and *which configurations can reach a given set*. It knows nothing about
 * states, transitions, guards or bounds, it prints no sentence, and it decides
 * nothing about what may be PUBLISHED: that question belongs to the exactness
 * gate in `./publishable`, and every caller here is required to ask it first.
 * The separation is deliberate — the arithmetic is right on graphs whose answer
 * is known by construction, and the honesty is a separate property checked
 * separately.
 *
 * WHY ITERATIVE, STATED ONCE. The textbook Tarjan recurses once per node, so a
 * machine whose walk is a long chain recurses as deep as that chain: the walk's
 * own configuration bound is 10,000 by default, which is an order of magnitude
 * past the stack this engine runs on. A five-thousand-configuration chain is a
 * fixture in this module's test file for exactly that reason. The explicit
 * frame stack below is what keeps the answer an answer rather than a
 * `RangeError` in the middle of a report.
 *
 * WHY THE NODE NUMBERS AND NOT THE CONFIGURATIONS. A configuration hash is
 * built from element ids, and ids are fresh on every load, so a hash means
 * nothing outside the process that produced it and reaches no report, digest or
 * payload. The walk interns each configuration to its discovery number, which
 * depends only on model structure; this module never sees anything else.
 */

/**
 * The strongly connected components of a relation, both ways round.
 *
 * `members` is indexed by component number and `componentOf` by node number, so
 * a caller that has one has the other without a search. Both are needed in
 * practice: the trap question reads `members`, the "does this edge leave its
 * component" question reads `componentOf`.
 */
export interface Components {
  /** Node numbers per component, each ascending. */
  readonly members: readonly (readonly number[])[];
  /** `componentOf[v]` is the component number of node `v`. */
  readonly componentOf: readonly number[];
}

/**
 * The node numbers a relation names but does not have.
 *
 * `exploreMachine` never produces one — a target a bound refused is never given
 * a number, which is the invariant its own suite asserts — so an edge pointing
 * outside the node range is a defect in the producer, and every question below
 * would answer something plausible over it: a phantom node is trivially its own
 * bottom component and trivially acyclic. It is raised rather than skipped for
 * that reason: silently dropping the edge is how a component pass comes to
 * report a set nothing leaves over a relation that leaves it.
 */
function edgeOutOfRange(from: number, to: number, nodes: number): Error {
  return new Error(
    `the successor relation names node ${to} from node ${from}, but the walk has ${nodes} node(s): ` +
      'an edge may only point at a configuration the walk numbered',
  );
}

/**
 * The same refusal for a node number a CALLER names, and it is the same defect.
 *
 * `reverseReachable` is asked *which configurations can reach this set*, and a
 * target outside the node range used to be dropped silently — so a caller that
 * numbered its target wrong got back the empty set, which reads as *nothing can
 * reach it*: the maximal absence answer, and the one §3.2b spends `exit 1` and
 * `verification/refuted` on. Dropping the target is the same species of silent
 * plausible answer as dropping an edge, in the direction that manufactures a
 * refutation rather than hiding one, so it is raised for the same reason.
 *
 * A DUPLICATE target is not this: asking twice about one node is a caller
 * passing a set with repeats, and the dedupe below still just skips it.
 */
function targetOutOfRange(target: number, nodes: number): Error {
  return new Error(
    `reverse reachability was asked about node ${target}, but the walk has ${nodes} node(s): ` +
      'a target may only name a configuration the walk numbered',
  );
}

/**
 * The components must be the components OF this relation.
 *
 * `bottomComponents` and `acyclic` both take a precomputed {@link Components} so
 * one Tarjan pass can answer several questions, and a caller that hands over
 * components computed from a different graph gets an answer about neither:
 * measured, `bottomComponents` over a three-cycle with singleton components
 * returns `[]` — *no set is inescapable* — where the same relation alone returns
 * the one component there is. Mismatched lengths are the cheap half of that
 * defect and the half worth refusing, for the reason the edge check above is
 * raised rather than skipped.
 */
function componentsMismatch(nodes: number, comps: number): Error {
  return new Error(
    `the components cover ${comps} node(s) but the relation has ${nodes}: ` +
      'the components must be the components of the relation they are read against',
  );
}

/**
 * Tarjan's strongly connected components, with an explicit frame stack.
 *
 * The components come out in reverse topological order — every component is
 * emitted only after all the components reachable from it — which is the order
 * the algorithm produces and is worth stating because two callers below rely on
 * nothing else about it.
 */
export function tarjanComponents(successors: readonly (readonly number[])[]): Components {
  const nodes = successors.length;
  const index = new Int32Array(nodes).fill(-1);
  const low = new Int32Array(nodes);
  const onStack = new Uint8Array(nodes);
  const componentOf = new Int32Array(nodes).fill(-1);
  const members: number[][] = [];
  // The component stack of the algorithm proper, distinct from the frame stack
  // that replaces the recursion.
  const pending: number[] = [];
  const frameNode: number[] = [];
  const frameEdge: number[] = [];
  let counter = 0;

  for (let root = 0; root < nodes; root++) {
    if (index[root] !== -1) continue;
    index[root] = counter;
    low[root] = counter;
    counter++;
    pending.push(root);
    onStack[root] = 1;
    frameNode.push(root);
    frameEdge.push(0);

    while (frameNode.length > 0) {
      const top = frameNode.length - 1;
      const v = frameNode[top];
      const targets = successors[v] ?? [];
      if (frameEdge[top] < targets.length) {
        const w = targets[frameEdge[top]++];
        if (w < 0 || w >= nodes) throw edgeOutOfRange(v, w, nodes);
        if (index[w] === -1) {
          // DESCEND. Everything the recursive form does on the way down, done
          // here, because the frame that would have carried it is the two
          // pushes below.
          index[w] = counter;
          low[w] = counter;
          counter++;
          pending.push(w);
          onStack[w] = 1;
          frameNode.push(w);
          frameEdge.push(0);
        } else if (onStack[w] === 1) {
          // A back edge into the component being built. `index`, not `low`:
          // the low-link of a node still on the stack may yet fall, and reading
          // it here is the classic way to fuse two components that are not one.
          if (index[w] < low[v]) low[v] = index[w];
        }
        continue;
      }

      // RETURN. Every edge of `v` is walked, so its low-link is final.
      frameNode.pop();
      frameEdge.pop();
      if (low[v] === index[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = pending.pop()!;
          onStack[w] = 0;
          componentOf[w] = members.length;
          comp.push(w);
          if (w === v) break;
        }
        // Ascending, so a component is a value a test can compare rather than a
        // set whose order is an artefact of the pop.
        comp.sort((a, b) => a - b);
        members.push(comp);
      }
      if (frameNode.length > 0) {
        const parent = frameNode[frameNode.length - 1];
        if (low[v] < low[parent]) low[parent] = low[v];
      }
    }
  }

  return { members, componentOf: Array.from(componentOf) };
}

/**
 * The components no edge leaves — every configuration in one stays in it.
 *
 * A component is bottom when every edge out of every member lands in the same
 * component. That includes the TRIVIAL ones: a single node with no outgoing
 * edge at all is a bottom component of size one, and so is a single node whose
 * only edge is a self-loop. Those are different things to a reader — one is an
 * ending, the other is a set nothing leaves — and telling them apart is the
 * caller's job, not this function's, because the exemptions that decide it are
 * about final states and terminal nodes and this module knows about neither.
 */
export function bottomComponents(
  successors: readonly (readonly number[])[],
  comps: Components = tarjanComponents(successors),
): readonly (readonly number[])[] {
  if (comps.componentOf.length !== successors.length) {
    throw componentsMismatch(successors.length, comps.componentOf.length);
  }
  const out: (readonly number[])[] = [];
  for (const members of comps.members) {
    const here = comps.componentOf[members[0]];
    let leaves = false;
    for (const v of members) {
      for (const w of successors[v] ?? []) {
        if (w < 0 || w >= successors.length) throw edgeOutOfRange(v, w, successors.length);
        if (comps.componentOf[w] !== here) {
          leaves = true;
          break;
        }
      }
      if (leaves) break;
    }
    if (!leaves) out.push(members);
  }
  return out;
}

/**
 * Has the retained relation no cycle at all?
 *
 * Two ways a cycle shows: a component of more than one node, and a node whose
 * own edge list names itself. The second is not covered by the first — Tarjan
 * puts a self-looping node in a component of one — and a reading that checked
 * only component size would call `hazard -> hazard` acyclic, which is the
 * machine a liveness lane would most want it to notice.
 *
 * THIS ANSWER IS ABOUT THE RETAINED RELATION AND NOTHING ELSE. The relation a
 * walk retains is not always the relation the machine states: an edge behind a
 * guard nothing decided is a cycle-closing edge the walk never had, so a
 * machine whose stated relation cycles can be walked into an acyclic one. That
 * is why every caller in this tree records the answer as `null` unless the
 * exactness gate holds, and why this function is not the place to decide it —
 * it answers what it is asked, over the graph it is given.
 */
export function acyclic(
  successors: readonly (readonly number[])[],
  comps: Components = tarjanComponents(successors),
): boolean {
  if (comps.componentOf.length !== successors.length) {
    throw componentsMismatch(successors.length, comps.componentOf.length);
  }
  for (const members of comps.members) if (members.length > 1) return false;
  for (let v = 0; v < successors.length; v++) {
    for (const w of successors[v] ?? []) {
      if (w < 0 || w >= successors.length) throw edgeOutOfRange(v, w, successors.length);
      if (w === v) return false;
    }
  }
  return true;
}

/**
 * Every node that can reach one of `targets`, the targets themselves included.
 *
 * REFLEXIVE, and it is stated because the alternative is a real reading: a
 * configuration that IS the one being asked about can reach it in zero steps,
 * and a version that required one step would report the opening configuration
 * of a machine as unable to reach the state it opens in. Breadth-first over the
 * reversed relation, iteratively, for the same reason the components are.
 *
 * A TARGET OUTSIDE THE NODE RANGE IS RAISED, not skipped — see
 * {@link targetOutOfRange}. Skipping it answers *the empty set can be reached
 * from nowhere*, which the caller reads as *no configuration can reach `p`*, and
 * that is a refutation manufactured out of a numbering mistake.
 */
export function reverseReachable(
  successors: readonly (readonly number[])[],
  targets: Iterable<number>,
): ReadonlySet<number> {
  const nodes = successors.length;
  const incoming: number[][] = Array.from({ length: nodes }, () => []);
  for (let v = 0; v < nodes; v++) {
    for (const w of successors[v] ?? []) {
      if (w < 0 || w >= nodes) throw edgeOutOfRange(v, w, nodes);
      incoming[w].push(v);
    }
  }
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const t of targets) {
    if (t < 0 || t >= nodes) throw targetOutOfRange(t, nodes);
    if (seen.has(t)) continue;
    seen.add(t);
    queue.push(t);
  }
  for (let head = 0; head < queue.length; head++) {
    for (const v of incoming[queue[head]]) {
      if (seen.has(v)) continue;
      seen.add(v);
      queue.push(v);
    }
  }
  return seen;
}
