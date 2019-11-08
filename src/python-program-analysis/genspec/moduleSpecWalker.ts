import * as py from '../python-parser';
import { ModuleSpec, FunctionDescription } from "..";


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
	private handleDef(def: py.Def): FunctionDescription {
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

	onEnterNode(node: py.SyntaxNode, ancestors: py.SyntaxNode[]) {
		switch (node.type) {
			case py.DEF:
				if (!node.name.startsWith('_')) {
					this.spec.functions.push(this.handleDef(node));
				}
				break;
			case py.CLASS:
				if (!node.name.startsWith('_')) {
					this.spec.types[node.name] = {
						methods: node.code
							.filter(n => n.type === py.DEF && !n.name.startsWith('_'))
							.map(n => this.handleDef(n as py.Def))
					};
				}
				break;
		}
	}
}