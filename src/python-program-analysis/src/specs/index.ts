//@ts-nocheck
import * as builtins from "./__builtins__.json";
import * as random from "./random.json";
import * as matplotlib from "./matplotlib.json";
import * as pandas from "./pandas.json";
import * as sklearn from "./sklearn.json";
import * as numpy from "./numpy.json";

export interface FunctionSpec {
    name: string;
    updates?: (string | number)[];
    reads?: string[];
    returns?: string;
    returnsType?: PythonType;
    higherorder?: number;
}

export type FunctionDescription = string | FunctionSpec;

export function getFunctionName(fd: FunctionDescription): string {
    return typeof fd === 'string' ? fd : fd.name;
}

export function isFunctionSpec(fd: FunctionDescription): fd is FunctionSpec {
    return typeof fd !== 'string';
}

export type PythonType = ListType | ClassType;

export class ListType {
    constructor(public elementType: PythonType) { }
}

export class ClassType {
    constructor(public spec: TypeSpec<FunctionSpec>) { }
}

export interface TypeSpec<FD> {
    methods?: FD[];
}

export interface ModuleSpec<FD> extends TypeSpec<FD> {
    functions?: FD[];
    modules?: ModuleMap<FD>;
    types?: { [typeName: string]: TypeSpec<FD> };
}

export interface ModuleMap<FD> {
    [moduleName: string]: ModuleSpec<FD>;
}

export type JsonSpecs = ModuleMap<FunctionDescription>;

export const DefaultSpecs: JsonSpecs = {
    ...builtins,
    ...random,
    ...matplotlib,
    ...pandas,
    ...sklearn,
    ...numpy
};
