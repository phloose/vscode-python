//@ts-nocheck
import * as py from '../python-parser';
import { ModuleSpec, FunctionDescription } from "..";
import { TypeSpec, FunctionSpec, isFunctionSpec, getFunctionName } from '../specs';


export class ModuleSpecWalker {
    public spec: ModuleSpec<FunctionDescription>;

    constructor() {
        this.spec = { functions: [], types: {} };
    }

    // NOTE: This code is naive in a number of ways:
    // - Does not take aliasing into account
    // - Does not transitively consider side effects from function/method calls
    // - Does not resolve method calls
    //
    private static lookForSideEffects(def: py.Def): FunctionDescription {
        const paramNames = def.params.map(p => p.name);
        const paramSet = new Set<string>(paramNames);
        // Look for the targets of assignments in the def body.
        const targets = py.walk(def)
            .filter(node => node.type === py.ASSIGN)
            .map(node => (node as py.Assignment).targets)
            .reduce((l, x) => l.concat(x), []);
        // Find assignment targets of the form x.f = ...
        const fieldMods = targets
            .filter(node => node.type === py.DOT && node.value.type === py.NAME && paramSet.has(node.value.id))
            .map(node => ((node as py.Dot).value as py.Name).id);
        // Find assignment targets of the form x[i] = ...
        const indexMods = targets
            .filter(node => node.type === py.INDEX && node.value.type === py.NAME && paramSet.has(node.value.id))
            .map(node => ((node as py.Index).value as py.Name).id);
        const modifiedNames = fieldMods.concat(...indexMods);
        // For those updated names that are also parameter names, get the indices into the parameter array
        const updates = Array.from(new Set(modifiedNames)).map(name => paramNames.indexOf(name));
        return modifiedNames.length ? { name: def.name, updates } : def.name;
    }

    onEnterNode(node: py.SyntaxNode, ancestors: py.SyntaxNode[]) {
        switch (node.type) {
            case py.DEF:
                if (ancestors.length === 2) { // top-level def
                    this.spec.functions.push(ModuleSpecWalker.lookForSideEffects(node));
                }
                break;
            case py.CLASS:
                const methodDefs = node.code
                    .filter(n => n.type === py.DEF)
                    .map(n => n as py.Def);
                const methodSpecs = methodDefs.map(ModuleSpecWalker.lookForSideEffects);
                const init = methodSpecs.findIndex(m => getFunctionName(m) === '__init__');
                if (init >= 0) {
                    const spec = methodSpecs[init];
                    if (typeof spec === 'string') {
                        methodSpecs.splice(init, 0, { name: spec, updates: [], returns: node.name });
                    } else {
                        spec.returns = node.name;
                    }
                }
                this.spec.types[node.name] = { methods: methodSpecs };
                break;
        }
    }
}


export class HeuristicTransitiveClosure {

    constructor(private moduleSpec: ModuleSpec<FunctionDescription>) { }

