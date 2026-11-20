// SysML v2 / KerML textual-notation grammar (Langium).
//
// CLEAN-ROOM: authored originally for this project from the OMG SysML v2 /
// KerML textual-notation BNF (the standard's normative interface, clause 8.2 of
// each spec) and this repository's own engineering reference
// (docs/02-omg-standard-reference.md). No grammar/parser text was copied or
// transcribed from SysIDE/Syside, the OMG pilot implementation, or any other
// repository. Langium itself is MIT. The EPL-2.0 standard library is used only
// as an external parse corpus (scripts/grammar-coverage.ts) to MEASURE
// coverage; none of its text is embedded here.
//
// This grammar is purely SYNTACTIC: cross-references (types, connection ends,
// transition endpoints, satisfy/allocate targets) are parsed as QualifiedName
// strings and resolved later by the AST->Model mapper (mirroring the legacy
// parser's name resolution against the built model). The subset of rules and
// property names consumed by src/text/langium/map-to-model.ts (Definition,
// Specialization, Multiplicity, Import, Connect, Satisfy, Allocate, Succession,
// FirstThen, Transition, StateBehavior, ControlNode, RequirementClause, Doc,
// Comment, Annotation, Body and the Expression tree) is kept STABLE so the
// existing Model shape — and the whole test suite — is preserved; every other
// construct family below is purely ADDITIVE (the mapper ignores it for now).

grammar SysML

// ─────────────────────────────── entry ───────────────────────────────

entry Namespace:
    (members+=Member)*;

// A member is any top-level or nested statement / declaration. Ordering is
// significant: keyword-led statements come first, the general Definition/usage
// rule next, and the two QualifiedName-led shorthands (FirstThen / arrow
// transition) last, so Chevrotain's lookahead never mis-commits.
Member:
      DocComment
    | Comment
    | TextualRep
    | Import
    | Alias
    | Dependency
    | Annotation
    | ConnectStmt
    | BindStmt
    | BindingStmt
    | SatisfyStmt
    | VerifyStmt
    | RefineStmt
    | TraceStmt
    | DeriveStmt
    | AllocateStmt
    | SuccessionStmt
    | RelationshipStmt
    | TransitionStmt
    | StateBehavior
    | ControlNode
    | ReturnStmt
    | LoopStmt
    | IfStmt
    | BehaviorStmt
    | RequirementClause
    | Definition
    | FirstThenStmt;

// ─────────────────────── documentation & comments ────────────────────
// `/* … */` (REGULAR_COMMENT) is a first-class element in the notation (NOT
// hidden whitespace); `//` line notes and `//* … */` multiline notes are
// hidden. See ML_COMMENT / SL_COMMENT / ML_NOTE below.

DocComment infers Doc:
    'doc' (name=Name)? ('locale' locale=STRING)? body=ML_COMMENT ';'?;

Comment infers Comment:
    'comment' (name=Name)?
    ('about' about+=QualifiedName (',' about+=QualifiedName)*)?
    ('locale' locale=STRING)?
    body=ML_COMMENT ';'?;

// A free-standing `/* … */`, or a textual representation `rep`/`language`.
TextualRep infers TextualRep:
      ('rep' (name=Name)?)? 'language' language=STRING body=ML_COMMENT ';'?
    | body=ML_COMMENT;

// ─────────────────────────────── import ──────────────────────────────

Import infers Import:
    (visibility=Visibility)? 'import' ('all')? importedName=ImportName
    ('[' filters+=Expression ']')* ';'?;

// e.g. `A::B::C`, `A::B::*` (wildcard), `A::B::**` (recursive), `$::x` (global).
ImportName returns string:
    ('$' '::')? (Name | '*' | '**') (('::' | '.') (Name | '*' | '**'))*;

// ─────────────────────────────── alias ───────────────────────────────

Alias infers Alias:
    (visibility=Visibility)? 'alias' ('<' shortName=Name '>')? (name=Name)?
    'for' target=QualifiedName (body=Body | ';')?;

// ───────────────────────────── dependency ────────────────────────────
// `dependency (id 'from')? A, B to C, D ;`

Dependency infers Dependency:
    (prefixMeta+=PrefixMetadata)*
    'dependency' (('<' shortName=Name '>')? (name=Name)? 'from')?
    client+=QualifiedName (',' client+=QualifiedName)*
    'to' supplier+=QualifiedName (',' supplier+=QualifiedName)*
    (body=Body | ';')?;

// ─────────────────────── metadata annotation (@) ─────────────────────

