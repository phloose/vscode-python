import fs from 'fs';
import process from 'process';
import path from 'path';
import { ModuleSpec, JsonSpecs, FunctionDescription } from '../specs';
import * as py from '../python-parser';
import { ModuleSpecWalker } from './moduleSpecWalker';

if (process.argv.length < 3) {
	console.log('requires a directory');
} else {
	const spec = {};
	specModule(process.argv[2], spec);
	console.log(JSON.stringify(spec, null, 4));
}


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
	const walker = new ModuleSpecWalker();
	py.walk(ast, walker);
	return walker.spec;
}

function specModule(dirPath: string, spec: JsonSpecs) {
	// tslint:disable-next-line: non-literal-fs-path
	const contents = fs.readdirSync(dirPath)
		.filter(name => !name.startsWith('_'))
		.map(name => path.join(dirPath, name));
	const subdirs = contents.filter(p => fs.lstatSync(p).isDirectory());
	const pyfiles = contents.filter(f => path.extname(f).toLowerCase() === '.py' && !path.basename(f).startsWith('_'));
	const modDescriptions = pyfiles.map(createSpecForPythonFile);
	const modules = {};
	pyfiles.forEach(p => {
		modules[path.basename(p, '.py')] = createSpecForPythonFile(p);
	});
	subdirs.forEach(sd => {
		specModule(sd, modules);
	});
	spec[path.basename(dirPath)] = {
		modules
	};
}