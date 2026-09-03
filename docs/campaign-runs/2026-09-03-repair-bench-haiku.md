# Agent repair bench — 80 fixtures

Model: haiku · max 2 round(s) per case.

| Metric | Value |
|---|---:|
| Fixtures with errors to repair | 32 |
| Repaired to a clean check | 31 |
| Repaired on the first round | 30 |
| Never repaired | 1 |
| Repaired with a minimal edit | 31 |

| Case | Level | Errors | Rounds | Minimal |
|---|---|---:|---:|---|
| L0-bom | L0 | 0 | 0 | — | no errors to repair
| L0-comments-only | L0 | 0 | 0 | — | no errors to repair
| L0-crlf | L0 | 0 | 0 | — | no errors to repair
| L0-empty-file | L0 | 0 | 0 | — | no errors to repair
| L0-json-as-sysml | L0 | 1 | 1 | yes |
| L0-non-ascii-names | L0 | 1 | 1 | yes |
| L0-tabs | L0 | 0 | 0 | — | no errors to repair
| L0-wrong-extension | L0 | 0 | 0 | — | no errors to repair
| L1-illegal-char | L1 | 2 | 1 | yes |
| L1-unterminated-comment | L1 | 1 | 1 | yes |
| L1-unterminated-string | L1 | 1 | 1 | yes |
| L2-bad-multiplicity | L2 | 2 | 1 | yes |
| L2-bare-transition-arrow | L2 | 1 | 1 | yes |
| L2-double-operator | L2 | 0 | 0 | — | no errors to repair
| L2-empty-type | L2 | 1 | 1 | yes |
| L2-empty-unit-bracket | L2 | 1 | 1 | yes |
| L2-equals-in-constraint | L2 | 1 | 1 | yes |
| L2-extra-closing-brace | L2 | 1 | 1 | yes |
| L2-keyword-order | L2 | 1 | 1 | yes |
| L2-missing-closing-brace | L2 | 1 | 1 | yes |
| L2-missing-semicolon | L2 | 0 | 0 | — | no errors to repair
| L2-missing-semicolon-simple | L2 | 0 | 0 | — | no errors to repair
| L2-two-independent-errors | L2 | 1 | 2 | yes |
| L2-unclosed-paren | L2 | 1 | 1 | yes |
| L2-unicode-unit-symbol | L2 | 1 | 1 | yes |
| L2-unknown-keyword | L2 | 1 | — | yes |
| L2-unknown-keyword-no-def | L2 | 1 | 1 | yes |
| L2-unsupported-kerml-keyword | L2 | 1 | 1 | yes |
| L3-alias-as-type | L3 | 0 | 0 | — | no errors to repair
| L3-connect-implicit-library-base | L3 | 0 | 0 | — | no errors to repair
| L3-connect-imported-end | L3 | 0 | 0 | — | no errors to repair
| L3-connect-inherited-end | L3 | 0 | 0 | — | no errors to repair
| L3-dependency-end-missing | L3 | 0 | 0 | — | no errors to repair
| L3-forward-reference-in-package | L3 | 0 | 0 | — | no errors to repair
| L3-forward-specialization-strict | L3 | 0 | 0 | — | no errors to repair
| L3-inherited-shadows-outer-backward | L3 | 0 | 0 | — | no errors to repair
| L3-inherited-shadows-outer-forward | L3 | 0 | 0 | — | no errors to repair
| L3-library-import-from-text | L3 | 0 | 0 | — | no errors to repair
| L3-redefine-inherited | L3 | 0 | 0 | — | no errors to repair
| L3-specialize-via-import | L3 | 0 | 0 | — | no errors to repair
| L3-specialize-via-inheritance | L3 | 0 | 0 | — | no errors to repair
| L3-transitive-supertype-shadow | L3 | 0 | 0 | — | no errors to repair
| L3-type-via-import | L3 | 0 | 0 | — | no errors to repair
| L3-type-via-inheritance | L3 | 0 | 0 | — | no errors to repair
| L3-unresolved-attribute-type-is-silent | L3 | 0 | 0 | — | no errors to repair
| L3-unresolved-connection-end | L3 | 1 | 1 | yes |
| L3-unresolved-import | L3 | 0 | 0 | — | no errors to repair
| L3-unresolved-redefinition | L3 | 1 | 1 | yes |
| L3-unresolved-specialization | L3 | 1 | 1 | yes |
| L3-unresolved-transition-end | L3 | 0 | 0 | — | no errors to repair
| L3-unresolved-type | L3 | 1 | 1 | yes |
| L4-blank-name | L4 | 1 | 1 | yes |
| L4-compound-unit | L4 | 0 | 0 | — | no errors to repair
| L4-connection-direction | L4 | 0 | 0 | — | no errors to repair
| L4-connection-type | L4 | 0 | 0 | — | no errors to repair
| L4-connector-one-end | L4 | 0 | 0 | — | no errors to repair
| L4-dangling-then | L4 | 1 | 1 | yes |
| L4-derived-dimension-mismatch | L4 | 0 | 0 | — | no errors to repair
| L4-dimension-clash | L4 | 0 | 0 | — | no errors to repair
| L4-duplicate-name | L4 | 2 | 1 | yes |
| L4-information-rate | L4 | 0 | 0 | — | no errors to repair
| L4-phantom-port | L4 | 0 | 0 | — | no errors to repair
| L4-port-no-direction | L4 | 0 | 0 | — | no errors to repair
| L4-qualified-unit | L4 | 0 | 0 | — | no errors to repair
| L4-requirement-no-subject | L4 | 0 | 0 | — | no errors to repair
| L4-requirement-subject-declared | L4 | 0 | 0 | — | no errors to repair
| L4-self-typed-feature | L4 | 0 | 0 | — | no errors to repair
| L4-signed-literal | L4 | 0 | 0 | — | no errors to repair
| L4-specialization-cycle | L4 | 2 | 1 | yes |
| L4-temperature-difference | L4 | 0 | 0 | — | no errors to repair
| L4-unit-literal-in-constraint | L4 | 0 | 0 | — | no errors to repair
| L4-unknown-unit | L4 | 0 | 0 | — | no errors to repair
| L4-unknown-unit-in-constraint | L4 | 0 | 0 | — | no errors to repair
| L4-value-type-mismatch | L4 | 0 | 0 | — | no errors to repair
| L5-alias-body-after-fault | L5 | 1 | 1 | yes |
| L5-nested-error-keeps-outer | L5 | 0 | 0 | — | no errors to repair
| L5-nested-fault-rehomes-inner | L5 | 1 | 1 | yes |
| L5-note-braces-after-fault | L5 | 1 | 1 | yes |
| L5-recovery-keeps-siblings | L5 | 1 | 1 | yes |
| L5-relationship-after-fault | L5 | 1 | 1 | yes |

Repair rate: **97%**.