// The keyword form `metadata T about A, B { … }` (SysML 7.27.2's own example,
// `metadata ApprovalAnnotation about Design { … }`) is the same annotating
// usage spelled with the keyword. `about` is REQUIRED in that spelling: without
// it `metadata N { … }` is the long-standing named usage (BaseKeyword), which
// this rule must not capture. The standard reads a bare `metadata T;` as typed
// by T (BNF `MetadataUsageDeclaration`); that reading is not built here.
// BNF `MemberPrefix` lets either spelling start with a visibility word
// (`public @T about A;`), and `MetadataUsageDeclaration` lets both spellings
// name the usage: its Identification (a short name in `<…>`, a name, or both)
// then `:` or `typed by` (`metadata N : T about A;`, 7.27.2's
// `securityDesignAnnotation`; `@N : T about A;`; `metadata <sn> N : T about A;`).
// The two-token lookahead is Name then `:` (a name) against Name then `::`, `about`,
// `{` or `;` (the type itself).
Annotation infers Annotation:
      (visibility=Visibility)? '@' (('<' shortName=Name '>')? name=Name? (':' | 'typed' 'by'))? type=QualifiedName
      ('about' about+=QualifiedName (',' about+=QualifiedName)*)?
      (body=Body)? ';'?
    | (visibility=Visibility)? 'metadata' (('<' shortName=Name '>')? name=Name? (':' | 'typed' 'by'))? type=QualifiedName
      'about' about+=QualifiedName (',' about+=QualifiedName)*
      (body=Body)? ';'?;

// Prefix metadata `#Meta` (used both as a member and as a Definition prefix).
PrefixMetadata infers PrefixMetadata:
    '#' type=QualifiedName;

// ─────────────────────── endpoint-bearing statements ─────────────────

ConnectStmt infers Connect:
    (visibility=Visibility)? 'connect' ('(')? source=QualifiedName ('to' | ',') target=QualifiedName (')')? (body=Body | ';')?;

// `bind a = b;`  /  `bind a = b { … }`  (BindingConnector shorthand).
BindStmt infers Bind:
    (visibility=Visibility)? 'bind' source=QualifiedName ('=' target=QualifiedName)? (body=Body | ';')?;

// `binding (name)? [m]? A (= [m]? B)?` — the `binding` connector-usage form,
// which may bind feature chains (`monitor1.onOccurrence`) with end multiplicities.
BindingStmt infers Bind:
    (visibility=Visibility)? 'binding'
    (bindMult+=Multiplicity)?
    // The connector may spell out its related features with `bind`, each
    // preceded by an end multiplicity: `binding [1] bind [0..*] a = [0..*] b`.
    ('bind' (srcMult+=Multiplicity)?)?
    (source=QualifiedName (srcMult+=Multiplicity)?)?
    ('of' (ofMult+=Multiplicity)? ofPayload=QualifiedName)?
    ('=' (tgtMult+=Multiplicity)? target=QualifiedName)?
    (body=Body | ';')?;

SatisfyStmt infers Satisfy:
    (visibility=Visibility)? 'satisfy' ('requirement')? requirement=QualifiedName
    ('by' satisfier=QualifiedName)? (body=Body | ';')?;

// Requirement cross-relationship statements (mirroring SatisfyStmt). The
// `by`/`to`/`from` tail is MANDATORY: it is what keeps a member-level
// `verify R by X;` (a Verify relationship) unambiguous with the nested
// RequirementClause form `verify (requirement)? R;` (a verification-case
// objective member), which can never contain a bare `by`.
VerifyStmt infers Verify:
    (visibility=Visibility)? 'verify' ('requirement')? requirement=QualifiedName
    'by' by=QualifiedName ';';

RefineStmt infers Refine:
    (visibility=Visibility)? 'refine' ('requirement')? requirement=QualifiedName
    'by' by=QualifiedName ';';

TraceStmt infers Trace:
    (visibility=Visibility)? 'trace' ('requirement')? requirement=QualifiedName
    'to' to=QualifiedName ';';

DeriveStmt infers Derive:
    (visibility=Visibility)? 'derive' ('requirement')? requirement=QualifiedName
    'from' from=QualifiedName ';';

AllocateStmt infers Allocate:
    (visibility=Visibility)? 'allocate' source=QualifiedName 'to' target=QualifiedName (body=Body | ';')?;

// `succession (n first)? [m]? A then [m]? B;` — succession shorthand with
// optional name (always followed by `first`) and end multiplicities.
SuccessionStmt infers Succession:
    (visibility=Visibility)? 'succession' (isSufficient?='all')?
    (succMult+=Multiplicity)?
    ( name=Name (succMult+=Multiplicity)? 'first' (srcMult+=Multiplicity)?
    | 'first' (srcMult+=Multiplicity)? )?
    source=QualifiedName
    (tgtMult+=Multiplicity)? 'then' (t2Mult+=Multiplicity)? target=QualifiedName
    (body=Body | ';')?;

// Named KerML relationship elements: `subset A subsets B;`, `redefinition R
// redefines X;`, `specialization S subtype A specializes B;`, etc. The related
// features may be feature chains, so the source is a QualifiedName.
RelationshipStmt infers RelationshipStmt:
    (visibility=Visibility)?
    ( kind=('subtype' | 'subclassifier' | 'subset' | 'redefinition' | 'typing')
        source=QualifiedName (specializations+=Specialization)+
    | kind='disjoint' source=QualifiedName 'from' target=QualifiedName )
    (body=Body | ';')?;

// `first A then B;`  or  `then B;`
FirstThenStmt infers FirstThen:
      'first' source=QualifiedName 'then' target=QualifiedName ';'?
    | 'then' target=QualifiedName ';'?;

// ─────────────────────────── transitions ─────────────────────────────

