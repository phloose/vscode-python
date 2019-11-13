//@ts-nocheck
import * as titanic from './Titanic.json';
import * as pima from './Pima_Prediction.json';

export interface Notebook {
    cells: Cell[];
}

export interface Cell {
    cell_type: 'code' | 'markdown';
    execution_count: number;
    source: string[];
}

export function cellCode(nb: Notebook): string[] {
    return nb.cells
        .filter(cell => cell.cell_type === 'code')
        .map(cell => cell.source.join(''));
}

export const titanicNotebook: Notebook = titanic;
export const pimaNotebook: Notebook = pima;
