import { noop } from '../client/common/utils/misc';
import { Block, ControlFlowGraph } from './control-flow';
import * as ast from './python-parser';
import { Set } from './set';
import { DefaultSpecs, FunctionSpec, JsonSpecs, TypeSpec } from './specs';
import { SymbolTable } from './symbol-table';

// tslint:disable: max-classes-per-file

export interface IRef {
    type: SymbolType;
    level: ReferenceType;
    name: string;
    inferredType?: TypeSpec<FunctionSpec>;
    location?: ast.ILocation;
    node: ast.SyntaxNode;
}

export class RefSet extends Set<IRef> {
    constructor(...items: IRef[]) {
        super(r => r.name + r.level + ast.locationString(r.location), ...items);
    }
}

export enum ReferenceType {
    DEFINITION = 'DEFINITION',
    UPDATE = 'UPDATE',
    USE = 'USE'
}

export interface IDataflow {
    fromNode: ast.SyntaxNode;
    toNode: ast.SyntaxNode;
    fromRef?: IRef;
    toRef?: IRef;
}

export enum SymbolType {
    VARIABLE,
    CLASS,
    FUNCTION,
    IMPORT,
    MUTATION,
    MAGIC
}

class DefUse {
    constructor(
        public DEFINITION = new RefSet(),
        public UPDATE = new RefSet(),
        public USE = new RefSet()
    ) { }

    public get defs() { return this.DEFINITION.union(this.UPDATE); }
    public get uses() { return this.UPDATE.union(this.USE); }

    public union(that: DefUse) {
        return new DefUse(
            this.DEFINITION.union(that.DEFINITION),
            this.UPDATE.union(that.UPDATE),
            this.USE.union(that.USE));
    }

    public update(newRefs: DefUse) {

        const GEN_RULES = {
            USE: [ReferenceType.UPDATE, ReferenceType.DEFINITION],
            UPDATE: [ReferenceType.DEFINITION],
            DEFINITION: []
        };

        const KILL_RULES = {
            // Which types of references "kill" which other types of references?
            // In general, the rule of thumb here is, if x depends on y, x kills y, because anything that
            // depends on x will now depend on y transitively.
            // If x overwrites y, x also kills y.
            // The one case where a variable doesn't kill a previous variable is the global configuration, because
            // it neither depends on initializations or updates, nor clobbers them.
            DEFINITION: [ReferenceType.DEFINITION, ReferenceType.UPDATE],
            UPDATE: [ReferenceType.DEFINITION, ReferenceType.UPDATE],
            USE: []
        };

        for (const level of Object.keys(ReferenceType)) {

            let genSet = new RefSet();
            for (const genLevel of GEN_RULES[level]) {
                genSet = genSet.union(newRefs[genLevel]);
            }
            const killSet = this[<any>level].filter(def =>
                genSet.items.some(gen =>
                    gen.name === def.name && KILL_RULES[gen.level].indexOf(def.level) !== -1));

            this[level] = this[level].minus(killSet).union(genSet);
        }
    }

    public equals(that: DefUse) {
        return this.DEFINITION.equals(that.DEFINITION) &&
            this.UPDATE.equals(that.UPDATE) &&
            this.USE.equals(that.USE);
    }

    public createFlowsFrom(fromSet: DefUse): [Set<IDataflow>, Set<IRef>] {
        // tslint:disable-next-line: no-this-assignment
        const toSet = this;
        const refsDefined = new RefSet();
        const newFlows = new Set<IDataflow>(getDataflowId);
        for (const level of Object.keys(ReferenceType)) {
            for (const to of toSet[level].items) {
                for (const from of fromSet[level].items) {
                    if (from.name === to.name) {
                        refsDefined.add(to);
                        newFlows.add({ fromNode: from.node, toNode: to.node, fromRef: from, toRef: to });
                    }
                }
            }
        }
        return [newFlows, refsDefined];
    }
}

abstract class AnalysisWalker implements ast.IWalkListener {
    public readonly defs: RefSet = new RefSet();
    constructor(protected _statement: ast.SyntaxNode, protected symbolTable: SymbolTable) { }
    // tslint:disable-next-line: no-any
    public abstract onEnterNode?(node: ast.SyntaxNode, ancestors: ast.SyntaxNode[]): any;
}

class ApiCallAnalysis extends AnalysisWalker {

    constructor(statement: ast.SyntaxNode, symbolTable: SymbolTable, private variableDefs: RefSet) {
        super(statement, symbolTable);
    }