TransitionStmt infers Transition:
    'transition'
    // `transition t2 :>> t1 first a …` (SysML v2): a Specialization-style tail (`:>>` / `redefines`) before `first`.
    (name=Name (specializations+=Specialization)? 'first' | specializations+=Specialization 'first' | ('first')?)
    source=QualifiedName
    (clauses+=TransitionClause)*
    ('then' | '->') target=QualifiedName
    (clauses+=TransitionClause)*
    (body=Body | ';')?;

// (A bare `A -> B` transition shorthand is intentionally NOT a member: it would
// be indistinguishable from a `->` function-operation expression. Use the
// `transition A -> B` keyword form, which the serializer always emits.)

TransitionClause:
    AcceptClause | GuardClause | EffectClause;

AcceptClause infers AcceptClause:
    'accept' payload=QualifiedName (':' payloadType=QualifiedName)? ('via' via=QualifiedName)?
    // `accept after 5[min]` (SysML v2 §7.18.3): a time trigger. `after` is NOT a keyword here, so it stays a valid
    // name; it is read as the payload name and the mapper recognises the exact shape `after` + a delay expression.
    (delay=DelayExpr)?;

// The delay of a time trigger: a number with an optional unit bracket (`5[min]`, `2`). It is NOT a general Expression:
// that would read the `if` of a following guard as a conditional expression (`accept b if n < 0 then s`).
DelayExpr infers Expression:
    {infer NumberLiteral} value=NUMBER ({infer BracketExpr.base=current} '[' arg=Expression ']')?;

GuardClause infers GuardClause:
      '[' expr=Expression ']'
    | 'if' expr=Expression;

EffectClause infers EffectClause:
    // `do assign x := 2` (SysML v2 §7.18.3): the effect written as an inline assignment, read as the effect text `x = 2`.
    // The value follows `:=`, never a bare name, so a following `then` / `if` / `accept` is not swallowed.
    'do' ( 'assign' assignTarget=QualifiedName ':=' assignValue=Expression | ('action')? effect=QualifiedName );

// ─────────────────── state behaviours & control nodes ────────────────

StateBehavior infers StateBehavior:
    kind=('entry' | 'do' | 'exit')
    // `entry action initial;` (SysML v2 §7.18.2): after `action`, `initial` is the action's NAME (it is otherwise a
    // control-node keyword, which read here as a second member and dropped the name). Only after `action`.
    (isAction?='action' (name=Name | name='initial')? | (name=Name (('::' | '.') chain+=RefName)*)?)
    (specializations+=Specialization | multiplicity+=Multiplicity)*
    (valueOp=ValueOp value=Expression)?
    // `entry assign x := 1;` / `do send X to Y;`: an action statement written in place of a body. The notation takes
    // it as the behaviour's own action; it is read and REFUSED by the mapper (it used to split into a nameless
    // behaviour plus a loose action statement, silently).
    (body=Body | ';' | inline=BehaviorStmt)?;

ControlNode infers ControlNode:
    kind=('fork' | 'join' | 'merge' | 'decide' | 'initial' | 'done') (name=Name)?
    (specializations+=Specialization)* (body=Body | ';')?;

// ───────────────────── behavioural action statements ─────────────────
// accept / send / assign / perform / exhibit / include / terminate, each
// optionally prefixed by the `first`/`then` succession shorthand.

BehaviorStmt infers BehaviorStmt:
    (succession=('first' | 'then'))?
    (visibility=Visibility)?
    // `abstract exhibit state x;` (SysML v2 §7.18.2: an exhibit state usage takes the usage prefix).
    (isAbstract?='abstract')?
    // `accept E if c do action eff then s;` / `accept after 5[min] then s;` (SysML v2 §7.18.3, the target transition):
    // an accept written in a state body. The delay is a DelayExpr (never a general Expression, which would swallow the
    // `if` guard), the guard is the `if` form only (a `[…]` is a multiplicity here) and the effect names an action.
    ( kind='accept'
      ('action' | 'state' | 'use' 'case')?
      ('<' shortName=Name '>')?
      (name=Name)?
      BehaviorStmtRest
      (delay=DelayExpr)?
      ('if' guard=Expression)?
      ('do' ( 'assign' assignTarget=QualifiedName ':=' assignValue=Expression | ('action')? effect=QualifiedName ))?
      (body=Body | ';')?
    | kind=('send' | 'assign' | 'perform' | 'include' | 'terminate')
      ('action' | 'state' | 'use' 'case')?
      ('<' shortName=Name '>')?
      (name=Name)?
      BehaviorStmtRest
      (body=Body | ';')?
    // `exhibit state es parallel { … }`: BNF `ExhibitStateUsage` ends in the same
    // `StateUsageBody` as a state usage (SysML v2 §8.2.2.18.2), so `parallel` may
    // stand just before the body. As on `state` (see StateDeclarationTail), the
    // keyword is read only after a written name, so that `exhibit state parallel
    // { … }` stays an exhibit state NAMED `parallel` and the two readings never
    // compete for one token. The short-name-only spelling `exhibit state <M>
    // parallel { … }` parses with `parallel` in the name slot; the mapper reads
    // that exact shape (the word itself, unquoted, then the body) as the keyword,
    // only after `state` (`exhibit <E> parallel { … }` keeps the name).
    // `parallel` belongs to an exhibit STATE only: `exhibit action …` and `exhibit use case …` take the plain tail.
    | kind='exhibit'
      ('action' | 'use' 'case')
      ('<' shortName=Name '>')?
      (name=Name)?
      BehaviorStmtRest
      (body=Body | ';')?
    | kind='exhibit'
      (exhibitState?='state')?
      ('<' shortName=Name '>')?
      ( name=Name (('::' | '.') chain+=RefName)* BehaviorStmtRest ( isParallel?='parallel' body=Body | body=Body | ';' )?
      | BehaviorStmtRest (body=Body | ';')? )
    );

