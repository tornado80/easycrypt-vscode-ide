(* EasyCrypt Diagnostics Test Fixture
 * This file contains intentional errors for testing the error highlighting feature.
 * Each section demonstrates a different type of error that should be detected.
 *)

(* ============================================== *)
(* SECTION 1: Syntax/Parse Errors                 *)
(* ============================================== *)

(* Intentional parse error - invalid tactic name *)
lemma parse_error_test : true.
proof.
  this_is_not_a_tactic.
qed.

(* ============================================== *)
(* SECTION 2: Undefined Symbol Errors             *)
(* ============================================== *)

(* Intentional undefined symbol *)
op undefined_test : int = undefined_symbol_here.

(* ============================================== *)
(* SECTION 3: Type Errors                         *)
(* ============================================== *)

(* This would cause a type error if types don't match *)
op type_test : int = true.

(* ============================================== *)
(* SECTION 4: Multi-line Expressions              *)
(* ============================================== *)

(* Error spanning multiple lines *)
op multiline_error : int =
  undefined_function_call
    + another_undefined.

(* ============================================== *)
(* SECTION 5: Valid Code (for comparison)         *)
(* ============================================== *)

(* This lemma should compile without errors *)
lemma valid_lemma : true.
proof.
  trivial.
qed.

(* Valid operator definition *)
op valid_op : int = 42.
