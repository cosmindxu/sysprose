/**
 * Properties — an editable form for the currently-selected element.
 *
 * Shows the common identity fields (declaredName, declaredShortName, eClass),
 * plus metaclass-specific attributes (port direction, type reference, value,
 * multiplicity, requirement id/text, transition trigger/guard/effect, and
 * documentation), the STATEMENT KIND wherever the notation can carry one, and
 * the nine requirement-management facets on a requirement. Edits flow through
 * `updateElement` / `setAttr`, and the facets through the two commands that
 * validate before they write (`setStatementKind`, `setRequirementAttr`). The
 * element's qualifiedName and its relationships (types / specializations /
 * connections) are shown read-only. Reads the model directly and subscribes to
 * `rev` so fields stay in sync with every mutation.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  isUsage,
  isSpecialization,
  isMembership,
  isRequirement,
  TEXTUAL_KEYWORD,
  type AttrValue,
  type ElementId,
  type ElementRecord,
  type FeatureDirection,
} from '@core/index';
import { whereUsed } from '@api/index';
import { elementCentrality } from '@diagram/index';
import {
  RM_ATTR_KEYS,
  RM_ENUM_VALUES,
  STATEMENT_KINDS,
  FAULTED_DECLARATION_REFUSAL,
  canCarryStatementKind,
  carriesItsOwnText,
  getRequirementAttrs,
  statementKindOf,
  untaggedStatementKindLabel,
  writtenStatementKind,
  type RmAttrKey,
  type StatementKind,
} from '@semantics/index';
import { DIMENSIONLESS, dimEqual, dimToString } from '@semantics/units';
import { useAppStore } from '../store';
import { ImpactGraph } from './ImpactGraph';

/** Read an attribute as a display string (empty for absent/non-primitive). */
function attrString(el: ElementRecord, key: string): string {
  const v = el.attrs[key];
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return '';
  return String(v);
}

/** Label for an element used in read-only relationship lists. */
function refLabel(el: ElementRecord): string {
  return el.declaredName || el.declaredShortName || `«${el.eClass}»`;
}

const DIRECTIONS: FeatureDirection[] = ['in', 'out', 'inout'];

/**
 * The nine management facets, in the order {@link RM_ATTR_KEYS} declares them.
 * The tenth — the kind — has a control of its own above, because it applies to
 * far more than requirements.
 */
const RM_FACETS = RM_ATTR_KEYS.filter((k) => k !== 'statementKind');

