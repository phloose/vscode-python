// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { anything, instance, mock, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';
import { ApplicationShell } from '../../../client/common/application/applicationShell';
import { CommandManager } from '../../../client/common/application/commandManager';
import { IApplicationShell, ICommandManager } from '../../../client/common/application/types';
import { FileSystem } from '../../../client/common/platform/fileSystem';
import { IFileSystem } from '../../../client/common/platform/types';
import { ServiceContainer } from '../../../client/ioc/container';
import { IServiceContainer } from '../../../client/ioc/types';
import { CommandSource } from '../../../client/testing/common/constants';
import { TestCollectionStorageService } from '../../../client/testing/common/services/storageService';
import { ITestCollectionStorageService, TestFunction, Tests } from '../../../client/testing/common/types';
import { TestDisplay } from '../../../client/testing/display/picker';
import { ITestDisplay } from '../../../client/testing/types';
import { createEmptyResults } from '../results';

// tslint:disable:no-any

suite('Testing - TestDisplay', () => {

    const wkspace = Uri.file(__dirname);
    let mockedCommandManager: ICommandManager;
    let mockedServiceContainer: IServiceContainer;
    let mockedTestCollectionStorage: ITestCollectionStorageService;
    let mockedAppShell: IApplicationShell;
    let testDisplay: ITestDisplay;

    function fullPathInTests(collectedTests: Tests, fullpath?: string): Tests {
        collectedTests.testFiles = [{
            fullPath: fullpath ? fullpath : 'path/to/testfile',
            ...anything()
        }];
        return collectedTests;
    }

    setup(() => {
        mockedCommandManager = mock(CommandManager);
        mockedServiceContainer = mock(ServiceContainer);
        mockedTestCollectionStorage = mock(TestCollectionStorageService);
        mockedAppShell = mock(ApplicationShell);
        when(mockedServiceContainer.get<ITestCollectionStorageService>(ITestCollectionStorageService))
            .thenReturn(instance(mockedTestCollectionStorage));
        when(mockedServiceContainer.get<IApplicationShell>(IApplicationShell))
            .thenReturn(instance(mockedAppShell));

        testDisplay = new TestDisplay(instance(mockedServiceContainer), instance(mockedCommandManager));
    });

    suite('displayFunctionTestPickerUI', () => {

        const tests = createEmptyResults();
        let paths: {
            [match: string]: { fullPath: string; fileName: string };
            mismatch: { fullPath: string; fileName: string };
        };

        function codeLensTestFunctions(testfunctions?: TestFunction[]): TestFunction[] {
            if (!testfunctions) {
                return [{ ...anything() }];
            }
            const functions: TestFunction[] = [];
            testfunctions.forEach(fn => functions.push(fn));
            return functions;
        }

        setup(() => {
            paths = {
                match: {
                    fullPath: 'path/to/testfile',
                    fileName: 'path/to/testfile'
                },
                mismatch: {
                    fullPath: 'path/to/testfile',
                    fileName: 'testfile/to/path'
                }
            };
            when(mockedServiceContainer.get<IFileSystem>(IFileSystem)).thenReturn(new FileSystem());
            when(mockedTestCollectionStorage.getTests(wkspace)).thenReturn(tests);
            when(mockedAppShell.showQuickPick(anything(), anything())).thenResolve();
        });

        ['match', 'mismatch'].forEach(matchType => {
            test(`#8627 codelens on parametrized tests does not open dropdown picker on windows (paths=>${matchType})`, () => {

                const { fullPath, fileName } = paths[matchType];
                fullPathInTests(tests, fullPath);

                testDisplay.displayFunctionTestPickerUI(CommandSource.commandPalette, wkspace, 'rootDirectory', Uri.parse(fileName), codeLensTestFunctions());

                if (matchType === 'match') {
                    verify(mockedAppShell.showQuickPick(anything(), anything())).once();
                } else {
                    verify(mockedAppShell.showQuickPick(anything(), anything())).never();
                }
            });
        });
    });
});