    public onEnterNode(node: ast.SyntaxNode, _ancestors: ast.SyntaxNode[]) {
        if (node.type !== ast.CALL) { return; }

        let funcSpec: FunctionSpec | undefined;
        const func = node.func;
        if (func.type === ast.DOT && func.value.type === ast.NAME) {
            // It's a method call or module call.
            const receiverName = func.value;
            const moduleSpec = this.symbolTable.modules[receiverName.id];
            if (moduleSpec && moduleSpec.functions) {
                // It's a module call.
                funcSpec = moduleSpec.functions.find(f => f.name === func.name);
            } else {
                // It's a method call.
                const ref = this.variableDefs.items.find(r => r.name === receiverName.id);
                if (ref) {
                    // The lefthand side of the dot is a variable we're tracking, so it's a method call.
                    const receiverType = ref.inferredType;
                    if (receiverType) {
                        const funcName: string = func.name;
                        if (receiverType.methods) {
                            funcSpec = receiverType.methods.find(m => m.name === funcName);
                        }
                    }
                }
            }
        } else if (func.type === ast.DOT && func.value.type === ast.LITERAL) {
            // This is an important case to handle "string".format()
            // All methods on built-in types have no side effects.
            return;
        } else if (func.type === ast.NAME) {
            // It's a function call.
            funcSpec = this.symbolTable.lookupFunction(func.id);
        }

        if (funcSpec) {
            if (funcSpec.updates && funcSpec.updates.length) {
                funcSpec.updates.forEach(paramName => {
                    const position = typeof paramName === 'string' ? parseInt(paramName, 10) : paramName;
                    // tslint:disable-next-line: no-suspicious-comment
                    if (isNaN(position)) { return; } // TODO: think about mutation of global variables
                    let actualArgName: string | undefined;
                    if (0 < position && position - 1 < node.args.length) {
                        const arg = node.args[position - 1].actual;
                        if (arg.type === ast.NAME) { actualArgName = arg.id; }
                    } else if (position === 0 && node.func.type === ast.DOT && node.func.value.type === ast.NAME) {
                        actualArgName = node.func.value.id;
                    }
                    if (actualArgName) {
                        this.defs.add({
                            type: SymbolType.MUTATION,
                            level: ReferenceType.UPDATE,
                            name: actualArgName,
                            location: node.location,
                            node: this._statement
                        });
                    }
                });
            }
            // otherwise, there are no updates, so it's a func with no side effects
        } else {
            // We couldn't find a spec, so be conservative.
            // If we don't know what the call does, we assume that it mutates its arguments.
            // tslint:disable-next-line: no-any
            node.args.forEach((arg: any) => {
                const root = findRoot(arg.actual);
                if (root) {
                    this.defs.add({
                        type: SymbolType.MUTATION,
                        level: ReferenceType.UPDATE,
                        name: root.id,
                        location: node.location,
                        node: this._statement
                    });
                }
            });
            // Also, conservatively assume that it updates the method receiver.
            if (node.func.type === ast.DOT) {
                const root = findRoot(node.func);
                if (root) {
                    this.defs.add({
                        type: SymbolType.MUTATION,
                        level: ReferenceType.UPDATE,
                        name: root.id,
                        location: node.location,
                        node: this._statement
                    });
                }
            }
        }

    }
}

/**
 * Tree walk listener for collecting manual def annotations.
 */
class DefAnnotationAnalysis extends AnalysisWalker {
    constructor(statement: ast.SyntaxNode, symbolTable: SymbolTable) {
        super(statement, symbolTable);
    }

    public onEnterNode(node: ast.SyntaxNode) {
        if (node.type === ast.LITERAL) {
            const literal = node as ast.ILiteral;

            // If this is a string, try to parse a def annotation from it
            if (typeof literal.value === 'string' || literal.value instanceof String) {
                const string = literal.value;
                const jsonMatch = string.match(/"defs: (.*)"/);
                if (jsonMatch && jsonMatch.length >= 2) {
                    const jsonString = jsonMatch[1];
                    const jsonStringUnescaped = jsonString.replace(/\\"/g, '"');
                    try {
                        const defSpecs = JSON.parse(jsonStringUnescaped);
                        for (const defSpec of defSpecs) {
                            this.defs.add({
                                type: SymbolType.MAGIC,
                                level: ReferenceType.DEFINITION,
                                name: defSpec.name,
                                location: {
                                    first_line: <number>defSpec.pos[0][0] + <number>node.location.first_line,
                                    first_column: defSpec.pos[0][1],
                                    last_line: <number>defSpec.pos[1][0] + <number>node.location.first_line,
                                    last_column: defSpec.pos[1][1]
                                },
                                node: this._statement
                            });
                        }
                    } catch (e) { noop(); }
                }
            }
        }
    }
}

/**
 * Tree walk listener for collecting definitions in the target of an assignment.
 */
class TargetsDefListener extends AnalysisWalker {
    private isAugAssign: boolean;