/** Sentence-case heading for a facet key: `verificationMethod` → `Verification method`. */
function facetLabel(key: RmAttrKey): string {
  const spaced = key.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Cap the rendered "Used by" list so a widely-referenced element can't spawn
 *  thousands of DOM nodes; the section header still shows the true total. */
const MAX_USED_BY = 50;

/** Cap the descendants walk so selecting a huge subtree stays responsive. */
const MAX_DESCENDANTS = 2000;

export function Properties(): JSX.Element {
  const rev = useAppStore((s) => s.rev);
  const model = useAppStore((s) => s.model);
  const api = useAppStore((s) => s.api);
  const selectionId = useAppStore((s) => s.selectionId);
  const updateElement = useAppStore((s) => s.updateElement);
  const setAttr = useAppStore((s) => s.setAttr);
  const createElement = useAppStore((s) => s.createElement);
  const select = useAppStore((s) => s.select);
  const setStatementKind = useAppStore((s) => s.setStatementKind);
  const setRequirementAttr = useAppStore((s) => s.setRequirementAttr);

  // `rev` is read so the component re-renders on model mutations.
  void rev;

  const el = selectionId ? model.get(selectionId) : undefined;

  // Where-used / impact: the distinct elements that reference the selection via
  // any relationship or typing. Recomputed on selection + every mutation (`rev`).
  const usedBy = useMemo(
    () => (selectionId ? whereUsed(model, selectionId).usedBy : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, selectionId, rev],
  );

  // Cheap structural/coupling metrics for the selection (degree): direct
  // children, total descendants, and outgoing references (fan-out); fan-in is
  // the where-used count above.
  const metrics = useMemo(() => {
    if (!selectionId) return null;
    const children = model.childIds(selectionId).length;
    let descendants = 0;
    let capped = false;
    const seen = new Set<string>(); // guard a malformed ownership cycle
    const stack = [...model.childIds(selectionId)];
    while (stack.length > 0) {
      // Cap the walk so selecting a huge (e.g. library) subtree can't make the
      // per-rev recompute crawl; the count then reads "N+".
      if (descendants >= MAX_DESCENDANTS) {
        capped = true;
        break;
      }
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      descendants++;
      stack.push(...model.childIds(c));
    }
    const out = new Set<string>();
    for (const e of model.edgesOf(selectionId)) {
      if ((e.source ?? []).includes(selectionId)) {
        for (const t of e.target ?? []) if (t !== selectionId) out.add(t);
      }
    }
    return { children, descendants, capped, fanOut: out.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, selectionId, rev]);

  // Whole-graph PageRank centrality of the user model (selection-independent —
  // recomputed only when the model actually mutates, not on every selection).
  // The heavy step (PageRank) runs on the user node set only; library elements
  // are filtered out inside the helper.
  const centrality = useMemo(
    () => elementCentrality(model.all()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, rev],
  );
  const prScore = selectionId ? centrality.score.get(selectionId) : undefined;
  const prRank = selectionId ? centrality.rank.get(selectionId) : undefined;

  // Unit-aware quantity view for the selected feature (dimension + convert).
  const quantity = el ? api.evaluateQuantity(el.id) : undefined;
  const baseUnit = quantity?.unit;
  const compatibleUnits = baseUnit ? api.compatibleUnits(baseUnit) : [];
  const showQuantity = !!quantity && (!!baseUnit || !dimEqual(quantity.dimension, DIMENSIONLESS));

  const [targetUnit, setTargetUnit] = useState('');
  const [showImpact, setShowImpact] = useState(false);
  useEffect(() => {
    setTargetUnit(baseUnit ?? '');
  }, [selectionId, baseUnit]);

  let convertedValue = '';
  if (quantity && baseUnit && targetUnit) {
    try {
      convertedValue = String(api.convertUnit(quantity.magnitude, baseUnit, targetUnit));
    } catch {
      convertedValue = '—';
    }
  }

  if (!el) {
    return (
      <div data-testid="properties" className="properties">
        <div className="panel-title">Properties</div>
        <div className="panel-empty">No element selected.</div>
      </div>
    );
  }

  const id: ElementId = el.id;
  const eClass = el.eClass;

  const isPort = isUsage(eClass) && eClass.includes('Port');
  const isTransition = eClass.includes('Transition');
  const usage = isUsage(eClass);

  // The statement kind is offered wherever the notation has somewhere to write
  // the keyword — which is most declarations, not only requirements. That is
  // the point of it: guidance written on a definition or a package reaches
  // everything typed by it or inside it (`promptsFor`), so restricting the
  // control to requirements would hide it from the elements it is most useful
  // on. `canCarryStatementKind` is the same predicate the writer refuses on, so
  // the control is absent exactly where the write would have thrown.
  const canCarryKind = canCarryStatementKind(el);
  // The selector is driven by the kind that is actually WRITTEN, not the kind
  // the element reads as. On an untagged requirement those differ — it reads
  // `requirement` and carries no keyword — and a selector showing the effective
  // answer makes both transitions unreachable: picking `(untagged)` is a no-op
  // the store returns from without a re-render, and picking `requirement`
  // fires no change event because the browser thinks it is already chosen.
  const writtenKind = writtenStatementKind(model, id);
  const effectiveKind = statementKindOf(model, id);
  // Read-only: `getRequirementAttrs` never creates the metadata carrier, so
  // selecting a requirement does not change the model.
  const requirementFacets = isRequirement(eClass)
    ? getRequirementAttrs(model, id)
    : ({} as Partial<Record<RmAttrKey, string>>);
  // A faulted declaration re-emits its own source verbatim on save, so
  // `setRequirementAttr` refuses it and the store logs the refusal. Ask first
  // and disable, rather than offering a control whose value snaps back.
  const facetsWritable = carriesItsOwnText(el);

  // Documentation: the body of the first child Documentation/Comment element.
  const docChild = model
    .children(id)
    .find((c) => c.eClass === 'Documentation' || c.eClass === 'Comment');
  const docBody = docChild ? attrString(docChild, 'body') : '';

  // Read-only relationship facets.
  const types = model.typesOf(id);
  const specializations = model
    .relationshipsFrom(id)
    .filter((r) => isSpecialization(r.eClass));
  // Connection-like edges touching this element, excluding the specialization
  // and membership families already covered above / by containment.
  const connections = model
    .edgesOf(id)
    .filter(
      (e) =>
        e.id !== id &&
        !isSpecialization(e.eClass) &&
        !isMembership(e.eClass) &&
        (e.source?.length || e.target?.length),
    );

  function setAttrOrClear(key: string, value: string): void {
    setAttr(id, key, value as AttrValue);
  }

  function commitDoc(value: string): void {
    if (docChild) {
      setAttr(docChild.id, 'body', value);
      return;
    }
    if (!value) return;
    // Lazily create a Documentation child, then restore selection to this el.
    const docId = createElement('Documentation', id);
    setAttr(docId, 'body', value);
    select(id);
  }

  return (
    <div data-testid="properties" className="properties">
      <div className="panel-title">Properties</div>
      <div className="properties-form">
        <div className="field">
          <label>Qualified name</label>
          <input value={model.qualifiedName(id)} readOnly />
        </div>

        <div className="field">
          <label>Metaclass</label>
          <input
            data-testid="prop-eclass"
            value={`${eClass}  («${TEXTUAL_KEYWORD[eClass] ?? eClass}»)`}
            readOnly
          />
        </div>

        <div className="field">
          <label>Name</label>
          <input
            data-testid="prop-name"
            value={el.declaredName ?? ''}
            onChange={(e) =>
              updateElement(id, { declaredName: e.target.value || undefined })
            }
          />
        </div>

        <div className="field">
          <label>Short name</label>
          <input
            data-testid="prop-shortName"
            value={el.declaredShortName ?? ''}
            onChange={(e) =>
              updateElement(id, { declaredShortName: e.target.value || undefined })
            }
          />
        </div>

        {isPort && (
          <div className="field">
            <label>Direction</label>
            <select
              data-testid="prop-direction"
              value={attrString(el, 'direction') || 'in'}
              onChange={(e) => setAttrOrClear('direction', e.target.value)}
            >
              {DIRECTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        )}

        {usage && (
          <div className="field">
            <label>Type</label>
            <input
              data-testid="prop-type"
              placeholder="type name reference"
              value={attrString(el, 'type')}
              onChange={(e) => setAttrOrClear('type', e.target.value)}
            />
          </div>
        )}

        {usage && (
          <div className="field">
            <label>Value</label>
            <input
              data-testid="prop-value"
              value={attrString(el, 'value')}
              onChange={(e) => setAttrOrClear('value', e.target.value)}
            />
          </div>
        )}

        {showQuantity && quantity && (
          <div className="field" data-testid="prop-quantity">
            <label>Dimension</label>
            <input
              data-testid="prop-dimension"
              value={dimToString(quantity.dimension)}
              readOnly
            />
            {baseUnit && compatibleUnits.length > 0 && (
              <div className="unit-convert">
                <select
                  data-testid="prop-unit-convert"
                  value={targetUnit}
                  onChange={(e) => setTargetUnit(e.target.value)}
                >
                  {compatibleUnits.map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
                <input data-testid="prop-converted-value" value={convertedValue} readOnly />
              </div>
            )}
          </div>
        )}

        {usage && (
          <div className="field">
            <label>Multiplicity</label>
            <input
              data-testid="prop-multiplicity"
              placeholder="e.g. 1, 0..1, 1..*"
              value={attrString(el, 'multiplicity')}
              onChange={(e) => setAttrOrClear('multiplicity', e.target.value)}
            />
          </div>
        )}

        {isRequirement(eClass) && (
          <div className="field">
            <label>Requirement id</label>
            <input
              data-testid="prop-reqId"
              value={attrString(el, 'reqId')}
              onChange={(e) => setAttrOrClear('reqId', e.target.value)}
            />
          </div>
        )}

        {isRequirement(eClass) && (
          <div className="field">
            <label>Requirement text</label>
            <textarea
              data-testid="prop-text"
              value={attrString(el, 'text')}
              onChange={(e) => setAttrOrClear('text', e.target.value)}
            />
          </div>
        )}

        {canCarryKind && (
          <div className="field">
            <label>Kind</label>
            <select
              data-testid="prop-statement-kind"
              value={writtenKind ?? ''}
              title="What this statement is for. Only a requirement counts towards coverage."
              onChange={(e) =>
                setStatementKind(id, (e.target.value || null) as StatementKind | null)
              }
            >
              {/* The way back out: it takes the keyword OFF, which for a part
                  or a package means the element makes no statement of its own,
                  and for a requirement means the metaclass answers again. It is
                  also the state an untagged element is IN, so it is labelled
                  with what the element then reads as rather than left to look
                  like nothing — and never with the bare word `requirement`,
                  which would put two options in the list saying the same word
                  and meaning different things. */}
              <option value="">{untaggedStatementKindLabel(effectiveKind)}</option>
              {STATEMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
        )}

        {isRequirement(eClass) && (
          <div className="properties-facets" data-testid="prop-req-attrs">
            <div className="panel-title">Requirement attributes</div>
            {RM_FACETS.map((key) => {
              const values = RM_ENUM_VALUES[key];
              const value = requirementFacets[key] ?? '';
              return (
                <div className="field" key={key}>
                  <label>{facetLabel(key)}</label>
                  {values ? (
                    <select
                      data-testid={`prop-rm-${key}`}
                      value={value}
                      disabled={!facetsWritable}
                      title={facetsWritable ? undefined : FAULTED_DECLARATION_REFUSAL}
                      onChange={(e) => setRequirementAttr(id, key, e.target.value || null)}
                    >
                      <option value="">(unset)</option>
                      {values.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      data-testid={`prop-rm-${key}`}
                      // Committed on blur, not on every keystroke: each write is
                      // one undo step, and a step per character would bury the
                      // edit before it in a 50-deep stack.
                      defaultValue={value}
                      disabled={!facetsWritable}
                      title={facetsWritable ? undefined : FAULTED_DECLARATION_REFUSAL}
                      key={`${id}:${key}:${value}`}
                      onBlur={(e) => {
                        const next = e.currentTarget.value.trim();
                        if (next !== value) setRequirementAttr(id, key, next || null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {isTransition && (
          <>
            <div className="field">
              <label>Trigger</label>
              <input
                data-testid="prop-trigger"
                value={attrString(el, 'trigger')}
                onChange={(e) => setAttrOrClear('trigger', e.target.value)}
              />
            </div>
            <div className="field">
              <label>Guard</label>
              <input
                data-testid="prop-guard"
                value={attrString(el, 'guard')}
                onChange={(e) => setAttrOrClear('guard', e.target.value)}
              />
            </div>
            <div className="field">
              <label>Effect</label>
              <input
                data-testid="prop-effect"
                value={attrString(el, 'effect')}
                onChange={(e) => setAttrOrClear('effect', e.target.value)}
              />
            </div>
          </>
        )}

        <div className="field">
          <label>Documentation</label>
          <textarea
            data-testid="prop-doc"
            value={docBody}
            onChange={(e) => commitDoc(e.target.value)}
          />
        </div>

        {(types.length > 0 || specializations.length > 0 || connections.length > 0) && (
          <div className="properties-relations">
            <div className="panel-title">Relationships</div>

            {types.length > 0 && (
              <div className="field">
                <label>Types</label>
                <ul className="rel-list">
                  {types.map((t) => (
                    <li key={t.id}>{refLabel(t)}</li>
                  ))}
                </ul>
              </div>
            )}

            {specializations.length > 0 && (
              <div className="field">
                <label>Specializations</label>
                <ul className="rel-list">
                  {specializations.map((s) => (
                    <li key={s.id}>
                      «{TEXTUAL_KEYWORD[s.eClass] ?? s.eClass}» →{' '}
                      {(s.target ?? [])
                        .map((tid) => {
                          const t = model.get(tid);
                          return t ? refLabel(t) : tid;
                        })
                        .join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {connections.length > 0 && (
              <div className="field">
                <label>Connections</label>
                <ul className="rel-list">
                  {connections.map((c) => {
                    const srcs = (c.source ?? []).map((s) => model.get(s));
                    const tgts = (c.target ?? []).map((t) => model.get(t));
                    const fmt = (recs: (ElementRecord | undefined)[]) =>
                      recs.map((r) => (r ? refLabel(r) : '?')).join(', ');
                    return (
                      <li key={c.id}>
                        «{c.eClass}» {fmt(srcs)} → {fmt(tgts)}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}

        {el && metrics && (
          <div className="properties-relations" data-testid="prop-metrics">
            <div className="panel-title">Metrics</div>
            <div className="metrics-grid">
              <span>Children</span>
              <span data-testid="metric-children">{metrics.children}</span>
              <span>Descendants</span>
              <span data-testid="metric-descendants">
                {metrics.descendants}
                {metrics.capped ? '+' : ''}
              </span>
              <span>References out</span>
              <span data-testid="metric-fanout">{metrics.fanOut}</span>
              <span>Referenced by</span>
              <span data-testid="metric-fanin">{usedBy.length}</span>
              {prScore !== undefined && (
                <>
                  <span title="PageRank centrality within the user model (whole-graph); higher = more central">
                    Centrality
                  </span>
                  <span data-testid="metric-pagerank">
                    {prScore.toFixed(4)}
                    {prRank !== undefined && (
                      <span className="metric-note"> · #{prRank} of {centrality.nodeCount}</span>
                    )}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="properties-relations" data-testid="prop-used-by">
          <div className="panel-title">Used by ({usedBy.length})</div>
          {usedBy.length > 0 ? (
            <ul className="rel-list">
              {/* Cap the rendered list: a widely-referenced element (e.g. a base
                  type) can have hundreds/thousands of referencers, and one DOM
                  node each would blow up the render. The count above stays exact. */}
              {usedBy.slice(0, MAX_USED_BY).map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    className="rel-list-link"
                    data-testid="prop-used-by-item"
                    title={u.qualifiedName || u.eClass}
                    onClick={() => select(u.id)}
                  >
                    {u.declaredName || `«${u.eClass}»`}
                  </button>
                </li>
              ))}
              {usedBy.length > MAX_USED_BY && (
                <li className="rel-empty">…and {usedBy.length - MAX_USED_BY} more</li>
              )}
            </ul>
          ) : (
            <div className="rel-empty">Not referenced by any element.</div>
          )}
        </div>

        {el && (
          <div className="properties-relations" data-testid="prop-impact">
            <button
              type="button"
              className="prop-impact-toggle"
              data-testid="prop-impact-toggle"
              aria-expanded={showImpact}
              onClick={() => setShowImpact((v) => !v)}
            >
              <span aria-hidden="true">{showImpact ? '▾' : '▸'}</span> Impact graph
            </button>
            {showImpact && (
              <ImpactGraph model={model} focusId={el.id} rev={rev} onSelect={select} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Properties;
