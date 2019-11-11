import fs from 'fs';
import path from 'path';
import process from 'process';
import * as py from '../python-parser';
import { FunctionDescription, getFunctionName, JsonSpecs, ModuleMap, ModuleSpec } from '../specs';
import { ModuleSpecWalker } from './moduleSpecWalker';

// tslint:disable: no-console
if (process.argv.length < 3) {
    console.log('requires a directory');
} else {
    const spec = {};
    specModule(process.argv[2], spec);
    console.log(JSON.stringify(spec, null, 2));
}

function createSpecForPythonFile(path: string): ModuleSpec<FunctionDescription> {
    // tslint:disable-next-line: non-literal-fs-path
    const content = fs.readFileSync(path).toString();
    let ast: py.IModule;
    try {
        ast = py.parse(content);
    } catch (e) {
        console.error(`cannot parse ${path}: ${e}`);
        return {};
    }
    const modSpecWalker = new ModuleSpecWalker();
    py.walk(ast, modSpecWalker);
    return modSpecWalker.spec;
}

function handleInitFile(filePath: string, mySpec: ModuleSpec<FunctionDescription>, modules: ModuleMap<FunctionDescription>) {
    // tslint:disable-next-line: non-literal-fs-path
    const content = fs.readFileSync(filePath).toString();
    let ast: py.IModule;
    try {
        ast = py.parse(content);
    } catch (e) {
        console.error(`cannot parse ${filePath}: ${e}`);
        return {};
    }
    for (const imp of ast.code.filter(n => n.type === py.IMPORT) as py.IImport[]) {
        if (imp.names) {
            // tslint:disable-next-line: no-suspicious-comment
            // TODO: handle this
        }
    }
    for (const frm of ast.code.filter(n => n.type === py.FROM) as py.IFrom[]) {
        const modname = frm.base.startsWith('.') ? frm.base.slice(1) : frm.base;
        // tslint:disable-next-line: no-suspicious-comment
        // TODO: deal with .. paths
        const modspec = modules[modname];
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
                                { ...func, name: imp.alias });
                        } else {
                            mySpec.functions.push(func);
                        }
                    }
                } else {
                    console.error(`*** could not find ${imp.path}: `, printNode(frm));
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
