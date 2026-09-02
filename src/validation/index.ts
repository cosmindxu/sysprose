/**
 * Public surface of the validation module.
 *
 * Other modules import the model checker from here, e.g.:
 *   import { validate, RULES, type Diagnostic } from '@validation/index';
 */

export type { Diagnostic, Severity, ValidationRule } from './types';
export { SEVERITY_ORDER } from './types';
export { RULES, RULES_BY_ID, RULE_IDS } from './rules';
export { validate, isValid, type ValidateOptions } from './validate';