    constructor(assign: ast.IAssignment, symbolTable: SymbolTable) {
        super(assign, symbolTable);
        this.isAugAssign = !!assign.op;
        if (assign.targets) {
            for (const target of assign.targets) {
                ast.walk(target, this);
            }
        }
        assign.sources.forEach((source, i) => {
            if (source.type === ast.CALL) {
                const spec = symbolTable.lookupNode(source.func);
                const target = assign.targets[i];
                if (spec && target && target.type === ast.NAME) {
                    const def = this.defs.items.find(d => d.name === target.id);
                    if (def) {
                        def.inferredType = spec.returnsType;
                    }
                }
            }
        });
    }

    public onEnterNode(target: ast.SyntaxNode, ancestors: ast.SyntaxNode[]) {
        if (target.type === ast.NAME) {
            if (ancestors.length > 1) {
                const parent = ancestors[0];
                // tslint:disable-next-line: no-any
                if (parent.type === ast.INDEX && parent.args.some((a: any) => a === target)) {
                    return; // target not defined here. For example, i is not defined in A[i]
                }
            }
            const isUpdate = this.isAugAssign || ancestors.some(a => a.type === ast.DOT || a.type === ast.INDEX);
            this.defs.add({
                type: SymbolType.VARIABLE,
                level: isUpdate ? ReferenceType.UPDATE : ReferenceType.DEFINITION,
                location: target.location,
                name: target.id,
                node: this._statement
            });
        }
    }
}

/**
 * Tree walk listener for collecting names used in function call.
 */
class ParameterSideEffectAnalysis extends AnalysisWalker {
    private flows: Set<IDataflow> | undefined;
    private isMethod: boolean | undefined;
    private spec: FunctionSpec;

    constructor(private def: ast.IDef, symbolTable: SymbolTable) {
        super(def, symbolTable);
        const cfg = new ControlFlowGraph(def);
        // tslint:disable-next-line: no-use-before-declare
        const res: DataflowAnalysisResult | undefined = new DataflowAnalyzer().analyze(cfg, getParameterRefs(def));

        if (res) {
            this.flows = res.dataflows;
            this.flows = this.getTransitiveClosure(this.flows);
        }
        this.symbolTable.functions[def.name] = this.spec = { name: def.name, updates: [] };
    }

    public onEnterNode(statement: ast.SyntaxNode, _ancestors: ast.SyntaxNode[]) {
        switch (statement.type) {
            case ast.ASSIGN:
                for (const target of statement.targets) {
                    if (target.type === ast.DOT) {
                        this.checkParameterFlow(statement);
                    } else if (target.type === ast.INDEX) {
                        this.checkParameterFlow(statement);
                    }
                }
                break;
            case ast.CALL:
                const funcSpec = this.symbolTable.lookupNode(statement.func);
                // tslint:disable-next-line: no-any
                const actuals = statement.args.map((a: any) => a.actual);
                this.def.params.forEach((param, i) => {
                    // For a method, the first parameter is self, which we assign 0. The other parameters are numbered from 1.
                    // For a function def, the parameters are numbered from 1.
                    const paramNum = this.isMethod ? i : i + 1;
                    if (funcSpec) {
                        // If we have a spec, see if the parameter is passed as an actual that's side-effected.
                        if (this.flows) {
                            const paramFlows = this.flows.filter(f => f.fromNode === param && f.toNode === statement && f.toRef !== undefined);
                            if (funcSpec.updates) {
                                const updates = funcSpec.updates.filter(u => typeof u === 'number') as number[];
                                if (updates.length > 0 && !paramFlows.empty && this.spec.updates && this.spec.updates.indexOf(paramNum) < 0) {
                                    paramFlows.items.forEach(pf => {
                                        if (this.spec.updates) {
                                            if (updates.find(j => j > 0 && ast.walk(actuals[j - 1]).find(a => a.type === ast.NAME && pf.toRef && a.id === pf.toRef.name))) {
                                                this.spec.updates.push(paramNum);
                                            } else if (updates.indexOf(0) >= 0 && statement.func.type === ast.DOT && statement.func.value.type === ast.NAME && pf.toRef && statement.func.value.id === pf.toRef.name) {
                                                this.spec.updates.push(0);
                                            }
                                        }
                                    });
                                }
                            }
                        }
                    } else {
                        // No spec, be conservative and assume this parameter is side-effected.
                        if (this.spec.updates) {
                            this.spec.updates.push(paramNum);
                        }
                    }
                });
                break;
            default:
                break;
        }
    }