    private transferSideEffectsAcrossCalls(def: py.Def, clss: py.Class, currentClassMethods: FunctionDescription[]): FunctionDescription[] {
        // handle easy cases of transitive closure
        const mySpecIndex = currentClassMethods.findIndex(m =>
            typeof m === 'string' && m === def.name || typeof m !== 'string' && m.name === def.name);
        if (mySpecIndex < 0) {
            console.error('could not find spec for function ', def.name);
            return currentClassMethods;
        }
        let mySpec = currentClassMethods[mySpecIndex];

        // Find calls of the form x.m(...)
        const calls = py.walk(def)
            .filter(node => node.type === py.CALL && node.func.type === py.DOT && node.func.value.type === py.NAME)
            .map(node => node as py.Call);

        for (const call of calls) {
            const dot = call.func as py.Dot;
            const methodSpec = currentClassMethods.find(m => isFunctionSpec(m) && m.name === dot.name) as FunctionSpec;
            const isSelfCall = def.params.length > 0 && def.params[0].name === (dot.value as py.Name).id;
            if (methodSpec && isSelfCall) {
                // The call is of the form self.m(...)
                const actuals = [dot.value].concat(call.args.map(a => a.actual));
                currentClassMethods[mySpecIndex] = this.recordSideEffects(actuals, def, methodSpec, mySpec);
            } else {
                const className = (dot.value as py.Name).id;
                const classSpec = this.moduleSpec.types[className];
                if (classSpec) {
                    const methSpec = classSpec.methods.find(m => isFunctionSpec(m) && m.name === dot.name) as FunctionSpec;
                    if (methSpec) {
                        // The call is of the form C.m(...) for some class C
                        const actuals = call.args.map(a => a.actual);
                        currentClassMethods[mySpecIndex] = this.recordSideEffects(actuals, def, methSpec, mySpec);
                    }
                }
            }
        }

        // Find calls of the form super().m(...)
        const superCalls = py.walk(def)
            .filter(node =>
                node.type == py.CALL && node.func.type === py.DOT &&
                node.func.value.type == py.CALL && node.func.value.func.type == py.NAME && node.func.value.func.id == 'super')
            .map(node => node as py.Call);
        if (clss.extends) {
            for (const call of superCalls) {
                const dot = call.func as py.Dot;
                const extendsNames = clss.extends.filter(c => c.type === py.ARG && c.actual.type === py.NAME)
                    .map(c => ((c as py.Argument).actual as py.Name).id);
                for (const className of extendsNames) {
                    const classSpec = this.moduleSpec.types[className];
                    if (classSpec) {
                        const methSpec = classSpec.methods.find(m => isFunctionSpec(m) && m.name === dot.name) as FunctionSpec;
                        if (methSpec) {
                            // The call is of the form super().m(...)
                            const selfActual: py.Name = ({ type: py.NAME, id: 'self' });
                            const actuals: py.SyntaxNode[] = [selfActual as py.SyntaxNode].concat(call.args.map(a => a.actual));
                            currentClassMethods[mySpecIndex] = this.recordSideEffects(actuals, def, methSpec, mySpec);
                        }
                    }
                }
            }
        }
    }

    private recordSideEffects(actuals: py.SyntaxNode[], calledMethod: py.Def, calledMethodSpec: FunctionSpec, mySpec: FunctionDescription) {
        actuals.forEach(actual => {
            if (actual.type === py.NAME) {
                const pi = calledMethod.params.findIndex(p => p.name === actual.id);
                // Does the method we're calling update the argument in this position?
                if (calledMethodSpec.updates.indexOf(pi) >= 0) {
                    if (typeof mySpec === 'string') {
                        // If the current spec is just a name (no side-effect), make it a full spec.
                        mySpec = { name: mySpec, updates: [] };
                    }
                    // The argument at index pi is getting passed as a side-effected parameter,
                    // so transitively mark this method parameter as side-effected.
                    if (mySpec.updates.indexOf(pi) < 0) {
                        mySpec.updates.push(pi);
                    }
                }
            }
        });
        return mySpec;
    }

    onEnterNode(node: py.SyntaxNode, ancestors: py.SyntaxNode[]) {
        switch (node.type) {
            case py.CLASS:
                const methodDefs = node.code
                    .filter(n => n.type === py.DEF)
                    .map(n => n as py.Def);
                const myMethods = this.moduleSpec.types[node.name].methods;
                for (const def of methodDefs) {
                    this.transferSideEffectsAcrossCalls(def, node, myMethods);
                }
                // Copy down any methods on super types that don't appear in this class spec.
                if (node.extends) {
                    const extendsNames = node.extends.filter(c => c.type === py.ARG && c.actual.type === py.NAME)
                        .map(c => ((c as py.Argument).actual as py.Name).id);
                    for (const className of extendsNames) {
                        const classSpec = this.moduleSpec.types[className];
                        if (classSpec && classSpec.methods) {
                            for (const methodSpec of classSpec.methods) {
                                const name = getFunctionName(methodSpec);
                                if (!name.startsWith('_') && !myMethods.some(m => getFunctionName(m) === name)) {
                                    myMethods.push(methodSpec);
                                }
                            }
                        }
                    }
                }
                break;
        }
    }
}
