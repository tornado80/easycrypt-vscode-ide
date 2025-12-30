(* ============================================================================
   EasyCrypt Syntax Highlighting Test File
   ============================================================================
   This file contains examples of all major EasyCrypt constructs to verify
   that syntax highlighting is working correctly.
   
   Use "Developer: Inspect Editor Tokens and Scopes" command in VS Code
   to verify token scopes.
   ============================================================================ *)

(* --------------------------------------------------------------------------
   1. NESTED COMMENTS TEST
   (* This is a nested comment (* deeply nested *) still in comment *)
   -------------------------------------------------------------------------- *)

(* --------------------------------------------------------------------------
   2. REQUIRE/IMPORT STATEMENTS
   -------------------------------------------------------------------------- *)
require import AllCore List.
require (*-*) DBool.
require import Distr DProd.
require Hybrid.

(* --------------------------------------------------------------------------
   3. TYPE DECLARATIONS
   -------------------------------------------------------------------------- *)
type key.
type plaintext.
type ciphertext.

type message = bool list.
type nonce = int.

(* Parameterized types *)
type 'a container.
type ('a, 'b) pair.

(* --------------------------------------------------------------------------
   4. OPERATORS AND PREDICATES
   -------------------------------------------------------------------------- *)
op n : int.            (* constant *)
op q : int.            (* another constant *)

op (^^) (a b : bool) : bool = a <> b.  (* XOR operator *)

op f : key -> plaintext -> ciphertext.
op finv : key -> ciphertext -> plaintext.

pred valid_key (k : key) = true.

(* --------------------------------------------------------------------------
   5. AXIOMS AND LEMMAS
   -------------------------------------------------------------------------- *)
axiom n_positive : 0 < n.
axiom q_positive : 0 < q.

lemma example_lemma : forall (x y : int), x + y = y + x.
proof.
  move=> x y.
  ring.
qed.

(* Using admit for incomplete proofs - should highlight as dangerous *)
lemma incomplete_lemma : forall x, x = x.
proof.
  admit.
qed.

(* --------------------------------------------------------------------------
   6. THEORIES AND CLONING
   -------------------------------------------------------------------------- *)
theory ExampleTheory.
  type t.
  op default : t.
  
  lemma trivial_lemma : default = default.
  proof. reflexivity. qed.
end ExampleTheory.

clone import ExampleTheory as ET with
  type t <- int,
  op default <- 0.

(* --------------------------------------------------------------------------
   7. MODULES AND PROCEDURES
   -------------------------------------------------------------------------- *)
module type Scheme = {
  proc keygen() : key
  proc encrypt(k : key, m : plaintext) : ciphertext
  proc decrypt(k : key, c : ciphertext) : plaintext
}.

module RealScheme : Scheme = {
  proc keygen() : key = {
    var k : key;
    k <$ dkey;
    return k;
  }
  
  proc encrypt(k : key, m : plaintext) : ciphertext = {
    var c : ciphertext;
    c <- f k m;
    return c;
  }
  
  proc decrypt(k : key, c : ciphertext) : plaintext = {
    var m : plaintext;
    m <- finv k c;
    return m;
  }
}.

(* --------------------------------------------------------------------------
   8. CONTROL FLOW
   -------------------------------------------------------------------------- *)
module ControlFlowExample = {
  proc test(x : int) : int = {
    var result : int;
    
    if (x < 0) {
      result <- -x;
    } elif (x = 0) {
      result <- 1;
    } else {
      result <- x;
    }
    
    while (result > 100) {
      result <- result / 2;
    }
    
    return result;
  }
}.

(* --------------------------------------------------------------------------
   9. PROBABILISTIC CONSTRUCTS
   -------------------------------------------------------------------------- *)
op dkey : key distr.
op dmsg : plaintext distr.

axiom dkey_ll : is_lossless dkey.
axiom dkey_uni : is_uniform dkey.
axiom dkey_full : is_full dkey.

(* --------------------------------------------------------------------------
   10. PROGRAM LOGICS (HOARE, PHOARE, EQUIV)
   -------------------------------------------------------------------------- *)
lemma hoare_example :
  hoare[ RealScheme.keygen : true ==> true ].
