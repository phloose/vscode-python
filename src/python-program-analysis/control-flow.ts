import { noop } from '../client/common/utils/misc';
import { printNode } from './printNode';
import * as ast from './python-parser';
import { Set } from './set';

// tslint:disable: max-classes-per-file

export class Block {
    constructor(
        public id: number,
        public readonly hint: string,
        public statements: ast.SyntaxNode[],
        public loopVariables: ast.SyntaxNode[] = []
    ) { }

    public toString(): string {
        const str1: string = `BLOCK ${this.id} (${this.hint})\n`;
        const str2: string = this.statements
            .map(s => s.location ? `${s.location.first_line}: ${printNode(s)}` : '')
            .join('\n');

        return `${str1}${str2}`;
    }
}

class BlockSet extends Set<Block> {
    constructor(...items: Block[]) {
        super(b => b.id.toString(), ...items);
    }
}

/**
 * A block and another block that postdominates it. Distance is the length of the longest path
 * from the block to its postdominator.
 */
class Postdominator {
    public distance: number;
    public block: Block;
    public postdominator: Block;
    constructor(distance: number, block: Block, postdominator: Block) {
        this.distance = distance;
        this.block = block;
        this.postdominator = postdominator;
    }
}

/**
 * A set of postdominators
 */
class PostdominatorSet extends Set<Postdominator> {
    constructor(...items: Postdominator[]) {
        super(p => `${p.block.id},${p.postdominator.id}`, ...items);
    }
}

class Context {
    constructor(
        public loopHead: Block | null,
        public loopExit: Block | null,
        public exceptionBlock: Block | undefined | null
    ) { }

    public forLoop(loopHead: Block, loopExit: Block): Context {
        return new Context(loopHead, loopExit, this.exceptionBlock);
    }

    public forExcepts(exceptionBlock: Block | undefined | null): Context {
        return new Context(this.loopHead, this.loopExit, exceptionBlock);
    }
}

export class ControlFlowGraph {

    public get blocks(): Block[] {
        const visited: Block[] = [];
        const toVisit = new BlockSet(this.entry);
        while (toVisit.size) {
            const block = toVisit.take();
            visited.push(block);
            this.successors.items.forEach(([pred, succ]) => {
                if (pred === block && visited.indexOf(succ) < 0) {
                    toVisit.add(succ);
                }
            });
        }
        return visited;
    }

    private _blocks: Block[] = [];
    private globalId = 0;
    private entry: Block;
    private successors = new Set<[Block, Block]>(
        ([b1, b2]) => `${b1.id},${b2.id}`
    );
    private loopVariables: ast.SyntaxNode[][] = [];

    private postdominators = new PostdominatorSet();
    private immediatePostdominators: PostdominatorSet | undefined;
    private reverseDominanceFrontiers: {
        [blockId: string]: BlockSet;
    } | undefined;

    constructor(node: ast.SyntaxNode) {
        if (!node) {
            throw new Error('argument undefined');
        }
        let statements: ast.SyntaxNode[] = [];
        if (node.type === ast.MODULE) {
            statements = Array.isArray(node.code) ? node.code : [node.code];
        } else if (node.type === ast.DEF) {
            statements = Array.isArray(node.code) ? node.code : [node.code];
        }
        [this.entry] = this.makeCFG(
            'entry',
            statements,
            new Context(null, null, this.makeBlock('exceptional exit'))
        );
    }

    public getSuccessors(block: Block): Block[] {
        return this.successors.items
            .filter(([p, _]) => p === block)
            .map(([_, s]) => s);
    }

    public getPredecessors(block: Block): Block[] {
        return this.successors.items
            .filter(([_, s]) => s === block)
            .map(([p, _]) => p);
    }

    public print() {
        noop();
        // console.log('CFG', 'ENTRY:', this.entry.id, 'EXIT:', this.exit.id);
        // this.blocks.forEach(block => {
        //     console.log(block.toString());
        //     if (block === this.exit) {
        //         console.log('    EXIT');
        //     } else {
        //         console.log(
        //             '    SUCC',
        //             this.getSuccessors(block)
        //                 .map(b => b.id.toString())
        //                 .join(',')
        //         );
        //     }
        // });
    }