fragment BehaviorStmtRest:
    (specializations+=Specialization | multiplicity+=Multiplicity)*
    ('via' via=QualifiedName)?
    ('to' target=QualifiedName)?
    (valueOp=ValueOp value=Expression)?;

// `return (ref)? name (: T)? (= expr)? { … }`
ReturnStmt infers ReturnStmt:
    'return' ('ref')? (name=Name)?
    (specializations+=Specialization | multiplicity+=Multiplicity)*
    (valueOp=ValueOp value=Expression)?
    (body=Body | ';')?;

// `while c { … }`  /  `until c { … }`  /  `for x (: T)? in coll { … }`  /  `loop { … }`
LoopStmt infers LoopStmt:
    (succession=('first' | 'then'))?
    ( kind='while' cond=Expression
    | kind='until' cond=Expression
    | kind='for' var=Name (':' varType=QualifiedName)? 'in' coll=Expression
    | kind='loop' )
    (body=Body | ';')?;

// `if c { … } (else { … })?`  (member-level IfActionUsage)
IfStmt infers IfStmt:
    (succession=('first' | 'then'))?
    // `if c then X;` (SysML v2 §7.18.2, a guarded succession): `then` + a mandatory `;` and NO `else`, so a conditional
    // EXPRESSION (`if c then a else b`, a calc body) is never read as this statement.
    'if' cond=Expression ( 'then' thenTarget=QualifiedName ';'
      | (body=Body | target=QualifiedName ';'?)
        ('else' (elseBody=Body | elseTarget=QualifiedName ';'?))? );

// ─────────────────────── requirement clauses ─────────────────────────

RequirementClause infers RequirementClause:
    (visibility=Visibility)?
    ( kind='subject' (name=Name)?
        (specializations+=Specialization | multiplicity+=Multiplicity)*
        (valueOp=ValueOp value=Expression)? (body=Body | ';')?
    | kind=('actor' | 'stakeholder' | 'objective' | 'frame' | 'verify') ('requirement')?
        (name=Name)? (specializations+=Specialization | multiplicity+=Multiplicity)*
        (valueOp=ValueOp value=Expression)? (body=Body | ';')?
    // `assert not constraint c { … }` is the published grammar's negated assert. The `not` is parsed on any of the
    // three so the mapper can read it (a one-expression body) or refuse it (mapper/negated-assert-unread).
    | kind=('require' | 'assume' | 'assert') (negated?='not')? (declares=('constraint' | 'requirement'))? (name=Name)?
        (specializations+=Specialization)?
        ('{' (members+=Member)* (expr=Expression)? '}' | ';'?)
    );

// ─────────────────────── definitions & usages ────────────────────────
// The concrete metaclass (PartDefinition, PartUsage, …) is derived by the
// AST->Model mapper from `keyword` + `isDef` + `prefixes` (see TEXTUAL_KEYWORD
// in src/core/metamodel.ts). A keyword-less feature is legal only when at
// least one prefix (direction/modifier) is present — matching the legacy
// parser's `out fuelOut : Fuel;` / `end p : T;` handling.

