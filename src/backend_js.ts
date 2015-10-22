/// <reference path="visit.ts" />
/// <reference path="util.ts" />
/// <reference path="compile.ts" />
/// <reference path="backends.ts" />

// A tiny runtime provides our splicing routine.
const JS_RUNTIME = `
function assign() {
  var t = arguments[0];
  for (var i = 1; i < arguments.length; ++i)
    for (var k in arguments[i])
      t[k] = arguments[i][k];
  return t;
}
function splice(outer, id, inner) {
  return { prog: outer.prog.replace('__SPLICE_' + id + '__', inner.prog),
    persist: assign({}, outer.persist, inner.persist) };
}
function call(closure, args) {
  return closure.proc.apply(void 0, args.concat(closure.env));
}
`.trim();

function js_emit_extern(name: string, type: Type) {
  if (type instanceof FunType) {
    // The extern is a function. Wrap it in the clothing of our closure
    // format (with no environment).
    return "{ proc: " + name + ", env: [] }";
  } else {
    // An ordinary value. Just look it up by name.
    return name;
  }
}


// The core recursive compiler rules. Takes an elaborated, desugared,
// lambda-lifted AST with its corresponding def/use table. Works on a single
// Proc or Prog body at a time.
type JSCompile = (tree: SyntaxNode) => string;
function js_compile_rules(fself: JSCompile, ir: CompilerIR):
  ASTVisit<void, string>
{
  return {
    visit_literal(tree: LiteralNode, param: void): string {
      return tree.value.toString();
    },

    visit_seq(tree: SeqNode, param: void): string {
      return emit_seq(tree, ",\n", fself,
        e => e.tag !== "extern" && e.tag !== "lookup"
      );
    },

    visit_let(tree: LetNode, param: void): string {
      let jsvar = varsym(tree.id);
      return jsvar + " = " + paren(fself(tree.expr));
    },

    visit_assign(tree: LetNode, param: void): string {
      return emit_assign(ir, fself, tree);
    },

    visit_lookup(tree: LookupNode, param: void): string {
      return emit_lookup(ir, fself, js_emit_extern, tree);
    },

    visit_binary(tree: BinaryNode, param: void): string {
      let p1 = fself(tree.lhs);
      let p2 = fself(tree.rhs);
      return paren(p1) + " " + tree.op + " " + paren(p2);
    },

    visit_quote(tree: QuoteNode, param: void): string {
      // Compile each persist in this quote and pack them into a dictionary.
      let persist_pairs: string[] = [];
      for (let esc of ir.progs[tree.id].persist) {
        let esc_expr = fself(esc.body);
        persist_pairs.push(persistsym(esc.id) + ": " + paren(esc_expr));
      }
      let persists_str = "{ " + persist_pairs.join(", ") + " }";

      // Create a pre-spliced code value.
      let code_expr = "{ prog: " + progsym(tree.id) +
        ", persist: " + persists_str + " }";

      // Compile each spliced escape expression. Then, call our runtime to
      // splice it into the code value.
      for (let esc of ir.progs[tree.id].splice) {
        let esc_expr = fself(esc.body);
        code_expr = "splice(" + code_expr + ", " +
          esc.id + ", " +
          paren(esc_expr) + ")";
      }

      return code_expr;
    },

    visit_escape(tree: EscapeNode, param: void): string {
      if (tree.kind === "splice") {
        return splicesym(tree.id);
      } else if (tree.kind === "persist") {
        return persistsym(tree.id);
      } else {
        throw "error: unknown escape kind";
      }
    },

    visit_run(tree: RunNode, param: void): string {
      // Compile the expression producing the program we need to invoke.
      let progex = fself(tree.expr);

      let out = "(function () { /* run */\n";
      out += "  var code = " + progex + ";\n";
      // To fill in the persist values, we currently use JavaScript's
      // much-maligned `with` statement. It's just what we need!
      out += "  with (code.persist)\n";
      out += "  return eval(code.prog);\n";
      out += "})()";
      return out;
    },

    // A function expression produces an object containing the JavaScript
    // function for the corresponding proc and a list of environment
    // variables.
    visit_fun(tree: FunNode, param: void): string {
      let captures: string[] = [];
      for (let fv of ir.procs[tree.id].free) {
        captures.push(varsym(fv));
      }

      // Assemble the pair.
      let out = "{ proc: " + procsym(tree.id) + ", ";
      out += "env: [" + captures.join(', ') + "]}";
      return out;
    },

    // An invocation unpacks the closure environment and calls the function
    // with its normal arguments and its free variables.
    visit_call(tree: CallNode, param: void): string {
      // Compile the function and arguments.
      let func = fself(tree.fun);
      let args: string[] = [];
      for (let arg of tree.args) {
        args.push(paren(fself(arg)));
      }

      // Invoke our runtime to complete the closure call.
      return "call(" + paren(func) + ", [" + args.join(", ") + "])";
    },

    visit_extern(tree: ExternNode, param: void): string {
      let name = ir.externs[tree.id];
      let [type, _] = ir.type_table[tree.id];
      return js_emit_extern(name, type);
    },

    visit_persist(tree: PersistNode, param: void): string {
      throw "error: persist cannot appear in source";
    },
  };
}