    /**
     * Based on the algorithm in "Engineering a Compiler", 2nd ed., Cooper and Torczon:
     * - p479: computing dominance
     * - p498-500: dominator trees and frontiers
     * - p544: postdominance and reverse dominance frontier
     */
    public visitControlDependencies(visit: (controlStmt: ast.SyntaxNode, stmt: ast.SyntaxNode) => void) {
        const blocks = this.blocks;

        this.postdominators = this.findPostdominators(blocks);
        this.immediatePostdominators = this.getImmediatePostdominators(
            this.postdominators.items
        );
        this.reverseDominanceFrontiers = this.buildReverseDominanceFrontiers(
            blocks
        );

        // Mine the dependencies.
        for (const block of blocks) {
            if (this.reverseDominanceFrontiers.hasOwnProperty(block.id)) {
                const frontier = this.reverseDominanceFrontiers[block.id];
                for (const frontierBlock of frontier.items) {
                    for (const controlStmt of frontierBlock.statements) {
                        for (const stmt of block.statements) {
                            visit(controlStmt, stmt);
                        }
                    }
                }
            }
        }
    }

    private makeBlock(hint: string, statements: ast.SyntaxNode[] = []): Block {
        const b = new Block(this.globalId, hint, statements);
        this.globalId += 1;
        if (this.loopVariables.length) {
            b.loopVariables = this.loopVariables[this.loopVariables.length - 1];
        }
        this._blocks.push(b);
        return b;
    }

    private link(...blocks: Block[]): void {
        for (let i = 1; i < blocks.length; i += 1) {
            this.successors.add([blocks[i - 1], blocks[i]]);
        }
    }

    private handleIf(statement: ast.IIf, last: Block, context: Context): Block {
        const ifCondBlock = this.makeBlock('if cond', [statement.cond]);
        const [bodyEntry, bodyExit] = this.makeCFG(
            'if body',
            statement.code,
            context
        );

        this.link(last, ifCondBlock);
        this.link(ifCondBlock, bodyEntry);
        const joinBlock = this.makeBlock('conditional join');
        this.link(bodyExit, joinBlock);
        let lastCondBlock: Block = ifCondBlock;
        if (statement.elif) {
            statement.elif.forEach(elif => {
                const elifCondBlock = this.makeBlock('elif cond', [elif.cond]);
                this.link(lastCondBlock, elifCondBlock);
                const [elifEntry, elifExit] = this.makeCFG(
                    'elif body',
                    elif.code,
                    context
                );
                this.link(elifCondBlock, elifEntry);
                this.link(elifExit, joinBlock);
                lastCondBlock = elifCondBlock;
            });
        }
        if (statement.else) {
            const elseStmt = statement.else as ast.IElse;
            if (elseStmt.code && elseStmt.code.length) {
                // XXX: 'Else' isn't *really* a condition, though we're treating it like it is
                // so we can mark a dependence between the body of the else and its header.
                const elseCondBlock = this.makeBlock('else cond', [elseStmt]);
                this.link(lastCondBlock, elseCondBlock);
                const [elseEntry, elseExit] = this.makeCFG(
                    'else body',
                    elseStmt.code,
                    context
                );
                this.link(elseCondBlock, elseEntry);
                this.link(elseExit, joinBlock);
                lastCondBlock = elseCondBlock;
            }
        }
        this.link(lastCondBlock, joinBlock);
        return joinBlock;
    }

    private handleWhile(
        statement: ast.IWhile,
        last: Block,
        context: Context
    ): Block {
        const loopHeadBlock = this.makeBlock('while loop head', [statement.cond]);
        this.link(last, loopHeadBlock);
        const afterLoop = this.makeBlock('while loop join');
        this.loopVariables.push([statement.cond]);
        const [bodyEntry, bodyExit] = this.makeCFG(
            'while body',
            statement.code,
            context.forLoop(loopHeadBlock, afterLoop)
        );
        this.loopVariables.pop();
        this.link(loopHeadBlock, bodyEntry);
        this.link(bodyExit, loopHeadBlock); // back edge
        this.link(loopHeadBlock, afterLoop);
        return afterLoop;
    }

    private handleFor(statement: ast.IFor, last: Block, context: Context): Block {
        const loopHeadBlock = this.makeBlock(
            'for loop head',
            // synthesize a statement to simulate using the iterator
            [
                {
                    type: ast.ASSIGN,
                    op: undefined,
                    sources: statement.iter,
                    targets: statement.target,
                    location: statement.decl_location
                }
            ]
        );
        this.link(last, loopHeadBlock);
        const afterLoop = this.makeBlock('for loop join');
        this.loopVariables.push(statement.target);
        const [bodyEntry, bodyExit] = this.makeCFG(
            'for body',
            statement.code,
            context.forLoop(loopHeadBlock, afterLoop)
        );
        this.loopVariables.pop();
        this.link(loopHeadBlock, bodyEntry);
        this.link(bodyExit, loopHeadBlock); // back edge
        this.link(loopHeadBlock, afterLoop);
        return afterLoop;
    }