Definition infers Definition:
      (succession=('first' | 'then'))?
      (prefixMeta+=PrefixMetadata)*
      (visibility=Visibility)?
      (
          prefixes+=Prefix (prefixes+=Prefix)*
          ( keyword='state' (isDef?='def' | prefixes+=Direction)? ( StateDeclarationTail | NamelessStateDeclarationTail )
          | keyword=BaseKeyword (isDef?='def' | prefixes+=Direction)? DeclarationTail
            // Keyword-less prefixed feature: its name must NOT be a word that
            // is also a BaseKeyword (see PlainRefName), so `ref occurrence :>> x`
            // deterministically parses as an anonymous occurrence usage — the
            // same alternative the ALL(*) conflict resolution used to pick,
            // but now without an "Ambiguous Alternatives" warning.
          | PlainDeclarationTail )
        | keyword='state' (isDef?='def' | prefixes+=Direction)? ( StateDeclarationTail | NamelessStateDeclarationTail )
        | keyword=BaseKeyword (isDef?='def' | prefixes+=Direction)? DeclarationTail
      )
      // A direction may also FOLLOW the keyword (`port in a : Pt;`). Without
      // this, `port` alone was a complete member (name and terminator are both
      // optional) and `in a : Pt` a second one — two PortUsages from one
      // declaration, one of them a nameless phantom, with no diagnostic. Only
      // a direction is admitted here, never the full Prefix set: `end`, `var`,
      // `member`… are also legal NAMES after a keyword (`action end;`), and a
      // direction token can begin nothing else at this point. Usages only —
      // `port def in X` stays rejected.
      // Keyword-less feature declared only by a specialization / multiplicity
      // (e.g. `:>> quantity = isq.L;` or `[1] :> x`) — a bare redefinition or
      // subsetting that owns a value. The leading spec disambiguates it from an
      // (invalid) empty member.
    | (visibility=Visibility)?
      specializations+=Specialization
      DeclSpecs DeclTailRest
      // Keyword-less, name-led feature: an enumeration literal (`open;`,
      // `low = 0.25;`) or an implicit parameter (`p2 : Point;`). A REQUIRED
      // terminator (spec / value / body / `;`) after the name keeps this from
      // colliding with a trailing expression that merely starts with a name.
    | (visibility=Visibility)?
      name=Name
      ( specializations+=Specialization DeclSpecs )?
      DeclMiddle (body=Body | ';')
      // A user-defined keyword standing without a reserved one (SysML 7.27.4; BNF ExtendedDefinition and
      // ExtendedUsage): `#situation def Failure;`, `#situation batteryLow;`, `#k :>> L = 3;`. The usage forms are the
      // two keyword-less alternatives above, tagged; the definition is refused by the mapper (no metaclass).
    | (prefixMeta+=PrefixMetadata)+
      (visibility=Visibility)?
      ( isDef?='def' DeclarationTail
      | specializations+=Specialization DeclSpecs DeclTailRest
      | name=Name ( specializations+=Specialization DeclSpecs )? DeclMiddle (body=Body | ';') );

// Declaration tail after a consumed BaseKeyword. The name may itself be a
// noun-like reserved word (`action behavior;`, `part step;`), so the broader
// RefName is used here; this does NOT reintroduce keyword/keyword-less
// ambiguity because a keyword has already been consumed.
fragment DeclarationTail:
    (isSufficient?='all')?
    // A connector/succession-style end multiplicity may precede the name
    // (`connector [0..1] end1 to [1..*] end2`). A name is REQUIRED after a
    // pre-name multiplicity: an anonymous `[0..1] :> x` tail is parsed with
    // the multiplicity in DeclSpecs instead, which removes the ambiguity
    // between the two placements (same language, one derivation).
    ( preMult+=Multiplicity ('<' shortName=Name '>')? name=RefName
    | ('<' shortName=Name '>')? (name=RefName)?
    )
    DeclSpecs
    DeclTailRest;

// Declaration tail for a keyword-LESS prefixed feature (`ref fuelOut : Fuel;`).
// Identical to DeclarationTail except the name uses PlainRefName (no word that
// is also a BaseKeyword), so `ref occurrence :>> x` cannot be parsed as a
// feature NAMED `occurrence` — only via the keyword alternative, which is the
// pick the ALL(*) conflict resolution already made (see the Definition rule).
fragment PlainDeclarationTail:
    (isSufficient?='all')?
    ( preMult+=Multiplicity ('<' shortName=Name '>')? name=PlainRefName
    | ('<' shortName=Name '>')? (name=PlainRefName)?
    )
    DeclSpecs
    DeclTailRest;

// Declaration tail for a state definition or usage. Identical to DeclarationTail
// except that the spec's `parallel` keyword may stand just before the body
// (SysML v2 §7.18.2; BNF `StateDefBody`/`StateUsageBody`:
// `';' | ( isParallel ?= 'parallel' )? '{' … '}'`). The keyword is legal on no
// other declaration, so it is admitted here rather than in the shared tail.
fragment StateDeclarationTail:
    (isSufficient?='all')?
    ( preMult+=Multiplicity )?
    ('<' shortName=Name '>')?
    name=RefName
    DeclSpecs
    StateDeclTailRest;

// A state declaration with no name (the BNF's Identification is optional), kept
// out of StateDeclarationTail so the optional-name choice can never compete with
// the `parallel` keyword for the same token: `state parallel { … }` is a state
// NAMED `parallel`, and the modifier is read only after a written name. The
// short-name-only spelling `state <M> parallel { … }` parses with `parallel` in
// the name slot of StateDeclarationTail (a third tail would compete with the name
// reading for the same token, an ALL(*) ambiguity); the mapper reads that exact
// shape — short name, the bare word, then the body — as the keyword, which is
// the spec's reading (`parallel` is reserved there), and keeps the name in every
// other shape (`state <M> parallel;`, `state <M> 'parallel' { … }`).
fragment NamelessStateDeclarationTail:
    (isSufficient?='all')?
    ('<' shortName=Name '>')?
    DeclSpecs
    DeclTailRest;

// The spec puts `parallel` just before the body and nowhere else:
// `';' | ( isParallel ?= 'parallel' )? '{' … '}'` (SysML v2 §7.18.2).
fragment StateDeclTailRest:
    DeclMiddle ( isParallel?='parallel' body=Body | body=Body | ';' )?;

