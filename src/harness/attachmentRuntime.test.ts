import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  buildWorkspaceAttachmentContext,
  copyImagePathToMotionRefs,
  sanitizeWorkspaceAttachmentName,
} from './attachmentRuntime';

describe('workspace attachment runtime', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => Promise.resolve(command === 'path_exists' ? true : undefined));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies image and text attachments into the active project', async () => {
    const context = await buildWorkspaceAttachmentContext([
      {
        id: 'image-1',
        name: '../화면 캡처.png',
        type: 'image',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,aW1hZ2U=',
        size: 5,
      },
      {
        id: 'notes-1',
        name: 'notes.txt',
        type: 'text',
        mimeType: 'text/plain',
        dataUrl: 'hello',
        size: 5,
      },
    ], '/workspace/project/');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'create_directory', {
      path: '/workspace/project/bbarit-motion/refs',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'write_file_base64', {
      path: '/workspace/project/bbarit-motion/refs/image-1-화면 캡처.png',
      base64Data: 'aW1hZ2U=',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'path_exists', {
      path: '/workspace/project/bbarit-motion/refs/image-1-화면 캡처.png',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'write_file', {
      path: '/workspace/project/bbarit-motion/refs/notes-1-notes.txt',
      content: 'hello',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(5, 'path_exists', {
      path: '/workspace/project/bbarit-motion/refs/notes-1-notes.txt',
    });
    expect(context).toContain('bbarit-motion/refs/image-1-화면 캡처.png');
    expect(context).toContain('bbarit-motion/refs/notes-1-notes.txt');
    expect(context).not.toContain('/tmp/octo-harness-att-');
    expect(context).not.toContain('.octo-tmp');
  });

  it('does not hide workspace copy failures', async () => {
    invokeMock.mockRejectedValueOnce(new Error('disk full'));

    await expect(buildWorkspaceAttachmentContext([{
      id: 'image-1',
      name: 'image.png',
      type: 'image',
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,eA==',
      size: 1,
    }], '/workspace/project')).rejects.toThrow('disk full');
  });

  it('copies a file-picker image into the persistent Motion refs folder', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    invokeMock.mockImplementation((command: string) => {
      if (command === 'read_file_base64') return Promise.resolve('aW1hZ2U=');
      if (command === 'path_exists') return Promise.resolve(true);
      return Promise.resolve(undefined);
    });

    const path = await copyImagePathToMotionRefs('/Users/me/Pictures/person.jpg', '/workspace/project');

    expect(path).toBe('/workspace/project/bbarit-motion/refs/ya-person.jpg');
    expect(invokeMock).toHaveBeenCalledWith('write_file_base64', {
      path,
      base64Data: 'aW1hZ2U=',
    });
  });

  it('keeps a safe basename for cross-platform workspace paths', () => {
    expect(sanitizeWorkspaceAttachmentName('..\\bad:name?.png')).toBe('bad_name_.png');
  });
});
