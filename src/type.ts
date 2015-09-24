/// <reference path="ast.ts" />
/// <reference path="visit.ts" />
/// <reference path="util.ts" />
/// <reference path="pretty.ts" />

// The kinds of types.
type Type = IntType | FunType | CodeType;

// There is only one Int type.
class IntType {
  // A workaround to compensate for TypeScript's structural subtyping:
  // https://github.com/Microsoft/TypeScript/issues/202
  _nominal_IntType: void;
};
const INT = new IntType();

// But function types are more complicated. Really wishing for ADTs here.
class FunType {
  constructor(public params: Type[], public ret: Type) {};
  _nominal_FunType: void;
};

// Same with code types.
class CodeType {
  constructor(public inner: Type) {};
  _nominal_CodeType: void;
};

// A single frame in a type environment holds all the bindings for one stage.
interface TypeEnvFrame {
  [key: string]: Type;
}

// An environment is a stack stack with the current stage at the front of the
// list. Prior stages are to the right. Normal accesses must refer to the top
// environment frame; subsequent ones are "auto-persists".
type TypeEnv = TypeEnvFrame[];


// The type checker.
// The checker is written as a "function generator," and we'll later take its
// fixed point to get an ordinary type checker function (of type `TypeCheck`,
// below).

type TypeCheck = (tree: SyntaxNode, env: TypeEnv)
                 => [Type, TypeEnv];
let gen_check : Gen<TypeCheck> = function(check) {
  let type_rules : ASTVisit<TypeEnv, [Type, TypeEnv]> = {
    visit_literal(tree: LiteralNode, env: TypeEnv): [Type, TypeEnv] {
      return [INT, env];
    },

    visit_seq(tree: SeqNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = check(tree.lhs, env);
      return check(tree.rhs, e);
    },

    visit_let(tree: LetNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = check(tree.expr, env);
      let head = overlay(hd(e)); // Update type in an overlay environment.
      head[tree.ident] = t;
      let e2 = cons(head, tl(e));
      return [t, e2];
    },

    visit_lookup(tree: LookupNode, env: TypeEnv): [Type, TypeEnv] {
      let t = hd(env)[tree.ident];
      if (t === undefined) {
        throw "type error: undefined variable " + tree.ident;
      }
      return [t, env];
    },

    visit_binary(tree: BinaryNode, env: TypeEnv): [Type, TypeEnv] {
      let [t1, e1] = check(tree.lhs, env);
      let [t2, e2] = check(tree.rhs, e1);
      if (t1 instanceof IntType && t2 instanceof IntType) {
        return [INT, env];
      } else {
        throw "type error: binary operation on non-numbers (" +
          pretty_type(t1) + " " + tree.op + " " + pretty_type(t2) + ")";
      }
    },

    visit_quote(tree: QuoteNode, env: TypeEnv): [Type, TypeEnv] {
      // Push an empty stack frame and check inside the quote.
      let inner_env = cons(<TypeEnvFrame> {}, env);
      let [t, e] = check(tree.expr, inner_env);

      // Move the result type "down" to a code type.
      return [new CodeType(t), env];
    },

    visit_escape(tree: EscapeNode, env: TypeEnv): [Type, TypeEnv] {
      // Escaping beyond the top level is not allowed.
      let level = env.length;
      if (level == 0) {
        throw "type error: top-level escape";
      }

      // Pop the current (quotation) environment off of the environment stack
      // before checking the escape.
      let inner_env = tl(env);
      let [t, e] = check(tree.expr, inner_env);

      if (tree.kind === "splice") {
        // The result of the escape's expression must be code, so it can be
        // spliced.
        if (t instanceof CodeType) {
          // Move the type "up" one stage.
          return [t.inner, env];
        } else {
          throw "type error: escape produced non-code value";
        }

      } else if (tree.kind === "persist") {
        // A persist escape has the same type as the outer type.
        return [t, env];

      } else {
        throw "error: unknown escape kind";
      }
    },

    visit_run(tree: RunNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = check(tree.expr, env);
      if (t instanceof CodeType) {
        return [t.inner, e];
      } else {
        throw "type error: running a non-code type " + pretty_type(t);
      }
    },

    visit_fun(tree: FunNode, env: TypeEnv): [Type, TypeEnv] {
      // Get the list of declared parameter types and accumulate them in an
      // environment based on the top of the environment stack.
      let param_types : Type[] = [];
      let body_env_hd = overlay(hd(env));
      for (let param of tree.params) {
        let ptype : Type;
        if (param.type == "Int") {
          ptype = INT;
        } else {
          throw "TODO: parameters must be Int for now";
        }
        param_types.push(ptype);
        body_env_hd[param.name] = ptype;
      }

      // Check the body and get the return type.
      let body_env = cons(body_env_hd, tl(env));
      let [ret_type, _] = check(tree.body, body_env);

      // Construct the function type.
      let fun_type = new FunType(param_types, ret_type);
      return [fun_type, env];
    },

    visit_call(tree: CallNode, env: TypeEnv): [Type, TypeEnv] {
      // Check the type of the thing we're calling. It must be a function.
      let [target_type, e] = check(tree.fun, env);
      let fun_type : FunType;
      if (target_type instanceof FunType) {
        fun_type = target_type;
      } else {
        throw "type error: call of non-function";
      }

      // Check that the arguments are the right type.
      if (tree.args.length != fun_type.params.length) {
        throw "type error: mismatched argument length";
      }
      for (let i = 0; i < tree.args.length; ++i) {
        let arg = tree.args[i];
        let param_type = fun_type.params[i];

        let arg_type : Type;
        [arg_type, e] = check(arg, e);
        if (!compatible(param_type, arg_type)) {
          throw "type error: mismatched argument type at index " + i +
            ": expected " + pretty_type(param_type) +
            ", got " + pretty_type(arg_type);
        }
      }

      // Yield the result type.
      return [fun_type.ret, e];
    },

    visit_persist(tree: PersistNode, env: TypeEnv): [Type, TypeEnv] {
      throw "error: persist cannot be type-checked in source code";
    },
  };

  // The entry point for the recursion.
  return function (tree, env) {
    return ast_visit(type_rules, tree, env);
  }
}