// Specializations, multiplicities and `ordered`/`nonunique` may appear in any
// order and be interleaved (`: T [0..1] ordered :>> x`); one loop keeps it
// unambiguous (mirrors the KerML FeatureSpecializationPart production).
fragment DeclSpecs:
    (   specializations+=Specialization
      | multiplicity+=Multiplicity
      | modifiers+=FeatureModifier
    )*;

// `ordered` / `nonunique` multiplicity modifiers (collected as a list so they
// may repeat/interleave with specializations without a data-loss warning).
FeatureModifier returns string:
    'ordered' | 'nonunique';

// The clauses between the specialization part and the body/terminator: flow
// `of`/`from…to`, connector `connect…to`, `send…to`, feature value and the
// loop/while/for control clause.
fragment DeclMiddle:
    ('via' via=QualifiedName)?
    ('of' ofPayload=QualifiedName (ofMult+=Multiplicity)?)?
    ('from' (fromMult+=Multiplicity)? flowFrom=QualifiedName (fromSpecs+=Specialization)*
        'to' (toMult+=Multiplicity)? flowTo=QualifiedName (toSpecs+=Specialization)*)?
    ('connect' (connSrcMult+=Multiplicity)? connectSource=QualifiedName 'to' (connTgtMult+=Multiplicity)? connectTarget=QualifiedName)?
    ('to' (sendMult+=Multiplicity)? sendTarget=QualifiedName)?
    (valueOp=ValueOp value=Expression)?
    ( ctrl='while' ctrlCond=Expression
    | ctrl='until' ctrlCond=Expression
    | ctrl='for' ctrlVar=Name (':' ctrlType=QualifiedName)? 'in' ctrlColl=Expression
    | ctrl='loop' )?;

fragment DeclTailRest:
    DeclMiddle (body=Body | ';')?;

Body infers Body:
    '{' (members+=Member)* (expr=Expression)? '}';

Visibility returns string:
    'public' | 'private' | 'protected';

// Feature-value operator: `=` binding, `:=` initial value, `default …`.
ValueOp returns string:
    ':=' | '=' | 'default' ('=' | ':=')?;

// Feature direction. Also admitted directly after a usage keyword — see the
// note on `Definition`.
Direction returns string:
      'in' | 'out' | 'inout';

// Leading feature modifiers / directions (recorded by the mapper as flags).
Prefix returns string:
      Direction
    | 'abstract' | 'variation' | 'readonly' | 'derived' | 'composite'
    | 'portion' | 'individual' | 'end' | 'nonunique' | 'ordered' | 'variant'
    | 'standard' | 'library' | 'ref' | 'const' | 'constant' | 'var' | 'member'
    | 'snapshot' | 'timeslice' | 'event';

// Single base keyword; `def` handled separately. Multi-word keywords such as
// `use case` are recognised too.
//
// `state` is deliberately NOT here: it is a base keyword with a body of its own
// (SysML v2 §7.18.2, where `parallel` may stand just before the body), and a
// separate alternative keeps the two readings of `state def X …` disjoint at
// the keyword token rather than ambiguous after the name.
BaseKeyword returns string:
      'package' | 'namespace'
    // KerML types / features
    | 'type' | 'classifier' | 'class' | 'datatype' | 'struct'
    | 'assoc' | 'association' | 'behavior' | 'interaction'
    | 'function' | 'predicate' | 'metaclass' | 'feature' | 'step'
    | 'expr' | 'bool' | 'inv' | 'multiplicity' | 'connector'
    // SysML definitions / usages
    | 'part' | 'attribute' | 'item' | 'port' | 'connection' | 'interface'
    | 'flow' | 'action' | 'calc' | 'constraint' | 'requirement'
    | 'concern' | 'case' | 'analysis' | 'verification'
    | 'view' | 'viewpoint' | 'render' | 'rendering' | 'enum' | 'occurrence'
    | 'allocation' | 'metadata' | 'message' | 'render'
    | 'use' 'case';

// ─────────────────────────── specialization ──────────────────────────
// `:` typing, `:>` (sub)classification / subsetting, `:>>` redefinition,
// `::>` reference subsetting, plus keyword spellings and the KerML type
// relationships (chains / featured by / inverse of / intersects / unions /
// differences / disjoint from / conjugates / crosses). Comma-separated lists.

Specialization infers Specialization:
    op=SpecOp (conjugated?='~')? types+=QualifiedName
    (',' ('~')? types+=QualifiedName)*;

SpecOp returns string:
      ':>>' | '::>' | ':>' | ':'
    | 'specializes' | 'subsets' | 'redefines' | 'references' | 'conjugates'
    | 'crosses' | 'chains' | 'unions' | 'intersects' | 'differences'
    | 'typed' 'by' | 'featured' 'by' | 'defined' 'by'
    | 'inverse' 'of' | 'disjoint' 'from';

// ─────────────────────────── multiplicity ────────────────────────────
// `[ n ]`, `[ n..m ]`, `[ n..* ]`, `[ * ]`. A multiplicity belongs to the
// declaration part, BEFORE any feature value (KerML BNF: MultiplicityPart is
// in FeatureSpecializationPart; ValuePart carries none) — a bracket AFTER a
// value is the BracketExpression of the expression grammar, never this rule.

Multiplicity infers Multiplicity:
    '[' lower=MultTerm ('..' upper=MultTerm)? ']';

