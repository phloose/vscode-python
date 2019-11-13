//@ts-nocheck
import { ExecutionLogSlicer } from '../log-slicer';
import { Location, DataflowAnalyzer } from '..';
import { expect } from 'chai';
import { TestCell } from './testcell';

function loc(line0: number, col0: number, line1 = line0 + 1, col1 = 0): Location {
    return { first_line: line0, first_column: col0, last_line: line1, last_column: col1 };
}

function makeLog(lines: string[]) {
    const cells = lines.map((text, i) => new TestCell(text, i + 1));
    const logSlicer = new ExecutionLogSlicer(new DataflowAnalyzer());
    cells.forEach(cell => logSlicer.logExecution(cell));
    return logSlicer;
}

describe('log-slicer', () => {




    describe('sliceAllExecutions', () => {
        it('does the basics', () => {
            const lines = ['x=5', 'y=6', 'print(x+y)'];
            const logSlicer = makeLog(lines);
            const lastCell = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell;
            const slices = logSlicer.sliceAllExecutions(lastCell.persistentId);
            expect(slices).to.exist;
            expect(slices.length).eq(1);
            const slice = slices[0];
            expect(slice).to.exist;
            expect(slice.cellSlices).to.exist;
            expect(slice.cellSlices.length).eq(3);
            slice.cellSlices.forEach((cs, i) => {
                expect(cs).to.exist;
                expect(cs.textSliceLines).eq(lines[i]);
                expect(cs.textSlice).eq(lines[i]);
            });
        });

        it("does jim's demo", () => {
            const lines = [
			/*[1]*/  "import pandas as pd",
			/*[2]*/  "Cars = {'Brand': ['Honda Civic','Toyota Corolla','Ford Focus','Audi A4'], 'Price': [22000,25000,27000,35000]}\n" +
                "df = pd.DataFrame(Cars,columns= ['Brand', 'Price'])",
			/*[3]*/  "def check(df, size=11):\n" +
                "    print(df)",
			/*[4]*/  "print(df)",
			/*[5]*/  "x = df['Brand'].values"
            ];
            const logSlicer = makeLog(lines);
            const lastCell = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell;
            const slice = logSlicer.sliceLatestExecution(lastCell.persistentId);
            expect(slice).to.exist;
            expect(slice.cellSlices).to.exist;
            [1, 2, 5].forEach((c, i) => expect(slice.cellSlices[i].textSlice).eq(lines[c - 1]));
            const cellCounts = slice.cellSlices.map(cell => cell.cell.executionCount);
            [3, 4].forEach(c => expect(cellCounts).to.not.include(c));
        });

        // tslint:disable-next-line: mocha-no-side-effect-code
        const pyconBoothCode = [
			/*1*/[
                'import pandas as pd',
                'import matplotlib.pyplot as plt',
            ],
			/*2*/['df = pd.read_csv("./data/pima-data.csv")'],
			/*3*/['df.head(5)'],
			/*4*/[
                'def check(df, size=11):',
                '    corr = df.corr()',
                '    fig, ax = plt.subplots(figsize=(size, size))',
                '    ax.matshow(corr)',
                '    plt.xticks(range(len(corr.columns)), corr.columns)',
                '    plt.yticks(range(len(corr.columns)), corr.columns)',
            ],
			/*5*/['check(df)'],
			/*6*/['del df[\'skin\']'],
			/*7*/['diabetes_map = {True:1, False:0}'],
			/*8*/['df[\'diabetes\'] = df[\'diabetes\'].map(diabetes_map)'],
			/*9*/['df.head(5)'],
			/*10*/[
                "from sklearn.cross_validation import train_test_split",
                "feature_col_names = ['num_preg', 'glucose_conc', 'diastolic_bp', 'thickness', 'insulin', 'bmi', 'diab_pred', 'age']",
                "predicted_class_names = ['diabetes']",
                "x = df[feature_col_names].values",
                "y = df[predicted_class_names].values",
                "split_test_size = 0.30",
                "x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=split_test_size, random_state=42)",
            ],
			/*11*/[
                'print("{0:0.2f}% in training set".format((len(x_train)/len(df.index))*100))',
                'print("{0:0.2f}% in test set".format((len(x_test)/len(df.index))*100))',
            ],
			/*12*/[
                'from sklearn.preprocessing import Imputer',
                'fill_0 = Imputer(missing_values=0, strategy="mean", axis=0)',
                'x_train = fill_0.fit_transform(x_train)',
                'x_test = fill_0.fit_transform(x_test)',
            ],
			/*13*/[
                'from sklearn.naive_bayes import GaussianNB',
                'nb_model = GaussianNB()',
                'nb_model.fit(x_train, y_train.ravel())',
            ],
			/*14*/[
                'nb_predict_train = nb_model.predict(x_train)',
                'from sklearn import metrics',
                'print("Accurary: {0:.4f}".format(metrics.accuracy_score(y_train, nb_predict_train)))',
                'print("")',
            ],
			/*15*/[
                'nb_predict_test = nb_model.predict(x_test)',
                'print("Accurary: {0:.4f}".format(metrics.accuracy_score(y_test, nb_predict_test)))',
                'print("")',
            ],
        ].map(line => line.join('\n'));

        it("does pycon to cell 6", () => {
            const logSlicer = makeLog(pyconBoothCode.slice(0, 6));
            const lastCell = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell;
            const slice = logSlicer.sliceLatestExecution(lastCell.persistentId);
            expect(slice).to.exist;
            expect(slice.cellSlices).to.exist;
            expect(slice.cellSlices.length).to.eq(3);
            const expected = [
                'import pandas as pd',
                'df = pd.read_csv("./data/pima-data.csv")',
                'del df[\'skin\']',
            ];
            [1, 2, 6].forEach((c, i) => expect(slice.cellSlices[i].textSlice).eq(expected[i]));
            const cellCounts = slice.cellSlices.map(cell => cell.cell.executionCount);
            [3, 4, 5].forEach(c => expect(cellCounts).to.not.include(c));
        });

        it("does pycon to cell 15", () => {
            const logSlicer = makeLog(pyconBoothCode);
            const lastCell = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell;
            const slice = logSlicer.sliceLatestExecution(lastCell.persistentId);
            expect(slice).to.exist;
            expect(slice.cellSlices).to.exist;
            const expected = [
				/*1*/['import pandas as pd'],
				/*2*/['df = pd.read_csv("./data/pima-data.csv")'],
				/*6*/['del df[\'skin\']'],
				/*7*/['diabetes_map = {True:1, False:0}'],
				/*8*/['df[\'diabetes\'] = df[\'diabetes\'].map(diabetes_map)'],
				/*10*/[
                    "from sklearn.cross_validation import train_test_split",
                    "feature_col_names = ['num_preg', 'glucose_conc', 'diastolic_bp', 'thickness', 'insulin', 'bmi', 'diab_pred', 'age']",
                    "predicted_class_names = ['diabetes']",
                    "x = df[feature_col_names].values",
                    "y = df[predicted_class_names].values",
                    "split_test_size = 0.30",
                    "x_train, x_test, y_train, y_test = train_test_split(x, y, test_size=split_test_size, random_state=42)",
                ],
				/*12*/[
                    'from sklearn.preprocessing import Imputer',
                    'fill_0 = Imputer(missing_values=0, strategy="mean", axis=0)',
                    'x_train = fill_0.fit_transform(x_train)',
                    'x_test = fill_0.fit_transform(x_test)',
                ],
				/*13*/[
                    'from sklearn.naive_bayes import GaussianNB',
                    'nb_model = GaussianNB()',
                    'nb_model.fit(x_train, y_train.ravel())',
                ],
				/*14*/[
                    'nb_predict_train = nb_model.predict(x_train)',
                    'from sklearn import metrics',
                ],
				/*15*/[
                    'nb_predict_test = nb_model.predict(x_test)',
                    'print("Accurary: {0:.4f}".format(metrics.accuracy_score(y_test, nb_predict_test)))',
                    'print("")',
                ],
            ].map(lines => lines.join('\n'));

            expect(slice.cellSlices.length).eq(expected.length);
            [1, 2, 6, 7, 8, 10, 12, 13, 15].forEach((c, i) => expect(slice.cellSlices[i].textSlice).eq(expected[i]));
            const cellCounts = slice.cellSlices.map(cell => cell.cell.executionCount);
            [3, 4, 5, 9, 11].forEach(c => expect(cellCounts).to.not.include(c));
        });

    });




    describe("getDependentCells", () => {

        it("handles simple in-order", () => {
            const lines = [
                "x = 3",
                "y = x+1"
            ];
            const logSlicer = makeLog(lines);
            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[0].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(1);
            expect(deps[0].text).to.equal(lines[1]);
        });

        it("handles variable redefinition", () => {
            const lines = [
                "x = 3",
                "y = x+1",
                "x = 4",
                "y = x*2",
            ];
            const logSlicer = makeLog(lines);
            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[0].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(1);
            expect(deps[0].text).to.equal(lines[1]);
            const deps2 = logSlicer.getDependentCells(logSlicer.cellExecutions[2].cell.executionEventId);
            expect(deps2).to.exist;
            expect(deps2).to.have.length(1);
            expect(deps2[0].text).to.equal(lines[3]);
        });

        it("handles no deps", () => {
            const lines = [
                "x = 3\nprint(x)",
                "y = 2\nprint(y)",
            ];
            const logSlicer = makeLog(lines);
            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[0].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(0);
        });

        it("works transitively", () => {
            const lines = [
                "x = 3",
                "y = x+1",
                "z = y-1"
            ];
            const logSlicer = makeLog(lines);
            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[0].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(2);
            const deplines = deps.map(d => d.text);
            expect(deplines).includes(lines[1]);
            expect(deplines).includes(lines[2]);
        });

        it("includes all defs within cells", () => {
            const lines = [
                "x = 3\nq = 2",
                "y = x+1",
                "z = q-1"
            ];
            const logSlicer = makeLog(lines);
            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[0].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(2);
            const deplines = deps.map(d => d.text);
            expect(deplines).includes(lines[1]);
            expect(deplines).includes(lines[2]);
        });

        it("handles cell re-execution", () => {
            const lines = [
                ["0", "x = 2\nprint(x)"],
                ["1", "y = x+1\nprint(y)"],
                ["2", "q = 2"],
                ["0", "x = 20\nprint(x)"]
            ];
            const cells = lines.map(([pid, text], i) => new TestCell(text, i + 1, undefined, pid));
            const logSlicer = new ExecutionLogSlicer(new DataflowAnalyzer());
            cells.forEach(cell => logSlicer.logExecution(cell));

            const rerunFirst = logSlicer.cellExecutions[3].cell.executionEventId;
            const deps = logSlicer.getDependentCells(rerunFirst);
            expect(deps).to.exist;
            expect(deps).to.have.length(1);
            expect(deps[0].text).equals(lines[1][1]);
        });

        it("handles cell re-execution no-op", () => {
            const lines = [
                ["0", "x = 2\nprint(x)"],
                ["1", "y = 3\nprint(y)"],
                ["2", "q = 2"],
                ["0", "x = 20\nprint(x)"],
            ];
            const cells = lines.map(([pid, text], i) => new TestCell(text, i + 1, undefined, pid));
            const logSlicer = new ExecutionLogSlicer(new DataflowAnalyzer());
            cells.forEach(cell => logSlicer.logExecution(cell));

            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[3].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(0);
        });

        it("return result in topo order", () => {
            const lines = [
                ["0", "x = 1"],
                ["0", "y = 2*x"],
                ["0", "z = x*y"],
                ["0", "x = 2"],
                ["1", "y = x*2"],
                ["2", "z = y*x"],
                ["0", "x = 3"],
            ];
            const cells = lines.map(([pid, text], i) => new TestCell(text, i + 1, undefined, pid));
            const logSlicer = new ExecutionLogSlicer(new DataflowAnalyzer());
            cells.forEach(cell => logSlicer.logExecution(cell));
            const lastEvent = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell.executionEventId;
            const deps = logSlicer.getDependentCells(lastEvent);
            expect(deps).to.exist;
            expect(deps).to.have.length(2);
            expect(deps[0].text).equals('y = x*2');
            expect(deps[1].text).equals('z = y*x');
        });

        it("can be called multiple times", () => {
            const lines = [
                ["0", "x = 1"],
                ["1", "y = 2*x"],
                ["2", "z = x*y"],
            ];
            const cells = lines.map(([pid, text], i) => new TestCell(text, i + 1, undefined, pid));
            const logSlicer = new ExecutionLogSlicer(new DataflowAnalyzer());
            cells.forEach(cell => logSlicer.logExecution(cell));
            const deps = logSlicer.getDependentCells(logSlicer.cellExecutions[0].cell.executionEventId);
            expect(deps).to.exist;
            expect(deps).to.have.length(2);
            expect(deps[0].text).equals('y = 2*x');
            expect(deps[1].text).equals('z = x*y');

            const edits = [
                ["0", "x = 2"],
                ["1", "y = x*2"],
                ["2", "z = y*x"],
                ["0", "x = 3"],
            ];
            const cellEdits = edits.map(([pid, text], i) => new TestCell(text, i + 1, undefined, pid));
            cellEdits.forEach(cell => logSlicer.logExecution(cell));
            const lastEvent = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell.executionEventId;
            const deps2 = logSlicer.getDependentCells(lastEvent);
            expect(deps2).to.exist;
            expect(deps2).to.have.length(2);
            expect(deps2[0].text).equals('y = x*2');
            expect(deps2[1].text).equals('z = y*x');
        });

        it("handles api calls", () => {
            const lines = [
                ["0", "from matplotlib.pyplot import scatter\nfrom sklearn.cluster import KMeans\nfrom sklearn import datasets"],
                ["1", "data = datasets.load_iris().data[:,2:4]\npetal_length, petal_width = data[:,1], data[:,0]"],
                ["2", "k=3"],
                ["3", "clusters = KMeans(n_clusters=k).fit(data).labels_"],
                ["4", "scatter(petal_length, petal_width, c=clusters)"],
                ["2", "k=4"],
            ];
            const cells = lines.map(([pid, text], i) => new TestCell(text, i + 1, undefined, pid));
            const logSlicer = new ExecutionLogSlicer(new DataflowAnalyzer());
            cells.forEach(cell => logSlicer.logExecution(cell));

            const lastEvent = logSlicer.cellExecutions[logSlicer.cellExecutions.length - 1].cell.executionEventId;
            const deps = logSlicer.getDependentCells(lastEvent);
            expect(deps).to.exist;
            expect(deps).to.have.length(2);
            const sliceText = deps.map(c => c.text);
            expect(sliceText).to.include(lines[3][1]);
            expect(sliceText).to.include(lines[4][1]);
        });

    });

});