    private handleWith(
        statement: ast.IWith,
        last: Block,
        context: Context
    ): Block {
        const assignments = statement.items.map(
            ({ with: w, as: a }): ast.IAssignment => {
                return {
                    type: ast.ASSIGN,
                    targets: [a],
                    sources: [w],
                    location: w.location,
                    op: undefined
                };
            }
        );
        const resourceBlock = this.makeBlock('with', assignments);
        this.link(last, resourceBlock);
        const [bodyEntry, bodyExit] = this.makeCFG(
            'with body',
            statement.code,
            context
        );
        this.link(resourceBlock, bodyEntry);
        return bodyExit;
    }

    private handleTry(statement: ast.ITry, last: Block, context: Context): Block {
        const afterTry = this.makeBlock('try join');
        let exnContext = context;
        let handlerExits: Block[] = [];
        let handlerHead: Block | undefined;

        if (statement.excepts) {
            handlerHead = this.makeBlock('handlers');
            const handlerCfgs = statement.excepts.map(handler =>
                this.makeCFG('handler body', handler.code, context)
            );
            handlerCfgs.forEach(([exceptEntry, _]) =>
                this.link(<Block>handlerHead, exceptEntry)
            );
            exnContext = context.forExcepts(handlerHead);
            handlerExits = handlerCfgs.map(([_, exceptExit]) => exceptExit);
        }
        const [bodyEntry, bodyExit] = this.makeCFG(
            'try body',
            statement.code,
            exnContext
        );
        this.link(last, bodyEntry);
        let normalExit = bodyExit;
        if (handlerHead) {
            this.link(bodyExit, handlerHead);
        }
        if (statement.else) {
            const [elseEntry, elseExit] = this.makeCFG(
                'try else body',
                statement.else,
                context
            );
            this.link(normalExit, elseEntry);
            normalExit = elseExit;
        }
        if (statement.finally) {
            const [finallyEntry, finallyExit] = this.makeCFG(
                'finally body',
                statement.finally,
                context
            );
            this.link(normalExit, finallyEntry);
            this.link(finallyExit, afterTry);
            handlerExits.forEach(handlerExit => this.link(handlerExit, finallyEntry));
        } else {
            handlerExits.forEach(handlerExit => this.link(handlerExit, afterTry));
            this.link(normalExit, afterTry);
        }
        return afterTry;
    }

    private makeCFG(
        hint: string,
        statements: ast.SyntaxNode[],
        context: Context
    ): [Block, Block] {
        if (!hint) {
            throw new Error('hint undefined');
        }
        if (!statements) {
            throw new Error('statements undefined');
        }
        if (!context) {
            throw new Error('context undefined');
        }

        const entry = this.makeBlock(hint);
        let last = entry;
        statements.forEach(statement => {
            switch (statement.type) {
                case ast.IF:
                    last = this.handleIf(statement, last, context);
                    break;
                case ast.WHILE:
                    last = this.handleWhile(statement, last, context);
                    break;
                case ast.FOR:
                    last = this.handleFor(statement, last, context);
                    break;
                case ast.WITH:
                    last = this.handleWith(statement, last, context);
                    break;
                case ast.TRY:
                    last = this.handleTry(statement, last, context);
                    break;
                case ast.RAISE:
                    this.link(last, <Block>context.exceptionBlock);
                    return;
                case ast.BREAK:
                    this.link(last, <Block>context.loopExit);
                    return;
                case ast.CONTINUE:
                    this.link(last, <Block>context.loopHead);
                    return;
                case ast.DEF:
                case ast.CLASS:
                default:
                    last.statements.push(statement);
                    break;
            }
        });
        return [entry, last];
    }

    private postdominatorExists(block: Block, postdominator: Block) {
        return (
            this.postdominators.filter(
                p => p.block === block && p.postdominator === postdominator
            ).size > 0
        );
    }

    private getImmediatePostdominator(block: Block): Postdominator {
        let immediatePostdominators: Postdominator[] = [];
        if (this.immediatePostdominators) {
            immediatePostdominators = this.immediatePostdominators.items.filter(
                p => p.block === block
            );
        }
        return immediatePostdominators[0];
    }

