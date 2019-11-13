//@ts-nocheck

import fs from 'fs';
import process from 'process';
import path from 'path';
import { ModuleSpec, JsonSpecs, FunctionDescription, ModuleMap, getFunctionName } from '../specs';
import * as py from '../python-parser';
import { ModuleSpecWalker, HeuristicTransitiveClosure } from './moduleSpecWalker';
import { printNode } from '..';

// USAGE: node main.js [directory] [filename]

console.error(process.argv.join(' '));
if (process.argv.length < 3) {
    console.error('requires a directory');
    process.exit();
}
const dir = process.argv[2];
// tslint:disable-next-line: non-literal-fs-path
if (!fs.existsSync(dir)) {
    console.error(`${dir} does not exist`);
    process.exit();
}
// tslint:disable-next-line: non-literal-fs-path
if (!fs.lstatSync(dir).isDirectory()) {
    console.error(`${dir} is not a directory`);
    process.exit();
}

const spec = {};
specModule(dir, spec);
const filename = process.argv.length > 3 ? process.argv[3] : path.join(path.basename(dir), '.json');
const contents = JSON.stringify(spec, null, 2);
// tslint:disable-next-line: non-literal-fs-path
fs.writeFileSync(filename, contents, { encoding: 'UTF8' });



function createSpecForPythonFile(path: string): ModuleSpec<FunctionDescription> {
    // tslint:disable-next-line: non-literal-fs-path
    const content = fs.readFileSync(path).toString();
    let ast: py.Module;
    try {
        ast = py.parse(content);
    }
    catch (e) {
        console.error(`cannot parse ${path}: ${e}`);
        return {};
    }
    const modSpecWalker = new ModuleSpecWalker();
    py.walk(ast, modSpecWalker);
    const modspec = modSpecWalker.spec;
    const closureWalker = new HeuristicTransitiveClosure(modspec);
    py.walk(ast, closureWalker);
    return modspec;
}

function handleInitFile(path: string, mySpec: ModuleSpec<FunctionDescription>, modules: ModuleMap<FunctionDescription>) {
    // tslint:disable-next-line: non-literal-fs-path
    const content = fs.readFileSync(path).toString();
    let ast: py.Module;
    try {
        ast = py.parse(content);
    }
    catch (e) {
        console.error(`cannot parse ${path}: ${e}`);
        return {};
    }
    for (const frm of ast.code.filter(n => n.type === py.FROM) as py.From[]) {
        const modname = frm.base.startsWith('.') ? frm.base.slice(1) : frm.base;
        // TODO: deal with .. paths
        const parts = modname.split('.');
        const modspec: ModuleSpec<FunctionDescription> = parts.slice(1)
            .reduce((spec, name) => spec && spec[name] ? spec[name].modules : undefined, modules[parts[0]]);
        if (modspec) {
            for (const imp of frm.imports) {
                if (modspec.modules && modspec.modules[imp.path]) {
                    mySpec.modules[imp.alias || imp.path] = modspec.modules[imp.path];
                } else if (modspec.types && modspec.types[imp.path]) {
                    mySpec.types[imp.alias || imp.path] = modspec.types[imp.path];
                } else if (modspec.functions) {
                    const func = modspec.functions.find(fd => getFunctionName(fd) === imp.path);
                    if (func) {
                        if (imp.alias) {
                            mySpec.functions.push(typeof func === 'string' ?
                                imp.alias :
                                Object.assign({}, func, { name: imp.alias }));
                        } else {
                            mySpec.functions.push(func);
                        }
                    }
                } else {
                    console.error(`*** ${path} could not find ${imp.path}: `, printNode(frm));
                }
            }
        }
    }
}

function specModule(dirPath: string, spec: JsonSpecs) {
    // tslint:disable-next-line: non-literal-fs-path
    const contents = fs.readdirSync(dirPath)
        .filter(name => !name.startsWith('_'))
        .map(name => path.join(dirPath, name));
    const modules: ModuleMap<FunctionDescription> = {};
    const subdirs = contents.filter(p =>
        // tslint:disable-next-line: non-literal-fs-path
        fs.lstatSync(p).isDirectory());
    for (const sd of subdirs) {
        specModule(sd, modules);
    }
    const pyfiles = contents.filter(f => path.extname(f).toLowerCase() === '.py' && !path.basename(f).startsWith('_'));
    for (const pyfile of pyfiles) {
        modules[path.basename(pyfile, '.py')] = createSpecForPythonFile(pyfile);
    }
    const initPath = path.join(dirPath, '__init__.py');
    const mySpec: ModuleSpec<FunctionDescription> = { modules, types: {}, functions: [] };
    // tslint:disable-next-line: non-literal-fs-path
    if (fs.existsSync(initPath)) {
        handleInitFile(initPath, mySpec, modules);
    }
    spec[path.basename(dirPath)] = mySpec;
}