    private getTransitiveClosure(flows: Set<IDataflow>) {
        const nodes = flows.map(getNodeId, df => df.fromNode).union(flows.map(getNodeId, df => df.toNode));
        const result = new Set(getDataflowId, ...flows.items);
        nodes.items.forEach(from =>
            nodes.items.forEach(to =>
                nodes.items.forEach(middle => {
                    if (flows.has({ fromNode: from, toNode: middle }) &&
                        flows.has({ fromNode: middle, toNode: to })) {
                        result.add({ fromNode: from, toNode: to });
                    }
                })));
        return result;
    }

    private checkParameterFlow(sideEffect: ast.SyntaxNode) {
        this.def.params.forEach((parm, i) => {
            // For a method, the first parameter is self, which we assign 0. The other parameters are numbered from 1.
            // For a function def, the parameters are numbered from 1.
            const parmNum = this.isMethod ? i : i + 1;
            if (this.flows && this.flows.has({ fromNode: parm, toNode: sideEffect }) && this.spec.updates && this.spec.updates.indexOf(parmNum) < 0) {
                this.spec.updates.push(parmNum);
            }
        });
    }
}

/**
 * Tree walk listener for collecting definitions in the target of a del statement.
 */
class DelTargetsDefListener extends AnalysisWalker {
    constructor(del: ast.IDelete, symbolTable: SymbolTable) {
        super(del, symbolTable);
        if (del.targets) {
            for (const target of del.targets) {
                ast.walk(target, this);
            }
        }
    }

    public onEnterNode(target: ast.SyntaxNode, ancestors: ast.SyntaxNode[]) {
        if (target.type === ast.NAME) {
            if (ancestors.length > 1) {
                const parent = ancestors[0];
                // tslint:disable-next-line: no-any
                if (parent.type === ast.INDEX && parent.args.some((a: any) => a === target)) {
                    return; // target not defined here. For example, i is not defined in A[i]
                }
            }
            this.defs.add({
                type: SymbolType.VARIABLE,
                level: ReferenceType.UPDATE,
                location: target.location,
                name: target.id,
                node: this._statement
            });
        }
    }
}

/**
 * Use a shared dataflow analyzer object for all dataflow analysis / querying for defs and uses.
 * It caches defs and uses for each statement, which can save time.
 * For caching to work, statements must be annotated with a cell's ID and execution count.
 */
export class DataflowAnalyzer {

    private _symbolTable: SymbolTable;
    private _defUsesCache: { [statementLocation: string]: DefUse } = {};
    constructor(moduleMap?: JsonSpecs) {
        this._symbolTable = new SymbolTable(moduleMap || DefaultSpecs);
    }

    public getDefUseForStatement(statement: ast.SyntaxNode, defsForMethodResolution: RefSet): DefUse {
        const cacheKey = ast.locationString(statement.location);
        const cached = this._defUsesCache[cacheKey];
        if (cached) { return cached; }

        const defSet = this.getDefs(statement, defsForMethodResolution);
        const useSet = this.getUses(statement);
        const result = new DefUse(
            defSet.filter(r => r.level === ReferenceType.DEFINITION),
            defSet.filter(r => r.level === ReferenceType.UPDATE),
            useSet
        );
        this._defUsesCache[cacheKey] = result;
        return result;
    }