proof.
  proc.
  auto.
qed.

lemma phoare_example :
  phoare[ RealScheme.keygen : true ==> true ] = 1%r.
proof.
  proc.
  auto.
qed.

(* --------------------------------------------------------------------------
   11. TACTICS SHOWCASE
   -------------------------------------------------------------------------- *)
lemma tactic_showcase (a b c : int) :
  a + b + c = c + b + a.
proof.
  (* Basic rewriting and simplification *)
  simplify.
  ring.
qed.

lemma more_tactics (P Q : bool) :
  P /\ Q => Q /\ P.
proof.
  move=> [hp hq].
  split.
  - exact hq.
  - assumption.
qed.

lemma case_analysis (b : bool) :
  b \/ !b.
proof.
  case b.
  - left. trivial.
  - right. trivial.
qed.

(* --------------------------------------------------------------------------
   12. LOGICAL CONNECTIVES AND QUANTIFIERS
   -------------------------------------------------------------------------- *)
lemma logic_test :
  (forall (x : int), exists (y : int), x + y = 0) =>
  (forall (a b : bool), a /\ b <=> b /\ a).
proof.
  move=> _.
  split.
  - move=> [ha hb]. split; [exact hb | exact ha].
  - move=> [hb ha]. split; [exact ha | exact hb].
qed.

(* --------------------------------------------------------------------------
   13. LITERALS AND CONSTANTS
   -------------------------------------------------------------------------- *)
op int_literal : int = 42.
op negative_int : int = -17.
op real_literal : real = 3.14159.
op scientific : real = 1.23e-4.
op hex_literal : int = 0xFF.
op binary_literal : int = 0b1010.
op bool_true : bool = true.
op bool_false : bool = false.
op unit_val : unit = tt.
op some_value : int option = Some 42.
op none_value : int option = None.

(* --------------------------------------------------------------------------
   14. STRING LITERALS
   -------------------------------------------------------------------------- *)
op string_example : string = "Hello, EasyCrypt!".
op escaped_string : string = "Line1\nLine2\tTabbed".

(* --------------------------------------------------------------------------
   15. OPERATORS SHOWCASE
   -------------------------------------------------------------------------- *)
lemma operators_test (x y : int) (a b : bool) :
  (* Arithmetic *)
  x + y = y + x /\
  x - y = -(y - x) /\
  x * y = y * x /\
  (* Comparison *)
  (x < y) = (y > x) /\
  (x <= y) = (y >= x) /\
  (x <> y) = !(x = y) /\
  (* Logical *)
  (a /\ b) = (b /\ a) /\
  (a \/ b) = (b \/ a) /\
  (a => b) = (!a \/ b).
proof.
  admit.
qed.

(* --------------------------------------------------------------------------
   16. LIST OPERATIONS
   -------------------------------------------------------------------------- *)
op list_example : int list = [1; 2; 3; 4; 5].
op empty_list : int list = [].
op cons_example : int list = 0 :: [1; 2; 3].

(* --------------------------------------------------------------------------
   17. PRAGMAS AND DEBUG
   -------------------------------------------------------------------------- *)
pragma Goals:printall.
print RealScheme.
search (=>).

(* --------------------------------------------------------------------------
   18. SECTIONS
   -------------------------------------------------------------------------- *)
section.

declare module A : Scheme.

local lemma local_lemma : true.
proof. trivial. qed.

end section.

(* --------------------------------------------------------------------------
   19. INDUCTIVE TYPES
   -------------------------------------------------------------------------- *)
type color = [
  | Red
  | Green
  | Blue
  | RGB of int & int & int
].

op is_primary (c : color) : bool =
  with c = Red   => true
  with c = Green => true
  with c = Blue  => true
  with c = RGB _ _ _ => false.

(* --------------------------------------------------------------------------
   20. LAMBDA AND LET EXPRESSIONS
   -------------------------------------------------------------------------- *)
op double : int -> int = fun x => x * 2.

op complex_expr (x : int) : int =
  let y = x + 1 in
  let z = y * 2 in
  z - x.

(* ============================================================================
   END OF TEST FILE
   ============================================================================ *)