// A bound is a number, `*`, or a feature reference. A reference bound may carry
// a trailing `#( i )` sequence-index (`[ mRef.mRefs#(1) ]`, the KerML
// MultiplicityRange admits any expression as a bound and the index form is the
// one the library writes).
MultTerm returns string:
    NUMBER | '*' | QualifiedName ('#' '(' (NUMBER | QualifiedName) ')')?;

// ─────────────────────────── expressions ─────────────────────────────
// Precedence low→high: conditional < implies < ?? < or/xor < and < | < & <
// equality < classification/relational < range < additive < multiplicative <
// power < unary < postfix < primary. All binary operators are left-associative
// except power (right); grouping is by nesting, not encoded here (parse only).

Expression:
    ImpliesExpr;

ImpliesExpr infers Expression:
    NullCoalesceExpr ({infer BinaryExpr.left=current} op='implies' right=NullCoalesceExpr)*;

NullCoalesceExpr infers Expression:
    OrExpr ({infer BinaryExpr.left=current} op='??' right=OrExpr)*;

OrExpr infers Expression:
    AndExpr ({infer BinaryExpr.left=current} op=('or' | 'xor' | '||') right=AndExpr)*;

AndExpr infers Expression:
    BitOrExpr ({infer BinaryExpr.left=current} op=('and' | '&&') right=BitOrExpr)*;

BitOrExpr infers Expression:
    BitAndExpr ({infer BinaryExpr.left=current} op='|' right=BitAndExpr)*;

BitAndExpr infers Expression:
    EqualityExpr ({infer BinaryExpr.left=current} op='&' right=EqualityExpr)*;

EqualityExpr infers Expression:
    ClassificationExpr ({infer BinaryExpr.left=current} op=('==' | '!=' | '===' | '!==') right=ClassificationExpr)*;

ClassificationExpr infers Expression:
    RelationalExpr ({infer BinaryExpr.left=current} op=('istype' | 'hastype' | '@@' | '@' | 'as' | 'meta') right=RelationalExpr)*;

RelationalExpr infers Expression:
    RangeExpr ({infer BinaryExpr.left=current} op=('<=' | '>=' | '<' | '>') right=RangeExpr)*;

RangeExpr infers Expression:
    AdditiveExpr ({infer BinaryExpr.left=current} op='..' right=AdditiveExpr)*;

AdditiveExpr infers Expression:
    MultiplicativeExpr ({infer BinaryExpr.left=current} op=('+' | '-') right=MultiplicativeExpr)*;

MultiplicativeExpr infers Expression:
    PowerExpr ({infer BinaryExpr.left=current} op=('*' | '/' | '%') right=PowerExpr)*;

PowerExpr infers Expression:
    UnaryExpr ({infer BinaryExpr.left=current} op=('^' | '**') right=UnaryExpr)*;

UnaryExpr infers Expression:
      {infer UnaryExpr} op=('-' | '+' | 'not' | '~') operand=UnaryExpr
    | PostfixExpr;

// Postfix chain: invocation `f(a,b)`, bracket `x[u]`, index `x#(i)`, navigation
// `x->op{…}`, collect `x.{…}`, select `x.?{…}`.
PostfixExpr infers Expression:
    PrimaryExpr (
        {infer InvocationExpr.callee=current} '(' (args+=Argument (',' args+=Argument)*)? ')'
      // The spec BracketExpression (KerML textual BNF 1099-1102): a PRIMARY
      // followed by `[ expr ]`, an invocation of the library function
      // `BaseFunctions::'['`. Its quantity overload `QuantityCalculations::'['`
      // (num, mRef) is how SysML v2 spells a quantity literal — `25.0 [kg]`,
      // `48 [h]`, `5 [SI::kg]`, `18 ['in']` — anywhere an expression may appear,
      // constraint bodies included. It binds tighter than every binary operator:
      // the pilot's own XMI groups `229835/900 [K]` as `229835/(900 [K])`, and
      // `(a + b) [mm]` needs the parentheses for the same reason. Indexing is
      // the SEPARATE `#( … )` function below, not `x[i]`.
      | {infer BracketExpr.base=current} '[' arg=Expression ']'
      | {infer IndexExpr.base=current} '#' '(' (index=Expression)? ')'
      | {infer NavExpr.base=current} '->' op=QualifiedName
            ( '(' (args+=Argument (',' args+=Argument)*)? ')' | body=Body | funcRef=QualifiedName )?
      | {infer SelectExpr.base=current} '.?' body=Body
      | {infer CollectExpr.base=current} '.' body=Body
      | {infer FeatureChainExpr.base=current} '.' member=QualifiedName
    )*;

// Invocation argument: positional expression or `name = expr` (named).
Argument infers Argument:
      name=QualifiedName '=' value=Expression
    | value=Expression;