// Check type compatibility.
function compatible(ltype: Type, rtype: Type): boolean {
  if (ltype instanceof IntType && rtype instanceof IntType) {
    return true;
  } else {
    throw "TODO: can't yet compare non-Int types";
  }
}

// A shorthand for typechecking in an empty initial context.
let _typecheck : TypeCheck = fix(gen_check);
function typecheck(tree: SyntaxNode): Type {
  let [t, e] = _typecheck(tree, [{}]);
  return t;
}

// A container for elaborated type information.
type TypeTable = [Type, TypeEnv][];

// A functional mixin for the type checker that stores the results in a table
// on the side. The AST must be stamped with IDs.
function elaborate_mixin(type_table : TypeTable): Gen<TypeCheck> {
  return function(fsuper: TypeCheck): TypeCheck {
    return function(tree: SyntaxNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = fsuper(tree, env);
      type_table[tree.id] = [t, e];
      return [t, e];
    };
  };
}

// Deep copy an object structure and add IDs to every object.
function stamp <T> (o: T): T & { id: number } {
  let id = 0;

  function helper (o: any): any {
    if (o instanceof Array) {
      return o.slice(0);
    } else if (o instanceof Object) {
      let copy = merge(o);
      copy.id = id;
      ++id;

      for (let key in copy) {
        if (copy.hasOwnProperty(key)) {
          copy[key] = helper(copy[key]);
        }
      }

      return copy;
    } else {
      return o;
    }
  };

  return helper(o);
}

// Type elaboration. Create a copy of the AST with ID stamps and a table that
// maps the IDs to type information.
function elaborate(tree: SyntaxNode): [SyntaxNode, TypeTable] {
  let stamped_tree = stamp(tree);
  let table : TypeTable = [];
  let _elaborate : TypeCheck = fix(compose(elaborate_mixin(table), gen_check));
  _elaborate(stamped_tree, [{}]);
  return [stamped_tree, table];
}