    public analyze(cfg: ControlFlowGraph, refSet?: RefSet): DataflowAnalysisResult | undefined {
        const workQueue: Block[] = cfg.blocks.reverse();
        let undefinedRefs = new RefSet();
        let dataflows = new Set<IDataflow>(getDataflowId);
        const defUsePerBlock = new Map(workQueue.map(block => [block.id, new DefUse()]));
        if (refSet) {
            const du: DefUse | undefined = defUsePerBlock.get(cfg.blocks[0].id);
            if (du) {
                du.update(new DefUse(refSet));
            }
        }

        while (workQueue.length) {
            const block = workQueue.pop();
            if (!block) {
                return;
            }
            const initialBlockDefUse = defUsePerBlock.get(block.id);
            const blockDefUse = cfg.getPredecessors(block)
                .reduce((defuse, predBlock) => defuse.union(defUsePerBlock.get(predBlock.id)), initialBlockDefUse);

            for (const statement of block.statements) {
                const statementDefUse = this.getDefUseForStatement(statement, blockDefUse.defs);
                const [newFlows, definedRefs] = statementDefUse.createFlowsFrom(blockDefUse);
                dataflows = dataflows.union(newFlows);
                undefinedRefs = undefinedRefs.union(statementDefUse.uses).minus(definedRefs);
                blockDefUse.update(statementDefUse);
            }

            if (!initialBlockDefUse.equals(blockDefUse)) {
                defUsePerBlock.set(block.id, blockDefUse);
                // We've updated this block's info, so schedule its successor blocks.
                for (const succ of cfg.getSuccessors(block)) {
                    if (workQueue.indexOf(succ) < 0) {
                        workQueue.push(succ);
                    }
                }
            }
        }

        cfg.visitControlDependencies((controlStmt, stmt) =>
            dataflows.add({ fromNode: controlStmt, toNode: stmt }));

        return { dataflows, undefinedRefs };
    }

    public getDefs(statement: ast.SyntaxNode, defsForMethodResolution: RefSet): RefSet {
        if (!statement) { return new RefSet(); }

        let defs = runAnalysis(ApiCallAnalysis, defsForMethodResolution, statement, this._symbolTable)
            .union(runAnalysis(DefAnnotationAnalysis, defsForMethodResolution, statement, this._symbolTable));

        switch (statement.type) {
            case ast.IMPORT:
                defs = defs.union(this.getImportDefs(statement));
                break;
            case ast.FROM:
                defs = defs.union(this.getFromImportDefs(statement));
                break;
            case ast.DEF:
                defs = defs.union(this.getFuncDefs(statement, defsForMethodResolution));
                break;
            case ast.CLASS:
                defs = defs.union(this.getClassDefs(statement));
                break;
            case ast.ASSIGN:
                defs = defs.union(this.getAssignDefs(statement));
                break;
            case ast.DEL:
                defs = defs.union(this.getDelDefs(statement));
                break;
            default:
                break;
        }
        return defs;
    }

    public getUses(statement: ast.SyntaxNode): RefSet {
        switch (statement.type) {
            case ast.ASSIGN:
                return this.getAssignUses(statement);
            case ast.DEF:
                return this.getFuncDeclUses(statement);
            case ast.CLASS:
                return this.getClassDeclUses(statement);
            default: {
                return this.getNameUses(statement);
            }
        }
    }

    private getClassDefs(classDecl: ast.IClass) {
        return new RefSet({
            type: SymbolType.CLASS,
            level: ReferenceType.DEFINITION,
            name: classDecl.name,
            location: classDecl.location,
            node: classDecl
        });
    }

    private getFuncDefs(funcDecl: ast.IDef, defsForMethodResolution: RefSet) {
        runAnalysis(ParameterSideEffectAnalysis, defsForMethodResolution, funcDecl, this._symbolTable);

        return new RefSet({
            type: SymbolType.FUNCTION,
            level: ReferenceType.DEFINITION,
            name: funcDecl.name,
            location: funcDecl.location,
            node: funcDecl
        });
    }

    private getAssignDefs(assign: ast.IAssignment) {
        const targetsDefListener = new TargetsDefListener(assign, this._symbolTable);
        return targetsDefListener.defs;
    }

    private getDelDefs(del: ast.IDelete) {
        const targetsDefListener = new DelTargetsDefListener(del, this._symbolTable);
        return targetsDefListener.defs;
    }

    private getFromImportDefs(from: ast.IFrom) {
        this._symbolTable.importModuleDefinitions(from.base, from.imports);
        return new RefSet(...from.imports.map(i => {
            return {
                type: SymbolType.IMPORT,
                level: ReferenceType.DEFINITION,
                name: i.alias || i.path,
                location: i.location,
                node: from
            };
        }));
    }

    private getImportDefs(imprt: ast.IImport) {
        return new RefSet(...imprt.names.map(nameNode => {
            return {
                type: SymbolType.IMPORT,
                level: ReferenceType.DEFINITION,
                name: nameNode.alias || nameNode.path,
                location: nameNode.location,
                node: imprt
            };
        }));
    }

