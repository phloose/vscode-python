// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { anything, instance, mock, resetCalls, verify, when } from 'ts-mockito';
import { Uri } from 'vscode';
import { ApplicationShell } from '../../../client/common/application/applicationShell';
import { CommandManager } from '../../../client/common/application/commandManager';
import { IApplicationShell } from '../../../client/common/application/types';
import { Commands } from '../../../client/common/constants';
import { FileSystem } from '../../../client/common/platform/fileSystem';
import { IFileSystem } from '../../../client/common/platform/types';
import { getNamesAndValues } from '../../../client/common/utils/enum';
import { ServiceContainer } from '../../../client/ioc/container';
import { CommandSource } from '../../../client/testing/common/constants';
import { TestCollectionStorageService } from '../../../client/testing/common/services/storageService';
import { ITestCollectionStorageService, TestFunction, Tests, TestsToRun } from '../../../client/testing/common/types';
import { onItemSelected, TestDisplay, Type } from '../../../client/testing/display/picker';

// tslint:disable:no-any

suite('Unit Tests - Picker (execution of commands)', () => {
    getNamesAndValues<Type>(Type).forEach(item => {
        getNamesAndValues<CommandSource>(Type).forEach(commandSource => {
            [true, false].forEach(debug => {
                test(`Invoking command for selection ${item.name} from ${commandSource.name} (${debug ? 'Debug' : 'No debug'})`, async () => {
                    const commandManager = mock(CommandManager);
                    const workspaceUri = Uri.file(__filename);

                    const testFunction = 'some test Function';
                    const selection = { type: item.value, fn: { testFunction } };
                    onItemSelected(instance(commandManager), commandSource.value, workspaceUri, selection as any, debug);

                    switch (selection.type) {
                        case Type.Null: {
                            verify(commandManager.executeCommand(anything())).never();
                            const args: any[] = [];
                            for (let i = 0; i <= 7; i += 1) {
                                args.push(anything());
                            }
                            verify(commandManager.executeCommand(anything(), ...args)).never();
                            return;
                        }
                        case Type.RunAll: {
                            verify(commandManager.executeCommand(Commands.Tests_Run, undefined, commandSource.value, workspaceUri, undefined)).once();
                            return;
                        }
                        case Type.ReDiscover: {
                            verify(commandManager.executeCommand(Commands.Tests_Discover, undefined, commandSource.value, workspaceUri)).once();
                            return;
                        }
                        case Type.ViewTestOutput: {
                            verify(commandManager.executeCommand(Commands.Tests_ViewOutput, undefined, commandSource.value)).once();
                            return;
                        }
                        case Type.RunFailed: {
                            verify(commandManager.executeCommand(Commands.Tests_Run_Failed, undefined, commandSource.value, workspaceUri)).once();
                            return;
                        }
                        case Type.SelectAndRunMethod: {
                            const cmd = debug ? Commands.Tests_Select_And_Debug_Method : Commands.Tests_Select_And_Run_Method;
                            verify(commandManager.executeCommand(cmd, undefined, commandSource.value, workspaceUri)).once();
                            return;
                        }
                        case Type.RunMethod: {
                            const testsToRun: TestsToRun = { testFunction: ['something' as any] };
                            verify(commandManager.executeCommand(Commands.Tests_Run, undefined, commandSource.value, workspaceUri, testsToRun)).never();
                            return;
                        }
                        case Type.DebugMethod: {
                            const testsToRun: TestsToRun = { testFunction: ['something' as any] };
                            verify(commandManager.executeCommand(Commands.Tests_Debug, undefined, commandSource.value, workspaceUri, testsToRun)).never();
                            return;
                        }
                        case Type.Configure: {
                            verify(commandManager.executeCommand(Commands.Tests_Configure, undefined, commandSource.value, workspaceUri)).once();
                            return;
                        }
                        default: {
                            return;
                        }
                    }
                });
            });
        });
    });
});

suite('Unit Tests - Picker (TestDisplay)', () => {

    let mockedCommandManager: CommandManager;
    let mockedServiceContainer: ServiceContainer;
    let mockedTestCollectionStorage: TestCollectionStorageService;
    let mockedAppShell: ApplicationShell;
    const wkspace = Uri.file(__dirname);

    setup(() => {
        mockedCommandManager = mock(CommandManager);
        mockedServiceContainer = mock(ServiceContainer);
        mockedTestCollectionStorage = mock(TestCollectionStorageService);
        mockedAppShell = mock(ApplicationShell);
        when(mockedServiceContainer.get<ITestCollectionStorageService>(ITestCollectionStorageService))
            .thenReturn(instance(mockedTestCollectionStorage));
        when(mockedServiceContainer.get<IApplicationShell>(IApplicationShell))
            .thenReturn(instance(mockedAppShell));
    });
    teardown(() => {
        resetCalls(mockedCommandManager);
        resetCalls(mockedServiceContainer);
        resetCalls(mockedTestCollectionStorage);
        resetCalls(mockedAppShell);
    });
    [true, false].forEach(debug => {
        test(`Show picker dropdown for test selection on code lenses of parametrized tests (Debug: ${debug}) (#8627)`, () => {
            // See #8627: Paths didn't match so TestDisplay.displayFunctionTestPickerUI did not call this.appShell.ShowQuickPick
            let fullPath: string;
            let fileName: Uri;
            if (process.platform === 'win32') {
                fullPath = 'C:\\path\\to\\testfile';
                fileName = Uri.file('c:\\path\\to\\testfile');
            } else {
                fullPath = '/path/to/test';
                fileName = Uri.file('/path/to/test');
            }
            // Normally 'tests' contains all tests of a workspace. Since we are only interested
            // in the 'fullPath' of a single test file the rest doesn't need to be set.
            const tests: Tests = {
                testFiles: [{
                    fullPath: fullPath,
                    ...anything()
                }],
                testFunctions: [],  // We don't care about the single testFunctions of the whole workspace so can be empty
                ...anything()
            };
            // testfunctions belonging to a code lens of a parametrized test function.
            const codelensTestFunctions: TestFunction[] = [{
                ...anything()
            }];
            when(mockedServiceContainer.get<IFileSystem>(IFileSystem)).thenReturn(new FileSystem());
            when(mockedTestCollectionStorage.getTests(wkspace)).thenReturn(tests);
            when(mockedAppShell.showQuickPick(anything(), anything())).thenResolve();

            const testDisplay = new TestDisplay(instance(mockedServiceContainer), instance(mockedCommandManager));
            testDisplay.displayFunctionTestPickerUI(
                CommandSource.commandPalette, wkspace, 'rootDirectory', fileName, codelensTestFunctions, debug
            );

            verify(mockedAppShell.showQuickPick(anything(), anything())).once();
        });
    });
});