PrimaryExpr infers Expression:
      {infer NullLiteral} '(' ')'
    | '(' Expression ({infer SequenceExpr.items+=current} (',' items+=Expression)+)? ')'
    | {infer ConditionalExpr} 'if' cond=Expression ('?' | 'then') thenExpr=Expression 'else' elseExpr=Expression
    | {infer ConstructorExpr} 'new' type=QualifiedName '(' (args+=Argument (',' args+=Argument)*)? ')'
    | {infer BodyExpr} body=Body
    | {infer NumberLiteral} value=NUMBER
    | {infer StringLiteral} value=STRING
    | {infer BoolLiteral} value=('true' | 'false')
    | {infer NullLiteral} 'null'
    | {infer MetadataAccessExpr} '#' ref=QualifiedName
    | {infer RefExpr} ('$' '::')? ref=QualifiedName;

// ─────────────────────────── names & terminals ───────────────────────

// Qualified / feature-chain REFERENCE: `A::B.c`. Reference segments may be any
// noun-like reserved word, because the standard library defines features named
// e.g. `step`, `feature`, `do`, `entry`. These reference names are deliberately
// NOT accepted as declaration `Name`s, so keyword-led declarations stay
// unambiguous with keyword-less ones.
QualifiedName returns string:
    RefName (('::' | '.') RefName)*;

RefName returns string:
    ID | UNRESTRICTED_NAME | KeywordName;

// Declaration name usable where NO keyword was consumed (keyword-less prefixed
// features): RefName minus the words that are also BaseKeywords, so a leading
// `ref occurrence …` always resolves the word to the keyword alternative
// (matching the ALL(*) first-alternative pick) instead of being ambiguous.
PlainRefName returns string:
    ID | UNRESTRICTED_NAME | NonKeywordName;

// KeywordName members that are NOT BaseKeywords (keep in sync with both lists).
// NOTE `done` is deliberately absent: it leads a ControlNode, so a keyword-less
// declaration starting with `done` must resolve to that control node, not to a
// feature named `done`. It IS a SoftKeyword (declaration name after a consumed
// keyword) and a KeywordName (reference segment) — both needed by the OMG
// Systems Library's `Actions.sysml`.
NonKeywordName returns string:
      'succession' | 'transition' | 'accept' | 'send' | 'do' | 'entry' | 'exit'
    | 'end' | 'frame' | 'member' | 'event' | 'snapshot' | 'individual'
    | 'parallel';

// Reserved words that may also appear as feature names in a reference. Only
// noun/modifier keywords are included; structural/operator words (`to`, `then`,
// `if`, `of`, `in`, `and`, …) are excluded so reference boundaries stay clear.
// The set is kept to those the standard library actually uses as feature names:
// QualifiedName is referenced from ~30 grammar decision points, so each extra
// keyword-token widens the parser's lookahead sets and superlinearly inflates
// Chevrotain's one-time parser-construction cost (a full ~70-word set pushes it
// past 20 s). This curated set keeps construction near ~1 s while preserving
// corpus coverage (measured on the generated parser: ~0.8 s before the
// BracketExpression alternative, ~1.2 s with it).
KeywordName returns string:
      'type' | 'classifier' | 'behavior' | 'interaction' | 'function' | 'predicate'
    | 'metaclass' | 'feature' | 'step' | 'multiplicity' | 'connector' | 'association' | 'member'
    | 'part' | 'item' | 'port' | 'flow' | 'action' | 'state' | 'metadata'
    | 'occurrence' | 'event' | 'snapshot' | 'individual' | 'succession' | 'transition'
    | 'accept' | 'send' | 'do' | 'entry' | 'exit' | 'end' | 'frame' | 'done'
    // `parallel` is a state-modifier keyword (7.18.2) and also an ordinary
    // feature name; a reference must keep resolving the word either way.
    | 'parallel';

// A DECLARATION name: an identifier, a single-quoted 'unrestricted name', or a
// small set of soft reserved words the library also uses as declared names.
Name returns string:
    ID | UNRESTRICTED_NAME | SoftKeyword;

// `derive` is a relationship keyword (`derive requirement r from s`) that the
// library also uses as a SHORT name (`metadata def <derive> …` in
// RequirementDerivation.sysml); as a soft keyword it costs no construction
// time and adds no ambiguity. Like every soft keyword it is a `Name` but not a
// `RefName`, so `part def derive;` splits into a nameless definition plus a
// keyword-less `'derive'` (the same shape `filter`/`var` already have) —
// pinned in langium.grammar.test.ts rather than widened here.
SoftKeyword returns string:
      'var' | 'multiplicity' | 'about' | 'locale' | 'filter' | 'done' | 'derive'
    | 'parallel';

terminal ID: /[_a-zA-Z][\w]*/;
// Single-quoted unrestricted name (value keeps its quotes; the mapper strips).
terminal UNRESTRICTED_NAME: /'(\\.|[^'\\])*'/;
terminal NUMBER returns number: /[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/;
terminal STRING: /"(\\.|[^"\\])*"/;

// `/* … */` REGULAR_COMMENTs are semantic elements → NOT hidden (consumed by
// doc / comment / TextualRep rules). `//* … */` multiline notes and `//` line
// notes and whitespace are hidden. ML_NOTE must precede SL_COMMENT so that a
// multiline `//* … */` note is not truncated at the first line terminator.
hidden terminal ML_NOTE: /\/\/\*[\s\S]*?\*\//;
terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
hidden terminal WS: /\s+/;
