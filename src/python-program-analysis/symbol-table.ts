import { FunctionDescription, FunctionSpec, TypeSpec, ModuleSpec, ModuleMap, JsonSpecs } from ".";
import * as ast from './python-parser';
import { ModuleSpecWalker } from "./genspec/moduleSpecWalker";

function mapDict<U, V>(obj: { [item: string]: U }, f: (item: U) => V): { [item: string]: V } {
	const result: { [item: string]: V } = {};
	Object.keys(obj).forEach(k => result[k] = f(obj[k]));
	return result;
}


function cleanFunc(fdesc: FunctionDescription): FunctionSpec {
	if (typeof fdesc === 'string') {
		return { name: fdesc, reads: [], updates: [] };
	} else {
		if (!fdesc.reads) { fdesc.reads = []; }
		if (!fdesc.updates) { fdesc.updates = []; }
		return fdesc;
	}
}

function cleanType(tdesc: TypeSpec<FunctionDescription>): TypeSpec<FunctionSpec> {
	return {
		methods: tdesc.methods ? tdesc.methods.map(m => cleanFunc(m)) : []
	};
}

function cleanModule(mdesc: ModuleSpec<FunctionDescription>): ModuleSpec<FunctionSpec> {
	const mod: ModuleSpec<FunctionSpec> = {
		functions: mdesc.functions ? mdesc.functions.map(f => cleanFunc(f)) : [],
		types: mdesc.types ? mapDict(mdesc.types, cleanType) : {},
		modules: mdesc.modules ? mapDict(mdesc.modules, cleanModule) : {}
	};
	mod.functions.forEach(f => {
		if (f.returns) { f.returnsType = mod.types[f.returns]; }
	});
	Object.keys(mod.types).forEach(typename => {
		const ty = mod.types[typename];
		ty.methods.forEach(f => {
			if (f.returns) { f.returnsType = mod.types[f.returns]; }
		});
	});
	return mod;
}

export class SymbolTable {
	public modules: ModuleMap<FunctionSpec> = {};
	public types: { [name: string]: TypeSpec<FunctionSpec> } = {};
	public functions: { [name: string]: FunctionSpec } = {};

	constructor(private jsonSpecs: JsonSpecs) {
		// preload all the built-in functions.
		this.importModuleDefinitions('__builtins__', [{ path: '*', alias: '' }]);
	}

	public lookupFunction(name: string) {
		const spec = this.functions[name];
		if (spec) { return spec; }
		const clss = this.types[name];
		if (clss) {
			return clss.methods.find(fn => fn.name === '__init__') ||
				{ name: '__init__', updates: ['0'], returns: name, returnsType: clss };
		}
		return undefined;
	}

	public lookupNode(func: ast.SyntaxNode) {
		return func.type === ast.NAME ? this.lookupFunction(func.id) :
			func.type === ast.DOT && func.value.type === ast.NAME ? this.lookupModuleFunction(func.value.id, func.name)
				: undefined;
	}

	public lookupModuleFunction(modName: string, funcName: string) {
		const mod = this.modules[modName];
		return mod ? mod.functions.find(f => f.name === funcName) : undefined;
	}

	public importModule(modulePath: string, alias: string): ModuleSpec<FunctionSpec> {
		// import {modulePath} [ as {alias} ]
		const spec = this.lookupSpec(this.jsonSpecs, modulePath.split('.'));
		if (!spec) {
			console.warn(`*** WARNING no spec for module ${modulePath}`);
			return;
		}
		this.modules[alias || modulePath] = spec;
	}

	public importModuleDefinitions(namePath: string, imports: { path: string; alias: string }[]): ModuleSpec<FunctionSpec> {
		// from {namePath} import {imports}
		let spec = this.lookupSpec(this.jsonSpecs, namePath.split('.'));
		if (!spec) {
			console.warn(`*** WARNING no spec for module ${namePath}`);
			return;
		}
		imports.forEach(imp => {
			const funs = spec.functions ? spec.functions.map(f => cleanFunc(f)) : [];
			if (imp.path === '*') {
				funs.forEach(f => this.functions[f.name] = f);
				if (spec.modules) { Object.keys(spec.modules).forEach(fname => this.modules[fname] = spec.modules[fname]); }
				if (spec.types) { Object.keys(spec.types).forEach(fname => this.types[fname] = spec.types[fname]); }
			} else {
				const parts = imp.path.split('.');
				parts.forEach((name, i) => {
					if (i === parts.length - 1) {
						if (spec.modules[name]) {
							this.modules[imp.alias || name] = cleanModule(spec.modules[name]);
						} else if (spec.types[name]) {
							this.types[imp.alias || name] = cleanType(spec.types[name]);
						} else if (spec.functions[name]) {
							this.functions[imp.alias || name] = cleanFunc(spec.functions[name]);
						} else {
							console.warn('*** cannot find ', imp.path);
							return;
						}
					} else {
						spec = spec.modules[name];
						if (!spec) {
							console.warn('*** cannot find ', imp.path);
							return;
						}
					}
				});
			}
		});
	}

	private lookupSpec(map: JsonSpecs, parts: string[]): ModuleSpec<FunctionSpec> {
		if (!map || parts.length == 0) { return undefined; }
		const spec = map[parts[0]];
		if (!spec) { return undefined; }
		if (parts.length > 1) {
			return this.lookupSpec(spec.modules, parts.slice(1));
		} else {
			return cleanModule(spec);
		}
	}
}
