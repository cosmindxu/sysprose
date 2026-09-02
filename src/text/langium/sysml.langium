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

Annotation infers Annotation:
    '@' type=QualifiedName
    ('about' about+=QualifiedName (',' about+=QualifiedName)*)?
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
    (name=Name 'first' | ('first')?)
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
    'accept' payload=QualifiedName (':' payloadType=QualifiedName)? ('via' via=QualifiedName)?;

GuardClause infers GuardClause:
      '[' expr=Expression ']'
    | 'if' expr=Expression;

EffectClause infers EffectClause:
    'do' ('action')? effect=QualifiedName;

// ─────────────────── state behaviours & control nodes ────────────────

StateBehavior infers StateBehavior:
    kind=('entry' | 'do' | 'exit') ('action')? (name=Name)?
    (specializations+=Specialization | multiplicity+=Multiplicity)*
    (valueOp=ValueOp value=Expression)?
    (body=Body | ';')?;

ControlNode infers ControlNode:
    kind=('fork' | 'join' | 'merge' | 'decide' | 'initial' | 'done') (name=Name)?
    (specializations+=Specialization)* (body=Body | ';')?;

// ───────────────────── behavioural action statements ─────────────────
// accept / send / assign / perform / exhibit / include / terminate, each
// optionally prefixed by the `first`/`then` succession shorthand.

BehaviorStmt infers BehaviorStmt:
    (succession=('first' | 'then'))?
    (visibility=Visibility)?
    kind=('accept' | 'send' | 'assign' | 'perform' | 'exhibit' | 'include' | 'terminate')
    ('action' | 'state' | 'use' 'case')?
    ('<' shortName=Name '>')?
    (name=Name)?
    (specializations+=Specialization | multiplicity+=Multiplicity)*
    ('via' via=QualifiedName)?
    ('to' target=QualifiedName)?
    (valueOp=ValueOp value=Expression)?
    (body=Body | ';')?;

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
    'if' cond=Expression (body=Body | target=QualifiedName ';'?)
    ('else' (elseBody=Body | elseTarget=QualifiedName ';'?))?;

// ─────────────────────── requirement clauses ─────────────────────────

RequirementClause infers RequirementClause:
    (visibility=Visibility)?
    ( kind='subject' (name=Name)?
        (specializations+=Specialization | multiplicity+=Multiplicity)*
        (valueOp=ValueOp value=Expression)? (body=Body | ';')?
    | kind=('actor' | 'stakeholder' | 'objective' | 'frame' | 'verify') ('requirement')?
        (name=Name)? (specializations+=Specialization | multiplicity+=Multiplicity)*
        (valueOp=ValueOp value=Expression)? (body=Body | ';')?
    | kind=('require' | 'assume' | 'assert') ('constraint' | 'requirement')? (name=Name)?
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
          ( keyword=BaseKeyword (isDef?='def' | prefixes+=Direction)? DeclarationTail
            // Keyword-less prefixed feature: its name must NOT be a word that
            // is also a BaseKeyword (see PlainRefName), so `ref occurrence :>> x`
            // deterministically parses as an anonymous occurrence usage — the
            // same alternative the ALL(*) conflict resolution used to pick,
            // but now without an "Ambiguous Alternatives" warning.
          | PlainDeclarationTail )
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
      DeclMiddle (body=Body | ';');

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
    (valueOp=ValueOp value=Expression (valueMult=Multiplicity)?)?
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
BaseKeyword returns string:
      'package' | 'namespace'
    // KerML types / features
    | 'type' | 'classifier' | 'class' | 'datatype' | 'struct'
    | 'assoc' | 'association' | 'behavior' | 'interaction'
    | 'function' | 'predicate' | 'metaclass' | 'feature' | 'step'
    | 'expr' | 'bool' | 'inv' | 'multiplicity' | 'connector'
    // SysML definitions / usages
    | 'part' | 'attribute' | 'item' | 'port' | 'connection' | 'interface'
    | 'flow' | 'action' | 'state' | 'calc' | 'constraint' | 'requirement'
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
// `[ n ]`, `[ n..m ]`, `[ n..* ]`, `[ * ]`, or a trailing unit like `[ kg ]`.

Multiplicity infers Multiplicity:
    '[' lower=MultTerm ('..' upper=MultTerm)? ']';

// A bound is a number, `*`, or a feature reference. A reference bound may carry
// a trailing `#( i )` sequence-index (`[ mRef.mRefs#(1) ]`); the index token
// disambiguates the value-multiplicity bracket from a bare `x[i]` postfix index
// (which the notation deliberately omits) — a `[` here is always a multiplicity.
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

// Postfix chain: invocation `f(a,b)`, index `x[i]` / `x#(i)`, navigation
// `x->op{…}`, collect `x.{…}`, select `x.?{…}`.
PostfixExpr infers Expression:
    PrimaryExpr (
        {infer InvocationExpr.callee=current} '(' (args+=Argument (',' args+=Argument)*)? ')'
      // NB: only the `#( … )` index form is supported. A bare `x[i]` bracket
      // index would be indistinguishable from a feature-value multiplicity
      // (`= 1500 [kg]`), so it is deliberately omitted (matching the standard's
      // note that the `[` operator has no default library definition).
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
    | 'end' | 'frame' | 'member' | 'event' | 'snapshot' | 'individual';

// Reserved words that may also appear as feature names in a reference. Only
// noun/modifier keywords are included; structural/operator words (`to`, `then`,
// `if`, `of`, `in`, `and`, …) are excluded so reference boundaries stay clear.
// The set is kept to those the standard library actually uses as feature names:
// QualifiedName is referenced from ~30 grammar decision points, so each extra
// keyword-token widens the parser's lookahead sets and superlinearly inflates
// Chevrotain's one-time parser-construction cost (a full ~70-word set pushes it
// past 20 s). This curated set keeps construction near ~3 s while preserving
// corpus coverage.
KeywordName returns string:
      'type' | 'classifier' | 'behavior' | 'interaction' | 'function' | 'predicate'
    | 'metaclass' | 'feature' | 'step' | 'multiplicity' | 'connector' | 'association' | 'member'
    | 'part' | 'item' | 'port' | 'flow' | 'action' | 'state' | 'metadata'
    | 'occurrence' | 'event' | 'snapshot' | 'individual' | 'succession' | 'transition'
    | 'accept' | 'send' | 'do' | 'entry' | 'exit' | 'end' | 'frame' | 'done';

// A DECLARATION name: an identifier, a single-quoted 'unrestricted name', or a
// small set of soft reserved words the library also uses as declared names.
Name returns string:
    ID | UNRESTRICTED_NAME | SoftKeyword;

SoftKeyword returns string:
      'var' | 'multiplicity' | 'about' | 'locale' | 'filter' | 'done';

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
