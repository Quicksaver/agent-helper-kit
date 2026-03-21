import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

type WorkspaceFolderLike = {
  uri: {
    fsPath: string;
  };
};

type UriLike = {
  fragment?: string;
  fsPath: string;
  with: (parts: { fragment: string }) => UriLike;
};

function createUri(fsPath: string, fragment?: string): UriLike {
  return {
    fragment,
    fsPath,
    with: ({ fragment: nextFragment }) => createUri(fsPath, nextFragment),
  };
}

const vscodeMockState = vi.hoisted(() => ({
  pickedFolder: undefined as undefined | WorkspaceFolderLike,
  workspaceFolders: undefined as undefined | WorkspaceFolderLike[],
}));

const showWorkspaceFolderPick = vi.hoisted(() => vi.fn(async () => vscodeMockState.pickedFolder));

vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => createUri(fsPath),
    joinPath: (base: UriLike, ...paths: string[]) => createUri([ base.fsPath, ...paths ].join('/')),
  },
  window: {
    showWorkspaceFolderPick,
  },
  workspace: {
    get workspaceFolders() {
      return vscodeMockState.workspaceFolders;
    },
  },
}));

async function importUriModule(options: {
  pickedFolder?: WorkspaceFolderLike;
  workspaceFolders?: undefined | WorkspaceFolderLike[];
} = {}) {
  vi.resetModules();
  vscodeMockState.pickedFolder = options.pickedFolder;
  vscodeMockState.workspaceFolders = options.workspaceFolders;
  showWorkspaceFolderPick.mockClear();

  const uriModule = await import('../uri.js');

  return {
    ...uriModule,
    showWorkspaceFolderPick,
  };
}

afterEach(() => {
  vscodeMockState.pickedFolder = undefined;
  vscodeMockState.workspaceFolders = undefined;
  vi.resetModules();
});

describe('uri helpers', () => {
  it('returns the single workspace root and caches it', async () => {
    const workspaceFolders = [
      {
        uri: {
          fsPath: '/workspace/alpha',
        },
      },
    ];
    const {
      getWorkspaceRoot,
      showWorkspaceFolderPick: showWorkspaceFolderPickSpy,
    } = await importUriModule({ workspaceFolders });

    await expect(getWorkspaceRoot()).resolves.toBe('/workspace/alpha');

    workspaceFolders[0] = {
      uri: {
        fsPath: '/workspace/beta',
      },
    };

    await expect(getWorkspaceRoot()).resolves.toBe('/workspace/alpha');
    expect(showWorkspaceFolderPickSpy).not.toHaveBeenCalled();
  });

  it('asks the user to pick a workspace when multiple folders are open', async () => {
    const {
      getWorkspaceRoot,
      showWorkspaceFolderPick: showWorkspaceFolderPickSpy,
    } = await importUriModule({
      pickedFolder: {
        uri: {
          fsPath: '/workspace/selected',
        },
      },
      workspaceFolders: [
        {
          uri: {
            fsPath: '/workspace/first',
          },
        },
        {
          uri: {
            fsPath: '/workspace/second',
          },
        },
      ],
    });

    await expect(getWorkspaceRoot()).resolves.toBe('/workspace/selected');
    expect(showWorkspaceFolderPickSpy).toHaveBeenCalledOnce();
  });

  it('throws when no workspace is available', async () => {
    const { getWorkspaceRoot } = await importUriModule({ workspaceFolders: undefined });

    await expect(getWorkspaceRoot()).rejects.toThrow('No workspace found.');
  });

  it('builds a workspace-relative uri with an optional line fragment', async () => {
    const { toUri } = await importUriModule({
      workspaceFolders: [
        {
          uri: {
            fsPath: '/workspace/root',
          },
        },
      ],
    });

    const fileUri = await toUri('src/file.ts');
    const lineUri = await toUri('src/file.ts', 42);

    expect(fileUri.fsPath).toBe('/workspace/root/src/file.ts');
    expect(fileUri.fragment).toBeUndefined();
    expect(lineUri.fsPath).toBe('/workspace/root/src/file.ts');
    expect(lineUri.fragment).toBe('L42');
  });
});