// Tie the recursion knot.
function get_js_compile(ir: CompilerIR): JSCompile {
  let rules = js_compile_rules(f, ir);
  function f (tree: SyntaxNode): string {
    return ast_visit(rules, tree, null);
  };
  return f;
}

// Create a JavaScript function definition. `name` can be null, in which case
// this is an anonymous function expression. If `expr`, `body` is an
// expression (so we can `return` it).
function emit_js_fun(name: string, argnames: string[], localnames: string[],
    body: string, expr=true): string {
  let anon = (name === null);

  // Emit the definition.
  let out = "";
  if (anon) {
    out += "(";
  }
  out += "function ";
  if (!anon) {
    out += name;
  }
  out += "(" + argnames.join(", ") + ") {\n";
  if (localnames.length) {
    out += "  var " + localnames.join(", ") + ";\n";
  }
  if (expr) {
    out += "  return ";
  }
  out += indent(body, !expr);
  if (expr) {
    out += ";"
  }
  out += "\n}";
  if (anon) {
    out += ")";
  }
  return out;
}

// Compile a single Proc to a JavaScript function definition. If the Proc is
// main, then it is an anonymous function expression; otherwise, this produces
// an appropriately named function declaration.
function jscompile_proc(compile: JSCompile, proc: Proc): string {
  // The arguments consist of the actual parameters and the closure
  // environment (free variables).
  let argnames: string[] = [];
  for (let param of proc.params) {
    argnames.push(varsym(param));
  }
  for (let fv of proc.free) {
    argnames.push(varsym(fv));
  }

  // We also need the names of the non-parameter bound variables so we can
  // declare them.
  let localnames: string[] = [];
  for (let bv of proc.bound) {
    if (proc.params.indexOf(bv) == -1) {
      localnames.push(varsym(bv));
    }
  }

  // Check whether this is main (and hence anonymous).
  let name: string;
  if (proc.id === null) {
    name = null;
  } else {
    name = procsym(proc.id);
  }

  // Function declaration.
  return emit_js_fun(name, argnames, localnames, compile(proc.body));
}

// Turn a value into a JavaScript string literal. Mutli-line strings become
// nice, readable multi-line concatenations. (This will be obviated by ES6's
// template strings.)
function emit_js_string(value: any) {
  if (typeof(value) === "string") {
    let parts: string[] = [];
    let chunks = value.split("\n");
    for (let i = 0; i < chunks.length; ++i) {
      let chunk = chunks[i];
      if (i < chunks.length - 1) {
        chunk += "\n";
      }
      parts.push(JSON.stringify(chunk));
    }
    return parts.join(" +\n");
  } else {
    return JSON.stringify(value);
  }
}

// Emit a JavaScript variable declaration. If `verbose`, then there will be a
// newline between the name and the beginning of the initialization value.
function emit_js_var(name: string, value: any, verbose=false): string {
  let out = "var " + name + " =";
  if (verbose) {
    out += "\n";
  } else {
    out += " ";
  }
  out += emit_js_string(value) + ";";
  return out;
}

// Compile a quotation (a.k.a. Prog) to a string. This string should be
// embedded in JavaScript so it can be `eval`ed. Also compiles the Procs that
// appear inside this quotation.
function jscompile_prog(compile: JSCompile, prog: Prog, procs: Proc[]): string {
  // Compile each function defined in this quote.
  let procs_str = "";
  for (let proc of procs) {
    procs_str += jscompile_proc(compile, proc);
    procs_str += "\n";
  }

  // Get the quote's local (bound) variables.
  let localnames: string[] = [];
  for (let bv of prog.bound) {
    localnames.push(varsym(bv));
  }

  // Wrap the code in a function to avoid polluting the namespace.
  let code = compile(prog.body);
  let code_wrapped = emit_js_fun(null, [], localnames, code) + "()";

  return procs_str + code_wrapped;
}

// Like `pretty_value`, but for values in the *compiled* JavaScript world.
function pretty_js_value(v: any): string {
  if (typeof v == 'number') {
    return v.toString();
  } else if (v.proc !== undefined) {
    return "(fun)";
  } else if (v.prog !== undefined) {
    // It is a non-goal of this backend to be able to pretty-print quotations.
    // You can use the interpreter if you want that.
    return "<quote>";
  } else {
    throw "error: unknown value kind";
  }
}

// Compile the IR to a complete JavaScript program.
function jscompile(ir: CompilerIR): string {
  let _jscompile = get_js_compile(ir);

  // Compile each program to a string.
  let out = "";
  for (let prog of ir.progs) {
    if (prog !== undefined) {
      // Get the procs to compile.
      let procs: Proc[] = [];
      for (let id of ir.quoted_procs[prog.id]) {
        procs.push(ir.procs[id]);
      }

      let code = jscompile_prog(_jscompile, prog, procs);
      let prog_var = emit_js_var(progsym(prog.id), code, true);
      out += prog_var + "\n";
    }
  }

  // Compile each proc to a JS function.
  for (let id of ir.toplevel_procs) {
    out += jscompile_proc(_jscompile, ir.procs[id]);
    out += "\n";
  }

  // Emit and invoke the main (anonymous) function.
  out += jscompile_proc(_jscompile, ir.main);
  out += "()";

  return out;
}
