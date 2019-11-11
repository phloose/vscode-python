import * as py from '../python-parser';
import { ModuleSpec, FunctionDescription } from "..";
import { TypeSpec, FunctionSpec, isFunctionSpec } from '../specs';


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
	private static handleDef(def: py.Def): FunctionDescription {
		const paramNames = def.params.map(p => p.name);
		const paramSet = new Set<string>(paramNames);
		const targets = py.walk(def)
			.filter(node => node.type === py.ASSIGN)
			.map(node => (node as py.Assignment).targets)
			.reduce((l, x) => l.concat(x), []);
		const fieldMods = targets
			.filter(node => node.type === py.DOT && node.value.type === py.NAME && paramSet.has(node.value.id))
			.map(node => ((node as py.Dot).value as py.Name).id);
		const indexMods = targets
			.filter(node => node.type === py.INDEX && node.value.type === py.NAME && paramSet.has(node.value.id))
			.map(node => ((node as py.Index).value as py.Name).id);
		const mods = fieldMods.concat(...indexMods);
		const updates = Array.from(new Set(mods)).map(name => paramNames.indexOf(name));
		return mods.length ? { name: def.name, updates } : def.name;
	}

	private static specialCaseCalls(defs: py.Def[], methods: FunctionDescription[]): FunctionDescription[] {
		// handle easy case of transitive closure
		for (const def of defs) {
			const mySpecIndex = methods.findIndex(m =>
				typeof m === 'string' && m === def.name || typeof m !== 'string' && m.name === def.name);
			if (mySpecIndex < 0) {
				console.error('could not find spec for function ', def.name);
				break;
			}
			let mySpec = methods[mySpecIndex];
			const calls = py.walk(def)
				.filter(node => node.type === py.CALL && node.func.type === py.DOT && node.func.value.type === py.NAME)
				.map(node => (node as py.Call));
			for (const call of calls) {
				const dot = call.func as py.Dot;
				const sideEffectCall = methods.find(m => isFunctionSpec(m) && m.name === dot.name) as FunctionSpec;
				const isSelfCall = def.params.length > 0 && def.params[0].name === (dot.value as py.Name).id;
				if (sideEffectCall && isSelfCall) {
					const actuals = [dot.value].concat(call.args.map(a => a.actual));
					actuals.forEach(actual => {
						if (actual.type === py.NAME) {
							const pi = def.params.findIndex(p => p.name === actual.id);
							// Does the method we're calling update the argument in this position?
							if (sideEffectCall.updates.indexOf(pi) >= 0) {
								if (typeof mySpec === 'string') {
									mySpec = methods[mySpecIndex] = { name: mySpec, updates: [] };
								}
								mySpec.updates.push(pi);
							}
						}
					});
				}
			}
		}
		return methods;
	}

	onEnterNode(node: py.SyntaxNode, ancestors: py.SyntaxNode[]) {
		switch (node.type) {
			case py.DEF:
				if (!node.name.startsWith('_') && ancestors.length === 2) { // toplevel def
					this.spec.functions.push(ModuleSpecWalker.handleDef(node));
				}
				break;
			case py.CLASS:
				if (!node.name.startsWith('_')) {
					const defs = node.code
						.filter(n => n.type === py.DEF && !n.name.startsWith('_'))
						.map(n => n as py.Def);
					let methods = defs.map(ModuleSpecWalker.handleDef);
					methods = ModuleSpecWalker.specialCaseCalls(defs, methods);
					this.spec.types[node.name] = { methods };
				}
				break;
		}
	}
}