    private getNameUses(statement: ast.SyntaxNode) {
        const usedNames = gatherNames(statement);
        return new RefSet(...usedNames.items.map(([name, node]) => {
            return {
                type: SymbolType.VARIABLE,
                level: ReferenceType.USE,
                name: name,
                location: node.location,
                node: statement
            };
        }));
    }

    private getClassDeclUses(classDecl: ast.IClass) {
        return classDecl.code.reduce((uses, classStatement) =>
            uses.union(this.getUses(classStatement)),
            new RefSet());
    }

    private getFuncDeclUses(def: ast.IDef) {
        const defCfg = new ControlFlowGraph(def);
        const undefinedRefs = this.analyze(defCfg, getParameterRefs(def)).undefinedRefs;
        return undefinedRefs.filter(r => r.level === ReferenceType.USE);
    }

    private getAssignUses(assign: ast.IAssignment) {
        // XXX: Is this supposed to union with funcArgs?
        const targetNames = gatherNames(assign.targets);
        const targets = new RefSet(...targetNames.items.map(([name, node]) => {
            return {
                type: SymbolType.VARIABLE,
                level: ReferenceType.USE,
                name: name,
                location: node.location,
                node: assign
            };
        }));
        const sourceNames = gatherNames(assign.sources);
        const sources = new RefSet(...sourceNames.items.map(([name, node]) => {
            return {
                type: SymbolType.VARIABLE,
                level: ReferenceType.USE,
                name: name,
                location: node.location,
                node: assign
            };
        }));
        return sources.union(assign.op ? targets : new RefSet());
    }
}

export function sameLocation(loc1: ast.Location, loc2: ast.Location): boolean {
    return (
        loc1.first_column === loc2.first_column &&
        loc1.first_line === loc2.first_line &&
        loc1.last_column === loc2.last_column &&
        loc1.last_line === loc2.last_line
    );
}

function getNameSetId([name, node]: [string, ast.SyntaxNode]) {
    //if (!node.location) { console.error('***', node); }
    return `${name}@${ast.locationString(node.location)}`;
}

class NameSet extends Set<[string, ast.SyntaxNode]> {
    constructor(...items: [string, ast.SyntaxNode][]) {
        super(getNameSetId, ...items);
    }
}

function gatherNames(node: ast.SyntaxNode | ast.SyntaxNode[]): NameSet {
    if (Array.isArray(node)) {
        return new NameSet().union(...node.map(gatherNames));
    } else {
        return new NameSet(
            ...ast
                .walk(node)
                .filter(e => e.type === ast.NAME)
                .map((e: ast.IName): [string, ast.SyntaxNode] => [e.id, e])
        );
    }
}

function runAnalysis(
    Analysis: new (statement: ast.SyntaxNode, symbolTable: SymbolTable, defsForMethodResolution: RefSet) => AnalysisWalker,
    defsForMethodResolution: RefSet,
    statement: ast.SyntaxNode,
    symbolTable: SymbolTable
) {
    const walker = new Analysis(statement, symbolTable, defsForMethodResolution);
    ast.walk(statement, walker);
    return walker.defs;
}

function findRoot(node: ast.SyntaxNode): ast.IName | undefined {
    switch (node.type) {
        case ast.NAME: return node;
        case ast.DOT: return findRoot(node.value);
        case ast.INDEX: return findRoot(node.value);
        case ast.CALL: return node.func.type === ast.DOT ? findRoot(node.func) : undefined;
        default: return undefined;
    }
}

function getParameterRefs(def: ast.IDef) {
    return new RefSet(...def.params.map(p =>
        ({ name: p.name, level: ReferenceType.DEFINITION, type: SymbolType.VARIABLE, location: p.location, node: p })));
}

function getNodeId(node: ast.SyntaxNode) {
    return `${ast.locationString(node.location)}`;
}

function getDataflowId(df: IDataflow) {
    // tslint:disable-next-line: no-console
    if (!df.fromNode.location) { console.error('*** FROM', df.fromNode, df.fromNode.location); }
    // tslint:disable-next-line: no-console
    if (!df.toNode.location) { console.error('*** TO', df.toNode, df.toNode.location); }
    return `${getNodeId(df.fromNode)}->${getNodeId(df.toNode)}`;
}

export type DataflowAnalysisResult = {
    dataflows: Set<IDataflow>;
    undefinedRefs: RefSet;
};
