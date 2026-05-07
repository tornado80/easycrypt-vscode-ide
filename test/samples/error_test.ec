(* Test file with intentional errors for VS Code testing *)

(* This lemma should parse correctly *)
lemma good_lemma : true.
proof.
  trivial.
qed.

(* This lemma has an intentional error - bad tactic name *)
lemma bad_lemma : true.
proof.
  this_is_not_a_valid_tactic.
qed.

(* Another error - undefined symbol *)
op test_op : int = undefined_symbol_here.