    private findPostdominators(blocks: Block[]) {
        // Initially, every block has every other block as a postdominator, except for the last block.
        const postdominators: { [blockId: number]: PostdominatorSet } = {};
        for (const block of blocks) {
            postdominators[block.id] = new PostdominatorSet();
            for (const otherBlock of blocks) {
                const distance = block.id === otherBlock.id ? 0 : Infinity;
                postdominators[block.id].add(
                    new Postdominator(distance, block, otherBlock)
                );
            }
        }
        const lastBlock = blocks.filter(b => this.getSuccessors(b).length === 0)[0];
        postdominators[lastBlock.id] = new PostdominatorSet(
            new Postdominator(0, lastBlock, lastBlock)
        );

        let changed = true;
        while (changed === true) {
            changed = false;
            for (const block of blocks) {
                if (block === lastBlock) { continue; }
                const oldPostdominators = postdominators[block.id];
                const successors = this.getSuccessors(block);
                const postDominators: Postdominator[] = [];
                // Merge postdominators that appear in all of a block's successors.
                const newPostdominators = new PostdominatorSet(
                    ...postDominators
                        .concat(...successors.map(s => postdominators[s.id].items))
                        .reduce((pCounts: { p: Postdominator; count: number }[], p: Postdominator) => {
                            const countIndex = pCounts.findIndex(record => {
                                return record.p.postdominator === p.postdominator;
                            });
                            let countRecord;
                            if (countIndex === -1) {
                                countRecord = {
                                    p: new Postdominator(p.distance + 1, block, p.postdominator),
                                    count: 0
                                };
                                pCounts.push(countRecord);
                            } else {
                                countRecord = pCounts[countIndex];
                                pCounts[countIndex].p.distance = Math.min(
                                    pCounts[countIndex].p.distance,
                                    p.distance + 1
                                );
                            }
                            countRecord.count += 1;
                            return pCounts;
                        }, [])
                        .filter((p: { p: Postdominator; count: number }) => {
                            return p.count === successors.length;
                        })
                        .map((p: { p: Postdominator; count: number }) => {
                            return p.p;
                        })
                );

                // A block always postdominates itself.
                newPostdominators.add(new Postdominator(0, block, block));

                if (!oldPostdominators.equals(newPostdominators)) {
                    postdominators[block.id] = newPostdominators;
                    changed = true;
                }
            }
        }
        let result = new PostdominatorSet();
        Object.keys(postdominators).forEach(blockId => {
            // tslint:disable-next-line: no-any
            result = result.union(postdominators[<any>blockId]);
        });
        return result;
    }

    private getImmediatePostdominators(postdominators: Postdominator[]) {
        const postdominatorsByBlock: {
            [id: number]: Postdominator[];
        } = postdominators
            .filter(p => p.block !== p.postdominator)
            .reduce((dict: { [id: number]: Postdominator[] }, postdominator) => {
                if (!dict.hasOwnProperty(postdominator.block.id)) {
                    dict[postdominator.block.id] = [];
                }
                dict[postdominator.block.id].push(postdominator);
                return dict;
            }, {});
        const immediatePostdominators: Postdominator[] = [];
        Object.keys(postdominatorsByBlock).forEach(blockId => {
            immediatePostdominators.push(
                // tslint:disable-next-line: no-any
                postdominatorsByBlock[<any>blockId].sort((a, b) => {
                    return a.distance - b.distance;
                })[0]
            );
        });
        return new PostdominatorSet(...immediatePostdominators);
    }

    private buildReverseDominanceFrontiers(blocks: Block[]) {
        const frontiers: { [blockId: string]: BlockSet } = {};
        for (const block of blocks) {
            const successors = this.getSuccessors(block);
            if (successors.length > 1) {
                const workQueue = successors;
                const scheduled: Block[] = [];
                const blockImmediatePostdominator = this.getImmediatePostdominator(block);
                while (workQueue.length > 0) {
                    const item = workQueue.pop();
                    // A branch's successor might be a join point. These aren't dependencies.
                    if (item) {
                        if (this.postdominatorExists(block, item)) { continue; }
                        if (!frontiers.hasOwnProperty(item.id)) {
                            frontiers[item.id] = new BlockSet();
                        }
                        const frontier = frontiers[item.id];
                        frontier.add(block);
                        const immediatePostdominator = this.getImmediatePostdominator(item);
                        if (immediatePostdominator.postdominator !== blockImmediatePostdominator.postdominator) {
                            this.getSuccessors(item).forEach(b => {
                                if (scheduled.indexOf(b) === -1) {
                                    scheduled.push(b);
                                    workQueue.push(b);
                                }
                            });
                        }
                    }
                }
            }
        }
        return frontiers;
    }
}
